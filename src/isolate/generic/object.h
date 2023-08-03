#pragma once
#include <v8.h>
#include <iostream>

void PrintV8Object(v8::Local<v8::Context> context, v8::Local<v8::Object> object) {
    v8::Local<v8::Array> property_names = object->GetOwnPropertyNames(context).ToLocalChecked();

    for (unsigned int i = 0; i < property_names->Length(); i++) {
        v8::Local<v8::Value> key = property_names->Get(context, i).ToLocalChecked();
        v8::String::Utf8Value utf8_key(context->GetIsolate(), key);
        v8::Local<v8::Value> value = object->Get(context, key).ToLocalChecked();
        v8::String::Utf8Value utf8_value(context->GetIsolate(), value);
        std::cout << *utf8_key << ": " << *utf8_value << '\n';
    }
}

namespace ivm {
    inline auto GetObjectOwnProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> object) -> v8::Local<v8::Array> {
        v8::Local<v8::Array> property_names = object->GetPropertyNames(context, v8::KeyCollectionMode::kOwnOnly, v8::ALL_PROPERTIES, v8::IndexFilter::kSkipIndices).ToLocalChecked();

        return property_names;
    }

    inline void CopyObjectProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> target, v8::Local<v8::Object> source, v8::Local<v8::Array> property_names) {
        PrintV8Object(context, source);

        for (uint32_t i = 0; i < property_names->Length(); i++) {
            v8::MaybeLocal<v8::Value> key = property_names->Get(context, i);
            if (key.IsEmpty()) {
                continue;
            }

            v8::MaybeLocal<v8::Value> value = source->Get(context, key.ToLocalChecked());

            if (value.IsEmpty()) {
                continue;
            }

            target->Set(context, key.ToLocalChecked(), value.ToLocalChecked()).Check();
        }
    }

    inline void CopyObjectProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> target, v8::Local<v8::Object> source) {
        auto property_names = GetObjectOwnProperties(context, source);

        CopyObjectProperties(context, target, source, property_names);
    }
}