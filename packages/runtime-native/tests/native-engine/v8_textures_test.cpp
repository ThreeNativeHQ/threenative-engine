// The texture slice Midway's ripples drive through V8 (HalfFloatType DataTexture, `image.data`):
// script through the adapter, then the engine Texture's own bytes, version and upload layout.
#include "adapters/v8/adapter.h"
#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/scene/texture.h"

#include <libplatform/libplatform.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

using tn::adapters::v8adapter::Adapter;
using tn::engine::Texture;

namespace {

struct Runtime {
    std::unique_ptr<v8::Platform> platform;
    v8::Isolate* isolate = nullptr;
    v8::ArrayBuffer::Allocator* allocator = nullptr;
    tn_context_t* context = nullptr;
    Runtime() {
        platform = v8::platform::NewDefaultPlatform();
        v8::V8::InitializePlatform(platform.get());
        v8::V8::Initialize();
        allocator = v8::ArrayBuffer::Allocator::NewDefaultAllocator();
        v8::Isolate::CreateParams params;
        params.array_buffer_allocator = allocator;
        isolate = v8::Isolate::New(params);
        const tn_version_info_t own = tn_engine_version();
        tn_diagnostic_t d{nullptr, 0};
        tn_context_create(&context, &own, &d);
    }
    ~Runtime() {
        isolate->Dispose();
        tn_diagnostic_t d{nullptr, 0};
        tn_context_destroy(context, &d);
        delete allocator;
        v8::V8::Dispose();
        v8::V8::DisposePlatform();
    }
};

/** Runs `source` and returns the engine Texture its result wraps, or null with the error printed. */
const Texture* textureOf(v8::Isolate* isolate, Adapter& adapter, v8::Local<v8::Context> ctx, const char* source) {
    v8::TryCatch caught(isolate);
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    tn_handle_t handle{};
    if (!v8::Script::Compile(ctx, v8::String::NewFromUtf8(isolate, source).ToLocalChecked()).ToLocal(&script) ||
        !script->Run(ctx).ToLocal(&result) || !adapter.unwrap(result, handle)) {
        v8::String::Utf8Value error(isolate, caught.Exception());
        std::fprintf(stderr, "script: %s\n", *error ? *error : "(no texture returned)");
        return nullptr;
    }
    return static_cast<const Texture*>(tn::abi::objectOf(handle)->ptr.get());
}

std::string text(v8::Isolate* isolate, v8::Local<v8::Context> ctx, const char* source) {
    v8::TryCatch caught(isolate);
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> result;
    if (!v8::Script::Compile(ctx, v8::String::NewFromUtf8(isolate, source).ToLocalChecked()).ToLocal(&script) ||
        !script->Run(ctx).ToLocal(&result)) {
        v8::String::Utf8Value error(isolate, caught.Exception());
        return std::string("THROWN ") + (*error ? *error : "?");
    }
    v8::String::Utf8Value value(isolate, result);
    return *value ? *value : "";
}

uint16_t half(const Texture& t, std::size_t i) {
    uint16_t bits = 0;
    std::memcpy(&bits, t.data.data() + i * 2, 2);
    return bits;
}

void halfFloat() {
    static Runtime rt;
    v8::Isolate::Scope isolateScope(rt.isolate);
    v8::HandleScope scope(rt.isolate);
    v8::Local<v8::Context> ctx = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(ctx);
    Adapter adapter(rt.isolate, rt.context);
    adapter.install(ctx, ctx->Global());

    // 1.0, -2.0, 0.5 and +Inf as binary16 bits: stored verbatim, 8 bytes per texel, RGBA16Float.
    const Texture* t = textureOf(rt.isolate, adapter, ctx,
        "globalThis.halfData = new Uint16Array([0x3c00, 0xc000, 0x3800, 0x7c00, 0, 0x8000, 0x3555, 0x7bff]);"
        "globalThis.halfTexture = new DataTexture(halfData, 2, 1, RGBAFormat, 1016); halfTexture");
    CHECK(t != nullptr);
    if (!t) return;
    CHECK(t->type == 1016 && !t->isFloat());
    CHECK(t->width == 2 && t->height == 1 && t->data.size() == 16 && t->hasImage());
    CHECK(half(*t, 0) == 0x3c00 && half(*t, 1) == 0xc000 && half(*t, 3) == 0x7c00 && half(*t, 7) == 0x7bff);

    // `image.data` replaces the texels without moving `version`; needsUpdate moves it once.
    const uint32_t version = t->version();
    CHECK(text(rt.isolate, ctx, "halfData[0] = 0x4000; halfTexture.image.data = halfData; String(halfTexture.version)") ==
          std::to_string(version));
    CHECK(half(*t, 0) == 0x4000 && t->version() == version);
    CHECK(text(rt.isolate, ctx, "halfTexture.needsUpdate = true; String(halfTexture.version)") == std::to_string(version + 1));

    // Fail closed: fractional or out-of-range values are not binary16 bits, a wrong size is refused,
    // and a type the renderer cannot upload never stores bytes it would misread.
    CHECK(text(rt.isolate, ctx, "new DataTexture(new Float32Array([0.5, 0, 0, 1]), 1, 1, RGBAFormat, 1016)")
              .find("HalfFloatType DataTexture data must be a Uint16Array") != std::string::npos);
    CHECK(text(rt.isolate, ctx, "new DataTexture(new Int32Array([70000, 0, 0, 1]), 1, 1, RGBAFormat, 1016)")
              .find("HalfFloatType DataTexture data must be a Uint16Array") != std::string::npos);
    CHECK(text(rt.isolate, ctx, "halfTexture.image.data = new Uint16Array(4)")
              .find("image.data must be a typed array of width * height * 4 values") != std::string::npos);
    CHECK(text(rt.isolate, ctx, "new DataTexture(new Uint8Array([1, 2, 3, 4]), 1, 1, RGBAFormat, 1010)")
              .find("DataTexture type must be UnsignedByteType, FloatType or HalfFloatType") != std::string::npos);
    CHECK(half(*t, 0) == 0x4000 && t->data.size() == 16);
}

}  // namespace

TN_TEST_MAIN({"half_float", halfFloat})
