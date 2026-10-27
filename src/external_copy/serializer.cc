#include "serializer.h"
#include "isolate/allocator.h"
#include <algorithm>
#include <cstring>
#include <unordered_map>

using namespace v8;
namespace ivm {
namespace {

/**
 * Receiver-local graph audit. No prototype edges, accessors, or JavaScript may be followed. Live
 * objects that entered the graph through transferables (e.g. `derefInto()`) are opaque leaves, so
 * only buffers created by this reconstruction are ever modified.
 */
/** Identity-keyed set of handles; never keyed by address, which a moving GC could invalidate. */
template <class Type>
class IdentityMap {
	public:
		/** Return the index of `handle`, inserting it as `size()` if absent. */
		auto Find(Local<Type> handle) -> std::pair<size_t, bool> {
			auto& bucket = buckets[handle->GetIdentityHash()];
			for (auto index : bucket) {
				if (handles[index] == handle) {
					return {index, false};
				}
			}
			bucket.emplace_back(handles.size());
			handles.emplace_back(handle);
			return {handles.size() - 1, true};
		}
		auto Contains(Local<Type> handle) const -> bool {
			auto bucket = buckets.find(handle->GetIdentityHash());
			return bucket != buckets.end() && std::any_of(bucket->second.begin(), bucket->second.end(),
				[&](size_t index) { return handles[index] == handle; });
		}
		auto Handle(size_t index) const -> Local<Type> { return handles[index]; }

	private:
		std::unordered_map<int, std::vector<size_t>> buckets;
		std::vector<Local<Type>> handles;
};

/** Prototype without invoking JavaScript (callers reject proxies first). */
auto PrototypeOf(Local<Object> object) -> Local<Value> {
#if V8_AT_LEAST(12, 5, 213)
	return object->GetPrototypeV2();
#else
	return object->GetPrototype();
#endif
}

class BufferSanitizer {
	struct BufferState {
		std::vector<std::pair<size_t, size_t>> ranges;
		bool explicit_buffer = false;
	};
	Isolate* isolate = Isolate::GetCurrent();
	Local<Context> context = isolate->GetCurrentContext();
	// Captured before traversal; deserialized plain objects always use the intrinsic prototype.
	Local<Value> object_prototype = PrototypeOf(Object::New(isolate));
	IdentityMap<Object> opaque_objects;
	IdentityMap<Object> visited;
	IdentityMap<ArrayBuffer> buffer_indexes;
	std::vector<BufferState> buffers;
	std::vector<Local<Value>> pending;
	size_t work = 0;
	// Bound native bookkeeping and traversal, including graphs with many repeated edges.
	static constexpr size_t max_work = 1 << 20;

	/** Queue an edge with a bounded amount of native bookkeeping. */
	void Push(Local<Value> value) {
		if (++work > max_work) {
			throw RuntimeRangeError("Buffer sanitization graph limit exceeded");
		}
		if (value->IsObject()) {
			pending.emplace_back(value);
		}
	}

	/** State for a buffer reached through this reconstruction's graph. */
	auto Buffer(Local<ArrayBuffer> buffer) -> BufferState& {
		auto index = buffer_indexes.Find(buffer).first;
		if (index == buffers.size()) {
			buffers.emplace_back();
		}
		return buffers[index];
	}

	/** Read only descriptor data fields; even polluted receiver prototypes cannot run here. */
	void Properties(Local<Object> object, bool skip_indices) {
		auto names = Unmaybe(object->GetPropertyNames(context, KeyCollectionMode::kOwnOnly,
			ALL_PROPERTIES, skip_indices ? IndexFilter::kSkipIndices : IndexFilter::kIncludeIndices));
		for (uint32_t ii = 0; ii < names->Length(); ++ii) {
			auto key = Unmaybe(names->Get(context, ii));
			Local<Name> name = key->IsName() ? key.As<Name>() : Unmaybe(key->ToString(context)).As<Name>();
			// V8 reconstructs Error.stack as a native accessor over serialized text, not a graph
			// edge. Do not materialize it: receiver Error.prepareStackTrace may run user code.
			if (object->IsNativeError() && name->StrictEquals(String::NewFromUtf8Literal(isolate, "stack"))) {
				continue;
			}
			auto descriptor = Unmaybe(object->GetOwnPropertyDescriptor(context, name));
			if (!descriptor->IsObject()) {
				throw RuntimeTypeError("Invalid property during buffer sanitization");
			}
			auto data = descriptor.As<Object>();
			auto value_key = String::NewFromUtf8Literal(isolate, "value");
			if (!Unmaybe(data->HasOwnProperty(context, value_key))) {
				throw RuntimeTypeError("Accessor encountered during buffer sanitization");
			}
			Push(Unmaybe(data->Get(context, value_key)));
		}
	}

public:
	explicit BufferSanitizer(const std::vector<Global<Object>>& opaque) {
		for (const auto& object : opaque) {
			opaque_objects.Find(object.Get(isolate));
		}
	}

	/** Audit all roots together, then erase only bytes not authorized by graph edges. */
	void Run(const std::vector<Local<Value>>& roots) {
		for (auto root : roots) {
			Push(root);
		}
		while (!pending.empty()) {
			if (isolate->IsExecutionTerminating()) {
				throw RuntimeError();
			}
			auto object = pending.back().As<Object>();
			pending.pop_back();
			if (opaque_objects.Contains(object)) {
				// A pre-existing receiver object; it cannot hold anything this reconstruction created.
				continue;
			}
			if (object->IsProxy()) {
				throw RuntimeTypeError("Proxy encountered during buffer sanitization");
			}
			if (!visited.Find(object).second) {
				continue;
			}

			if (object->IsArrayBuffer()) {
				Buffer(object.As<ArrayBuffer>()).explicit_buffer = true;
			} else if (object->IsArrayBufferView()) {
				auto view = object.As<ArrayBufferView>();
				auto buffer = view->Buffer();
				if (!buffer->IsSharedArrayBuffer()) {
					auto& state = Buffer(buffer);
					size_t size = buffer->ByteLength(), offset = view->ByteOffset(), length = view->ByteLength();
					// An out-of-bounds resizable-buffer view may retain an offset beyond the current
					// buffer size. It grants access to no bytes, like any empty view.
					if (length != 0) {
						if (offset > size || length > size - offset) {
							throw RuntimeRangeError("Invalid view range during buffer sanitization");
						}
						state.ranges.emplace_back(offset, offset + length);
					}
				}
				// The intrinsic backing-buffer edge is deliberately NOT traversed.
			} else if (object->IsMap() || object->IsSet()) {
				auto entries = object->IsMap() ? object.As<Map>()->AsArray() : object.As<Set>()->AsArray();
				for (uint32_t ii = 0; ii < entries->Length(); ++ii) {
					Push(Unmaybe(entries->Get(context, ii)));
				}
			} else if (!(object->IsArray() || object->IsDate() || object->IsRegExp() ||
				object->IsNativeError() || object->IsBooleanObject() || object->IsNumberObject() ||
				object->IsStringObject() || object->IsBigIntObject() || object->IsSharedArrayBuffer() ||
				object->IsWasmModuleObject() || object->IsFunction() || object->InternalFieldCount() != 0)) {
				// Ordinary structured-clone records use the intrinsic Object.prototype. Identity, not
				// constructor name, so receiver prototype pollution cannot reclassify them. Unknown
				// built-ins must not silently hide internal graph edges when Node/V8 adds cloneable types.
				if (PrototypeOf(object) != object_prototype) {
					throw RuntimeTypeError("Unsupported object during buffer sanitization");
				}
			}
			// Native host wrappers are opaque internally; their own data properties are still edges.
			Properties(object, object->IsTypedArray());
		}

		// Nothing has been published. Opaque live objects were skipped, so every buffer reached
		// here belongs to this reconstruction.
		for (size_t ii = 0; ii < buffers.size(); ++ii) {
			auto& state = buffers[ii];
			if (state.explicit_buffer) {
				continue;
			}
			auto buffer = buffer_indexes.Handle(ii);
			auto& ranges = state.ranges;
			std::sort(ranges.begin(), ranges.end());
			auto* data = static_cast<uint8_t*>(buffer->Data());
			size_t cursor = 0;
			for (auto range : ranges) {
				if (range.first > cursor) {
					std::memset(data + cursor, 0, range.first - cursor);
				}
				cursor = std::max(cursor, range.second);
			}
			if (cursor < buffer->ByteLength()) {
				std::memset(data + cursor, 0, buffer->ByteLength() - cursor);
			}
		}
	}
};

} // namespace

/** Finalize a reconstruction before returning any root to a caller. */
void detail::DeserializerDelegate::SanitizeBuffers() {
	if (HasArrayBufferViews()) {
		BufferSanitizer{opaque_objects}.Run(roots);
	}
}

/**
 * ExternalCopySerialized implementation
 */
ExternalCopySerialized::ExternalCopySerialized(Local<Value> value, ArrayRange transfer_list) :
BaseSerializer{[&](ValueSerializer& serializer, Local<Context> context) {
	TryCatch try_catch{Isolate::GetCurrent()};
	try {
		// Mark ArrayBuffers as transferred, but don't actually transfer yet otherwise it will invalidate
		// array views before they are transferred
		int ii = 0;
		for (auto handle : transfer_list) {
			if (handle->IsArrayBuffer()) {
				serializer.TransferArrayBuffer(ii++, handle.As<ArrayBuffer>());
			} else {
				throw RuntimeTypeError("Non-ArrayBuffer passed in `transferList`");
			}
		}

		// Serialize object and save
		serializer.WriteHeader();
		Unmaybe(serializer.WriteValue(context, value));
	} catch (const detail::RuntimeErrorWithMessage&) {
		// Already carries a usable message of its own.
		throw;
	} catch (const RuntimeError&) {
		// A bare `RuntimeError` means v8 has an exception on deck. Under the
		// `DisallowJavascriptExecutionScope` installed by `ExternalCopy::Copy` that exception is the
		// bare string "illegal access", so callers catch a string with no indication of what went
		// wrong. Swap it for a real Error; genuine DataCloneErrors are rethrown untouched.
		Local<Value> exception = try_catch.Exception();
		if (!exception.IsEmpty() && !exception->IsNativeError()) {
			try_catch.Reset();
			throw RuntimeTypeError(
				"Value could not be copied because reading it would run user code during transfer. "
				"Accessor properties and proxy traps are not invoked while a value is serialized.");
		}
		try_catch.ReThrow();
		throw;
	}
}} {

	// Transfer ArrayBuffers
	for (auto handle : transfer_list) {
		array_buffers.emplace_back(ExternalCopyArrayBuffer::Transfer(handle.As<ArrayBuffer>()));
	}
}

auto ExternalCopySerialized::CopyInto(bool transfer_in) -> Local<Value> {
	Local<Value> value;
	bool consume_after = false;

	Deserialize([&](ValueDeserializer& deserializer, Local<Context> context, detail::DeserializerDelegate& delegate) {
		// Transfer ArrayBuffers
		for (unsigned ii = 0; ii < array_buffers.size(); ++ii) {
			// Views need private storage for sanitization. Copy directly from external storage
			// and consume it only after sanitization succeeds, so a failed copy loses nothing.
			consume_after = transfer_in && delegate.HasArrayBufferViews();
			auto buffer = (consume_after ?
				array_buffers[ii]->CopyIntoPrivate() :
				array_buffers[ii]->CopyIntoCheckHeap(transfer_in)).As<ArrayBuffer>();
			deserializer.TransferArrayBuffer(ii, buffer);
		}

		// Deserialize object
		Unmaybe(deserializer.ReadHeader(context));
		if (!deserializer.ReadValue(context).ToLocal(&value)) {
			return false;
		}
		delegate.AddRoot(value);
		return true;
	});

	if (consume_after) {
		for (auto& array_buffer : array_buffers) {
			array_buffer->Consume();
		}
	}
	return value;
}

/**
 * SerializedVector implementation
 */
SerializedVector::SerializedVector(const v8::FunctionCallbackInfo<v8::Value>& info) :
BaseSerializer([&](ValueSerializer& serializer, Local<Context> context) {
	int length = info.Length();
	serializer.WriteUint32(length);
	for (int ii = 0; ii < length; ++ii) {
		Unmaybe(serializer.WriteValue(context, info[ii]));
	}
}) {}

auto SerializedVector::CopyIntoAsVector() -> std::vector<Local<Value>> {
	std::vector<Local<Value>> result;
	Deserialize([&](ValueDeserializer& deserializer, Local<Context> context, detail::DeserializerDelegate& delegate) {
		// Read length
		uint32_t length;
		Unmaybe(deserializer.ReadHeader(context));
		if (!deserializer.ReadUint32(&length)) {
			throw RuntimeGenericError("Invalid arguments payload");
		}

		// Read arguments
		result.resize(length);
		for (unsigned ii = 0; ii < length; ++ii) {
			if (!deserializer.ReadValue(context).ToLocal(&result[ii])) {
				return false;
			}
			delegate.AddRoot(result[ii]);
		}
		return true;
	});
	return result;
}

} // namespace ivm
