// The corpus is JS authoring, not a C++ reconstruction: lower the wrappers returned by corpus.js.
#include "adapters/v8/adapter.h"
#include "adapters/v8/tsl.h"
#include "engine/shader/tsl/tsl.h"

#include <libplatform/libplatform.h>

#include <cstdio>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {
struct Runtime {
    std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
    std::unique_ptr<v8::ArrayBuffer::Allocator> allocator;
    v8::Isolate* isolate = nullptr;
    tn_context_t* engine = nullptr;
    Runtime() {
        v8::V8::InitializePlatform(platform.get());
        v8::V8::Initialize();
        allocator.reset(v8::ArrayBuffer::Allocator::NewDefaultAllocator());
        v8::Isolate::CreateParams params;
        params.array_buffer_allocator = allocator.get();
        isolate = v8::Isolate::New(params);
        const auto own = tn_engine_version();
        tn_diagnostic_t diagnostic{};
        if (tn_context_create(&engine, &own, &diagnostic) != TN_OK) {
            tn_diagnostic_release(&diagnostic);
            throw std::runtime_error("cannot create engine context");
        }
    }
    ~Runtime() {
        isolate->Dispose();
        tn_diagnostic_t diagnostic{};
        tn_context_destroy(engine, &diagnostic);
        tn_diagnostic_release(&diagnostic);
        v8::V8::Dispose();
        v8::V8::DisposePlatform();
    }
};

int corpus(Runtime& rt, const char* path) {
    std::ifstream file(path);
    if (!file)
        throw std::runtime_error(std::string("cannot read corpus: ") + path);
    std::stringstream source;
    source << file.rdbuf();
    v8::Isolate::Scope isolateScope(rt.isolate);
    v8::HandleScope handles(rt.isolate);
    const auto context = v8::Context::New(rt.isolate);
    v8::Context::Scope contextScope(context);
    tn::adapters::v8adapter::Adapter adapter(rt.isolate, rt.engine);
    adapter.install(context, context->Global());
    v8::TryCatch caught(rt.isolate);
    v8::Local<v8::Script> script;
    v8::Local<v8::Value> value;
    if (!v8::Script::Compile(context, v8::String::NewFromUtf8(rt.isolate, source.str().c_str()).ToLocalChecked())
             .ToLocal(&script) ||
        !script->Run(context).ToLocal(&value)) {
        v8::String::Utf8Value error(rt.isolate, caught.Exception());
        throw std::runtime_error(*error ? *error : "corpus failed");
    }
    if (!value->IsArray() || value.As<v8::Array>()->Length() != 52)
        throw std::runtime_error("corpus must return 52 graphs");
    const auto graphs = value.As<v8::Array>();
    using namespace tn::engine::shader;
    for (uint32_t i = 0; i < graphs->Length(); ++i) {
        v8::Local<v8::Value> entry;
        if (!graphs->Get(context, i).ToLocal(&entry) || !entry->IsArray() || entry.As<v8::Array>()->Length() != 3)
            throw std::runtime_error("invalid corpus row");
        const auto row = entry.As<v8::Array>();
        v8::Local<v8::Value> name, output, wrapper;
        if (!row->Get(context, 0).ToLocal(&name) || !row->Get(context, 1).ToLocal(&output) ||
            !row->Get(context, 2).ToLocal(&wrapper) || !name->IsString() || !output->IsString())
            throw std::runtime_error("invalid graph name/output");
        v8::String::Utf8Value label(rt.isolate, name), target(rt.isolate, output);
        const std::string out(*target);
        if (out != "position" && out != "color" && out != "compute")
            throw std::runtime_error("unknown graph stage");
        graph::Node node;
        if (!adapter.tsl().unwrap(wrapper, node))
            throw std::runtime_error("corpus returned a non-node");
        Program program(out == "compute" ? Stage::Compute : out == "color" ? Stage::Fragment : Stage::Vertex);
        {
            tsl::Build build(program);
            const ExprId expression = graph::lower(node, program);
            if (out != "compute")
                program.output(out, expression);
        }
        std::printf("# %s\n", *label);
        if (!program.ok()) {
            for (const Diagnostic& diagnostic : program.diagnostics())
                std::printf("DIAGNOSTIC %s %s: %s\n", diagnostic.code.c_str(), diagnostic.node.c_str(),
                            diagnostic.reason.c_str());
        } else
            std::printf("%s", program.dump(true).c_str());
    }
    return 0;
}
} // namespace

int main(int argc, char** argv) {
    try {
        Runtime rt;
        return corpus(rt, argc > 1 ? argv[1] : TN_TSL_CORPUS);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "TN_TSL_CORPUS: %s\n", error.what());
        return 1;
    }
}
