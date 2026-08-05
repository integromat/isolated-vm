#pragma once
#include <v8.h>
#include <string>
#include "error.h"

namespace ivm {

    /**
     * Collects the own, non-index property names of `object`.
     *
     * Raises rather than aborting if the lookup fails. `GetPropertyNames` does not invoke user code
     * for ordinary objects, but it can still return empty (e.g. when the isolate is terminating), in
     * which case `ToLocalChecked` would CHECK-fail and take the process down.
     */
    inline auto GetObjectOwnProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> object) -> v8::Local<v8::Array> {
        return Unmaybe(object->GetPropertyNames(context, v8::KeyCollectionMode::kOwnOnly, v8::ALL_PROPERTIES, v8::IndexFilter::kSkipIndices));
    }

    /**
     * Copies the named own properties listed in `property_names` from `source` onto `target`.
     *
     * Accessor properties are rejected instead of read. Reading one would invoke user JavaScript,
     * which is forbidden while a value is being serialized for transfer (`ExternalCopy::Copy`
     * installs a `DisallowJavascriptExecutionScope`). A getter running mid-serialization can detach
     * or resize a buffer that has already been written, so the restriction is deliberate.
     *
     * The rejection is explicit and loud on purpose. Under the disallow scope a blocked `Get`
     * returns an empty `MaybeLocal` with an opaque pending exception; skipping it would drop the
     * property from the copy with no diagnostic at all, which reads to the caller as a successful
     * transfer.
     */
    inline void CopyObjectProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> target, v8::Local<v8::Object> source, v8::Local<v8::Array> property_names) {
        v8::Isolate* isolate = context->GetIsolate();

        for (uint32_t ii = 0; ii < property_names->Length(); ++ii) {
            v8::Local<v8::Value> key = Unmaybe(property_names->Get(context, ii));

            // `GetPropertyNames` yields strings and symbols, both of which are `Name`s.
            v8::Local<v8::Name> name = key.As<v8::Name>();

            // Reject accessors up front so the error is the same whether or not a disallow scope is
            // active. `GetOwnPropertyDescriptor` does not invoke user code on a non-proxy object.
            v8::Local<v8::Value> descriptor = Unmaybe(source->GetOwnPropertyDescriptor(context, name));
            if (descriptor->IsObject()) {
                v8::Local<v8::Object> descriptor_object = descriptor.As<v8::Object>();
                bool has_getter = Unmaybe(descriptor_object->Has(context, v8::String::NewFromUtf8Literal(isolate, "get")));
                bool has_setter = Unmaybe(descriptor_object->Has(context, v8::String::NewFromUtf8Literal(isolate, "set")));
                if (has_getter || has_setter) {
                    v8::String::Utf8Value key_name{isolate, key};
                    throw RuntimeTypeError(
                        std::string{"Property '"} + *key_name +
                        "' could not be copied because it is an accessor. Reading it would run user "
                        "code during transfer, which is not allowed. Assign a plain value instead.");
                }
            }

            v8::Local<v8::Value> value;
            {
                // Anything else that blocks the read leaves an opaque pending exception behind.
                // Swap it for a message that names the property.
                v8::TryCatch try_catch{isolate};
                if (!source->Get(context, name).ToLocal(&value)) {
                    try_catch.Reset();
                    v8::String::Utf8Value key_name{isolate, key};
                    throw RuntimeTypeError(
                        std::string{"Property '"} + *key_name + "' could not be read during transfer");
                }
            }

            Unmaybe(target->Set(context, name, value));
        }
    }

    inline void CopyObjectProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> target, v8::Local<v8::Object> source) {
        auto property_names = GetObjectOwnProperties(context, source);

        CopyObjectProperties(context, target, source, property_names);
    }
}
