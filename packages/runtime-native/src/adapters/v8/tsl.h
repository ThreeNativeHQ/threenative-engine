#pragma once

#include "engine/abi/tsl_call.h"
#include "threenative/abi/tn_abi.h"
#include "engine/shader/graph/graph.h"

#include <v8.h>

#include <functional>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace tn::adapters::v8adapter {

/** JS authoring over the native graph. No Program exists until the material/runner lowers it. */
class Tsl {
  public:
    explicit Tsl(v8::Isolate* isolate);
    ~Tsl();
    void install(v8::Local<v8::Context> context, v8::Local<v8::Object> target);
    bool unwrap(v8::Local<v8::Value> value, engine::shader::graph::Node& node) const;
    v8::Local<v8::Object> wrap(engine::shader::graph::Node node);
    /** The engine object a JS value wraps, as the adapter unwraps it; set by the adapter. */
    std::function<bool(v8::Local<v8::Value>, tn_handle_t&)> engineObject;

  private:
    struct Wrapper;
    struct Call;
    Wrapper* wrapper(v8::Local<v8::Value> value) const;
    engine::shader::graph::Node input(v8::Local<v8::Value> value) const;
    abi::TslArg argument(const std::string& name, int index, int count, v8::Local<v8::Value> value) const;
    engine::shader::graph::Node capture(v8::Local<v8::Function> callback, v8::Local<v8::Value> argument = {});
    v8::Local<v8::FunctionTemplate> function(v8::Local<v8::Context> context, const char* name, bool method);
    static void dispatch(const v8::FunctionCallbackInfo<v8::Value>& info);
    void call(const Call& call, const v8::FunctionCallbackInfo<v8::Value>& info);

    v8::Isolate* isolate_;
    v8::Global<v8::ObjectTemplate> nodeTemplate_;
    std::set<Wrapper*> wrappers_;
    std::vector<std::unique_ptr<Call>> calls_;
    abi::TslScopes scopes_;  // the bodies open while JS callbacks run (shared with the Wasm back end)
    uint64_t serial_ = 0;
};

} // namespace tn::adapters::v8adapter
