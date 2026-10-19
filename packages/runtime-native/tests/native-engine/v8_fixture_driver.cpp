// The differential fixture driver, through V8 (PRD-531 phase 2): the same line protocol as
// fixture/driver.h, but every op runs as JavaScript against the classes the V8 adapter installs,
// so a fixture checks what a game's JS would see — `mesh.position.z = 1` goes through the member
// alias and Vector3's setter, an observation through a property read. Values cross as V8 numbers
// built from the protocol's exact bits, never as text.

#include "adapters/v8/adapter.h"

#include <libplatform/libplatform.h>

#include <algorithm>
#include <bit>
#include <cctype>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

using tn::adapters::v8adapter::Adapter;

namespace {

struct Unsupported {
    std::string reason;
};

std::string decode(const std::string& text) {
    std::string out;
    for (size_t i = 0; i < text.size(); ++i) {
        if (text[i] == '%' && i + 2 < text.size()) {
            out += static_cast<char>(std::stoi(text.substr(i + 1, 2), nullptr, 16));
            i += 2;
        } else {
            out += text[i];
        }
    }
    return out;
}

std::string encode(const std::string& text) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : text) {
        if (std::isalnum(c) || std::strchr("-_.!~*'()", c)) {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

std::string bits(double value) {
    char buffer[24];
    std::snprintf(buffer, sizeof buffer, "n:%016" PRIx64, std::bit_cast<uint64_t>(value));
    return buffer;
}

// A dotted property path as JS member access; each segment must be an identifier, so a fixture
// can never inject code.
std::string access(const std::string& path) {
    std::string out;
    std::istringstream segments(path);
    for (std::string s; std::getline(segments, s, '.');) {
        // An array index (`morphTargetInfluences.0`): digits only, read as `[0]`.
        if (!s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) { return std::isdigit(c); })) {
            out += "[" + s + "]";
            continue;
        }
        if (s.empty() || !(std::isalpha(static_cast<unsigned char>(s[0])) || s[0] == '_' || s[0] == '$'))
            throw Unsupported{"path " + path};
        for (char c : s)
            if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '$')) throw Unsupported{"path " + path};
        out += "." + s;
    }
    return out;
}

class V8Driver {
public:
    V8Driver(v8::Isolate* isolate, tn_context_t* context) : isolate_(isolate), adapter_(isolate, context) {
        v8::HandleScope scope(isolate_);
        v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
        context_.Reset(isolate_, ctx);
        v8::Context::Scope contextScope(ctx);
        adapter_.install(ctx, ctx->Global());
        eval("globalThis.__ids = {};");
    }

    int run(std::istream& in, std::ostream& out) {
        v8::HandleScope scope(isolate_);
        v8::Local<v8::Context> ctx = context_.Get(isolate_);
        v8::Context::Scope contextScope(ctx);
        for (std::string line; std::getline(in, line);) {
            std::vector<std::string> t;
            std::istringstream stream(line);
            for (std::string token; stream >> token;) t.push_back(token);
            if (t.empty()) continue;
            const std::string& command = t[0];
            try {
                if (command == "fixture") continue;
                if (command == "end") break;
                if (command == "new" && t.size() >= 3) {
                    setArgs(t, 3);
                    setId(t[1]);
                    access(t[2]);  // the class name is an identifier too
                    evalOrThrow("__ids[__id] = new " + t[2] + "(...__args);");
                    continue;
                }
                if (command == "set" && t.size() >= 4) {
                    setArgs(t, 3);
                    setId(t[1]);
                    evalOrThrow("__ids[__id]" + access(t[2]) + " = __args[0];");
                    continue;
                }
                if (command == "call" && t.size() >= 4) {
                    setArgs(t, 4);
                    setId(t[1]);
                    const std::string call = "__ids[__id]" + access(t[2]) + "(...__args)";
                    if (t[3] == "-") {
                        evalOrThrow(call + ";");
                    } else {
                        setGlobal("__result", str(t[3]));
                        evalOrThrow("__ids[__result] = " + call + ";");
                    }
                    continue;
                }
                if (command == "observe" && t.size() == 6) {
                    setId(t[2]);
                    // A plain call result is observed as itself, as the C++ driver's boxed value is.
                    std::string expr = "(typeof __ids[__id] !== 'object' || Array.isArray(__ids[__id])) ? __ids[__id] : ";
                    // A path into a returned array (`toArray().3`) reads that one element, as JS does.
                    if (t[3] != "-" && t[4] == "-") expr = "Array.isArray(__ids[__id]) ? __ids[__id]" + access(decode(t[3])) + " : " + expr;
                    if (t[4] != "-") expr += "__ids[__id]" + access(decode(t[4])) + "()";
                    else if (t[3] == "-") expr += "__ids[__id]";  // the object itself (a boxed result)
                    else expr += "__ids[__id]" + access(decode(t[3]));
                    v8::Local<v8::Value> value = evalOrThrow("(" + expr + ")", t[1]);
                    out << "obs " << t[1] << " " << t[5] << " " << render(value, t[5]) << "\n";
                    continue;
                }
                throw Unsupported{"command " + command};
            } catch (const Unsupported& u) {
                const std::string index = command == "observe" && t.size() > 1 ? t[1] : "-";
                out << "unsupported " << index << " " << encode(u.reason) << "\n";
            }
        }
        out.flush();
        return 0;
    }

private:
    v8::Local<v8::String> str(const std::string& s) {
        return v8::String::NewFromUtf8(isolate_, s.c_str(), v8::NewStringType::kNormal, static_cast<int>(s.size())).ToLocalChecked();
    }
    void setGlobal(const char* name, v8::Local<v8::Value> value) {
        v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
        ctx->Global()->Set(ctx, str(name), value).Check();
    }
    void setId(const std::string& id) { setGlobal("__id", str(id)); }

    // An `a:<type>:<hex,...>` argument: a JS typed array of the bits' binary64 values, as a game
    // passing `new Float32Array([...])` to a BufferAttribute constructor would hold.
    v8::Local<v8::Value> typedArray(v8::Local<v8::Context> ctx, const std::string& token) {
        const size_t second = token.find(':', 2);
        if (second == std::string::npos) throw Unsupported{"unknown argument token " + token};
        const std::string type = token.substr(2, second - 2);
        if (type != "Float32Array" && type != "Uint8Array" && type != "Uint16Array" && type != "Uint32Array")
            throw Unsupported{"unknown argument token " + token};
        v8::Local<v8::Array> items = v8::Array::New(isolate_);
        uint32_t length = 0;
        std::string rest = token.substr(second + 1);
        while (!rest.empty()) {
            const size_t comma = rest.find(',');
            const std::string hex = comma == std::string::npos ? rest : rest.substr(0, comma);
            items->Set(ctx, length++, v8::Number::New(isolate_, std::bit_cast<double>(std::stoull(hex, nullptr, 16)))).Check();
            if (comma == std::string::npos) break;
            rest = rest.substr(comma + 1);
        }
        v8::Local<v8::Value> ctor;
        if (!ctx->Global()->Get(ctx, str(type)).ToLocal(&ctor) || !ctor->IsFunction())
            throw Unsupported{"unknown argument token " + token};
        v8::Local<v8::Value> element = items;
        v8::Local<v8::Value> made;
        if (!ctor.As<v8::Function>()->NewInstance(ctx, 1, &element).ToLocal(&made))
            throw Unsupported{"cannot build " + type};
        return made;
    }

    void setArgs(const std::vector<std::string>& t, size_t from) {
        v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
        v8::Local<v8::Array> args = v8::Array::New(isolate_, static_cast<int>(t.size() - from));
        v8::Local<v8::Object> ids = ctx->Global()->Get(ctx, str("__ids")).ToLocalChecked().As<v8::Object>();
        for (size_t i = from; i < t.size(); ++i) {
            args->Set(ctx, static_cast<uint32_t>(i - from), argument(ctx, ids, t[i])).Check();
        }
        setGlobal("__args", args);
    }

    v8::Local<v8::Value> argument(v8::Local<v8::Context> ctx, v8::Local<v8::Object> ids, const std::string& token) {
            v8::Local<v8::Value> v;
            if (token == "null") v = v8::Null(isolate_);
            else if (token.rfind("n:", 0) == 0) v = v8::Number::New(isolate_, std::bit_cast<double>(std::stoull(token.substr(2), nullptr, 16)));
            else if (token.rfind("s:", 0) == 0) v = str(decode(token.substr(2)));
            else if (token == "b:1" || token == "b:0") v = v8::Boolean::New(isolate_, token == "b:1");
            else if (token.rfind("r:", 0) == 0) v = ids->Get(ctx, str(token.substr(2))).ToLocalChecked();
            else if (token.rfind("R:", 0) == 0) {
                // R:<id>,<id>: an array of objects, as `new Skeleton([bone0, bone1])` takes.
                v8::Local<v8::Array> refs = v8::Array::New(isolate_);
                uint32_t n = 0;
                for (size_t at = 2; at < token.size();) {
                    size_t end = token.find(',', at);
                    if (end == std::string::npos) end = token.size();
                    refs->Set(ctx, n++, ids->Get(ctx, str(token.substr(at, end - at))).ToLocalChecked()).Check();
                    at = end + 1;
                }
                v = refs;
            }
            else if (token.rfind("a:", 0) == 0) v = typedArray(ctx, token);
            else if (token.rfind("o:", 0) == 0) {
                // o:<key>=<scalar>;...: an options object, as `new ExtrudeGeometry(shape, { depth })` takes.
                v8::Local<v8::Object> fields = v8::Object::New(isolate_);
                for (size_t at = 2; at < token.size();) {
                    size_t end = token.find(';', at);
                    if (end == std::string::npos) end = token.size();
                    const std::string pair = token.substr(at, end - at);
                    const size_t equals = pair.find('=');
                    if (equals == 0 || equals == std::string::npos) throw Unsupported{"unknown argument token " + token};
                    const std::string key = pair.substr(0, equals);
                    access(key);  // an identifier, never code
                    fields->Set(ctx, str(key), argument(ctx, ids, pair.substr(equals + 1))).Check();
                    at = end + 1;
                }
                v = fields;
            }
            else throw Unsupported{"unknown argument token " + token};
            return v;
    }

    v8::Local<v8::Value> eval(const std::string& source) {
        v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
        return v8::Script::Compile(ctx, str(source)).ToLocalChecked()->Run(ctx).ToLocalChecked();
    }

    // Any exception is the binding saying no (TN_NATIVE_UNSUPPORTED, an unbound member read as
    // undefined): the fixture row reports it, as the C++ driver reports its Unsupported.
    v8::Local<v8::Value> evalOrThrow(const std::string& source, const std::string& = "-") {
        v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
        v8::TryCatch tryCatch(isolate_);
        v8::Local<v8::Script> script;
        v8::Local<v8::Value> result;
        if (!v8::Script::Compile(ctx, str(source)).ToLocal(&script) || !script->Run(ctx).ToLocal(&result)) {
            v8::String::Utf8Value message(isolate_, tryCatch.Exception());
            throw Unsupported{*message ? *message : "exception"};
        }
        return result;
    }

    std::string render(v8::Local<v8::Value> value, const std::string& kind) {
        v8::Local<v8::Context> ctx = isolate_->GetCurrentContext();
        if (kind == "number" && value->IsNumber()) return bits(value.As<v8::Number>()->Value());
        if (kind == "boolean" && value->IsBoolean()) return value->IsTrue() ? "b:1" : "b:0";
        if ((kind == "string" || kind == "json") && value->IsString()) {
            v8::String::Utf8Value text(isolate_, value);
            return "s:" + encode(*text ? *text : "");
        }
        if (kind == "numbers" && (value->IsArray() || value->IsTypedArray())) {
            // A typed array (`attribute.array`) is read element by element, as a plain array is.
            v8::Local<v8::Object> array = value.As<v8::Object>();
            const uint32_t length = value->IsArray() ? value.As<v8::Array>()->Length()
                                                     : static_cast<uint32_t>(value.As<v8::TypedArray>()->Length());
            std::string out;
            for (uint32_t i = 0; i < length; ++i) {
                v8::Local<v8::Value> e = array->Get(ctx, i).ToLocalChecked();
                if (!e->IsNumber()) throw Unsupported{"numbers observation holds a non-number"};
                out += (i ? "," : "") + bits(e.As<v8::Number>()->Value());
            }
            return out;
        }
        throw Unsupported{"observation kind " + kind + " does not match the JS value"};
    }

    v8::Isolate* isolate_;
    Adapter adapter_;
    v8::Global<v8::Context> context_;
};

}  // namespace

int main() {
    std::unique_ptr<v8::Platform> platform = v8::platform::NewDefaultPlatform();
    v8::V8::InitializePlatform(platform.get());
    v8::V8::Initialize();
    std::unique_ptr<v8::ArrayBuffer::Allocator> allocator(v8::ArrayBuffer::Allocator::NewDefaultAllocator());
    v8::Isolate::CreateParams params;
    params.array_buffer_allocator = allocator.get();
    v8::Isolate* isolate = v8::Isolate::New(params);
    tn_context_t* context = nullptr;
    const tn_version_info_t own = tn_engine_version();
    tn_diagnostic_t diagnostic{nullptr, 0};
    if (tn_context_create(&context, &own, &diagnostic) != TN_OK) return std::fprintf(stderr, "no engine context\n"), 1;
    int status = 0;
    {
        v8::Isolate::Scope isolateScope(isolate);
        V8Driver driver(isolate, context);
        status = driver.run(std::cin, std::cout);
    }
    isolate->Dispose();
    tn_context_destroy(context, &diagnostic);
    v8::V8::Dispose();
    v8::V8::DisposePlatform();
    return status;
}
