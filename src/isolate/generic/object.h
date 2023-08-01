#pragma once
#include <v8.h>

namespace ivm {
    inline void CopyObjectOwnProperties(v8::Local<v8::Context> context, v8::Local<v8::Object> target, v8::Local<v8::Object> source) {
        v8::Local<v8::Array> property_names = source->GetOwnPropertyNames(context).ToLocalChecked();

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
}