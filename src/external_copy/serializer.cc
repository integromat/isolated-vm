#include "serializer.h"
#include "isolate/allocator.h"

using namespace v8;
namespace ivm {

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

	Deserialize([&](ValueDeserializer& deserializer, Local<Context> context) {
		// Transfer ArrayBuffers
		for (unsigned ii = 0; ii < array_buffers.size(); ++ii) {
			deserializer.TransferArrayBuffer(ii, array_buffers[ii]->CopyIntoCheckHeap(transfer_in).As<ArrayBuffer>());
		}

		// Deserialize object
		Unmaybe(deserializer.ReadHeader(context));
		return deserializer.ReadValue(context).ToLocal(&value);
	});

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
	Deserialize([&](ValueDeserializer& deserializer, Local<Context> context) {
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
		}
		return true;
	});
	return result;
}

} // namespace ivm
