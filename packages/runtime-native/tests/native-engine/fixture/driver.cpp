#include "driver.h"

#if TN_FIXTURE_GLTF
#include <filesystem>
#include <fstream>
#include <iterator>

#include "engine/assets/gltf/loader.h"
#endif

#include <algorithm>
#include <bit>
#include <cctype>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <istream>
#include <ostream>
#include <sstream>

namespace tn::fixture {

namespace {

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

Value parseArg(const std::string& token) {
    if (token == "null") return Value{};
    if (token.rfind("n:", 0) == 0) return Value::of(std::bit_cast<double>(std::stoull(token.substr(2), nullptr, 16)));
    if (token.rfind("s:", 0) == 0) return Value{Value::Kind::String, 0, decode(token.substr(2))};
    if (token == "b:1") return Value::of(true);
    if (token == "b:0") return Value::of(false);
    if (token.rfind("r:", 0) == 0) return Value{Value::Kind::Ref, 0, token.substr(2)};
    if (token.rfind("R:", 0) == 0) return Value{Value::Kind::Refs, 0, token.substr(2)};
    if (token.rfind("a:", 0) == 0) {
        // a:<TypedArray>:<bits>,<bits>: the numbers and the array type they were written as.
        const std::size_t colon = token.find(':', 2);
        if (colon == std::string::npos) throw Unsupported{"array token names no type: " + token};
        Value v = Value::list({});
        v.text = token.substr(2, colon - 2);
        for (std::size_t at = colon + 1; at < token.size();) {
            std::size_t end = token.find(',', at);
            if (end == std::string::npos) end = token.size();
            v.numbers.push_back(std::bit_cast<double>(std::stoull(token.substr(at, end - at), nullptr, 16)));
            at = end + 1;
        }
        return v;
    }
    if (token.rfind("o:", 0) == 0) {
        // o:<key>=<scalar>;...: an options object, as `new ExtrudeGeometry(shape, { depth })` takes.
        std::vector<std::pair<std::string, Value>> fields;
        for (std::size_t at = 2; at < token.size();) {
            std::size_t end = token.find(';', at);
            if (end == std::string::npos) end = token.size();
            const std::string pair = token.substr(at, end - at);
            const std::size_t equals = pair.find('=');
            if (equals == 0 || equals == std::string::npos) throw Unsupported{"unknown argument token " + token};
            fields.emplace_back(pair.substr(0, equals), parseArg(pair.substr(equals + 1)));
            at = end + 1;
        }
        return Value::record(std::move(fields));
    }
    throw Unsupported{"unknown argument token " + token};
}

/**
 * True when a path names a flat array (`array`, `elements`) or one of its elements (`array.1`).
 * The engine exposes the whole array as a value: an element read is served from it, while an
 * element write, which no binding addresses, is the named unsupported shape TN_ARRAY_SHAPE.
 */
bool isArrayShapePath(const std::string& path) {
    const size_t dot = path.rfind('.');
    const std::string base = dot == std::string::npos ? path : path.substr(0, dot);
    if (base != "array" && base != "elements") return false;
    if (dot == std::string::npos) return true;
    const std::string last = path.substr(dot + 1);
    return !last.empty() &&
           std::all_of(last.begin(), last.end(), [](unsigned char c) { return std::isdigit(c) != 0; });
}

std::vector<std::string> split(const std::string& line) {
    std::vector<std::string> tokens;
    std::istringstream stream(line);
    for (std::string token; stream >> token;) tokens.push_back(token);
    return tokens;
}

}  // namespace

Object* Driver::find(const Value& arg) {
    if (arg.kind != Value::Kind::Ref) return nullptr;
    const auto it = objects_.find(arg.text);
    return it == objects_.end() ? nullptr : &it->second;
}

void Driver::hold(const std::string& id, std::string cls, std::shared_ptr<void> ptr) {
    owners_[ptr.get()] = ptr;
    objects_[id] = Object{std::move(cls), ptr};
}

Value Driver::adopt(std::string cls, std::shared_ptr<void> ptr) {
    const std::string id = "\x02t" + std::to_string(nextTemp_++);
    hold(id, std::move(cls), ptr);
    return Value{Value::Kind::Ref, 0, id};
}

Value Driver::adoptAlias(std::string cls, void* member, void* owner) {
    // The id is the member's address, so the same member answers the same Ref on every call, and
    // the aliasing shared_ptr keeps the owner alive while the caller holds the Ref.
    const auto found = owners_.find(owner);
    if (found == owners_.end()) throw Unsupported{"this object is not one the caller owns"};
    // The class joins the id: a first member shares its owner's address (Box3::min).
    const std::string id = "\x04a" + std::to_string(reinterpret_cast<uintptr_t>(member)) + ":" + cls;
    objects_[id] = Object{std::move(cls), std::shared_ptr<void>(found->second, member)};
    return Value{Value::Kind::Ref, 0, id};
}

Value Driver::share(std::string cls, std::shared_ptr<void> object) {
    if (!object) return Value{};
    // An object a fixture already names answers its own id (`mesh.geometry` is the geometry it built).
    for (const auto& [id, held] : objects_) {
        if (held.ptr.get() == object.get() && id.rfind("\x04a", 0) != 0) return Value{Value::Kind::Ref, 0, id};
    }
    const std::string id = "\x05s" + std::to_string(reinterpret_cast<uintptr_t>(object.get())) + ":" + cls;
    owners_[object.get()] = object;
    objects_[id] = Object{std::move(cls), std::move(object)};
    return Value{Value::Kind::Ref, 0, id};
}

std::vector<double> Driver::numbers(const Value& arg) {
    if (arg.kind != Value::Kind::Ref) return {};
    const auto it = objects_.find(arg.text);
    if (it == objects_.end() || it->second.cls != "\x03value") return {};
    const auto& boxed = *static_cast<Value*>(it->second.ptr.get());
    return numbersOf(boxed);
}

int Driver::run(std::istream& in, std::ostream& out) {
    for (std::string line; std::getline(in, line);) {
        const std::vector<std::string> t = split(line);
        if (t.empty()) continue;
        const std::string& command = t[0];
        try {
            if (command == "fixture") continue;
            if (command == "end") break;
            if (command == "new" && t.size() >= 3) {
                auto cls = classes.find(t[2]);
                if (cls == classes.end() || !cls->second.ctor) throw Unsupported{"class " + t[2]};
                Args args;
                for (size_t i = 3; i < t.size(); ++i) args.push_back(parseArg(t[i]));
                hold(t[1], t[2], cls->second.ctor(args, *this));
                continue;
            }
            if ((command == "call" && t.size() >= 4) || (command == "set" && t.size() >= 4)) {
                auto object = objects_.find(t[1]);
                if (object == objects_.end()) throw Unsupported{"no object " + t[1]};
                ClassBinding& binding = classes[object->second.cls];
                if (command == "set") {
                    auto setter = binding.setters.find(t[2]);
                    if (setter == binding.setters.end()) {
                        if (isArrayShapePath(t[2])) throw Unsupported{"TN_ARRAY_SHAPE"};
                        throw Unsupported{object->second.cls + "." + t[2] + " is not settable"};
                    }
                    setter->second(object->second.ptr.get(), parseArg(t[3]), *this);
                    continue;
                }
                // A name the class does not have as a method but does have as a member
                // (`Object3D.position`) reads that member, the same alias Ref on every call (§6.1);
                // a member takes no arguments, and adoptAlias keeps the owner alive behind it.
                auto method = binding.methods.find(t[2]);
                Method call = method == binding.methods.end() ? Method{} : method->second;
                if (!call) {
                    auto member = binding.members.find(t[2]);
                    if (member == binding.members.end())
                        throw Unsupported{object->second.cls + "." + t[2] + "()"};
                    if (t.size() > 4)
                        throw Unsupported{object->second.cls + "." + t[2] + " is a member, not a method"};
                    call = member->second;
                }
                Args args;
                for (size_t i = 4; i < t.size(); ++i) args.push_back(parseArg(t[i]));
                Value result = call(object->second.ptr.get(), args, *this);
                if (t[3] != "-") {
                    if (result.kind == Value::Kind::Ref) {
                        // A chaining method returns its own object; a new object was adopted under a temp id.
                        objects_[t[3]] = result.text == "\x01self" ? object->second : objects_[result.text];
                    } else {
                        // A plain value is held as a pseudo-object so it can be observed by id.
                        auto boxed = std::make_shared<Value>(result);
                        objects_[t[3]] = Object{"\x03value", boxed};
                    }
                }
                continue;
            }
            if (command == "tsl" && t.size() == 3) {
                // Applied by the render callback, which owns the GPU the program may dispatch on.
                auto object = objects_.find(t[1]);
                if (object == objects_.end()) throw Unsupported{"tsl names no object " + t[1]};
                tsl_.emplace_back(decode(t[2].substr(2)), object->second);
                continue;
            }
            if (command == "gltf" && (t.size() == 3 || t.size() == 4)) {
#if TN_FIXTURE_GLTF
                // A repository-relative file: the repository root is the first ancestor of the working
                // directory that holds pnpm-workspace.yaml.
                std::filesystem::path root = std::filesystem::current_path();
                while (!std::filesystem::exists(root / "pnpm-workspace.yaml") && root.has_parent_path() &&
                       root.parent_path() != root)
                    root = root.parent_path();
                std::ifstream in(root / decode(t[2].substr(2)), std::ios::binary);
                if (!in) throw Unsupported{"gltf file not found: " + decode(t[2].substr(2))};
                const std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
                tn::engine::gltf::LoadResult loaded = tn::engine::gltf::load(
                    std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
                if (!loaded.error.empty() || !loaded.scene) throw Unsupported{"gltf: " + loaded.error};
                hold(t[1], "Group", loaded.scene);
                if (t.size() == 4) { // the ids bound to the file's animations, in order
                    std::size_t i = 0, at = 0;
                    while (at <= t[3].size()) {
                        std::size_t end = t[3].find(',', at);
                        if (end == std::string::npos) end = t[3].size();
                        if (i >= loaded.animations.size()) throw Unsupported{"gltf: fewer animations than clip ids"};
                        hold(t[3].substr(at, end - at), "AnimationClip", loaded.animations[i++]);
                        at = end + 1;
                    }
                }
                continue;
#else
                throw Unsupported{"this build has no glTF loader"};
#endif
            }
            if (command == "render" && (t.size() == 9 || (t.size() == 10 && (t[9] == "shadowMap" || t[9] == "shadowMapSoft")))) {
                if (!render) throw Unsupported{"this driver does not render: use the render-capable driver"};
                auto scene = objects_.find(t[1]);
                auto camera = objects_.find(t[2]);
                if (scene == objects_.end() || camera == objects_.end()) throw Unsupported{"render names no scene or camera"};
                RenderRequest request;
                request.width = static_cast<uint32_t>(std::stoul(t[3]));
                request.height = static_cast<uint32_t>(std::stoul(t[4]));
                request.toneMapping = t[5];
                request.exposure = number(parseArg(t[6]));
                request.srgb = t[7] == "srgb";
                request.png = decode(t[8].substr(2));
                request.shadowMap = t.size() == 10;
                request.shadowMapType = t.size() == 10 && t[9] == "shadowMapSoft" ? 2 : 1;
                request.tsl = std::move(tsl_);
                tsl_.clear();
                if (const std::string failed = render(scene->second, camera->second, request); !failed.empty()) {
                    if (failed.starts_with("TN_FIXTURE_PROBES_")) throw std::runtime_error(failed);
                    throw Unsupported{failed};
                }
                frame_ = request.png;
                continue;
            }
            if (command == "observe" && t.size() == 6 && t[5] == "pixels") {
                if (frame_.empty()) throw Unsupported{"no frame was rendered"};
                out << "obs " << t[1] << " pixels s:" << encode(frame_) << "\n";
                continue;
            }
            if (command == "observe" && t.size() == 6) {
                const std::string& index = t[1];
                auto object = objects_.find(t[2]);
                if (object == objects_.end()) throw Unsupported{"no object " + t[2]};
                Value value;
                if (object->second.cls == "\x03value") {
                    value = *static_cast<Value*>(object->second.ptr.get());
                    if (t[3] != "-") {
                        // A path into a returned array (`toArray().3`) reads that one element, as JS does.
                        const std::string digits = decode(t[3]);
                        if (digits.empty() || digits.size() > 15 ||
                            !std::all_of(digits.begin(), digits.end(), [](unsigned char c) { return std::isdigit(c) != 0; }))
                            throw Unsupported{"path " + digits + " into a returned value"};
                        const uint64_t i = std::stoull(digits);
                        if (value.kind == Value::Kind::Numbers && i < value.numbers.size()) value = Value::of(value.numbers[i]);
                        else if (value.kind == Value::Kind::Array && i < value.items.size()) value = value.items[i];
                        else throw Unsupported{"TN_ARRAY_SHAPE"};
                    }
                } else {
                    ClassBinding& binding = classes[object->second.cls];
                    if (t[4] != "-") {
                        auto method = binding.methods.find(decode(t[4]));
                        if (method == binding.methods.end()) throw Unsupported{object->second.cls + "." + decode(t[4]) + "()"};
                        value = method->second(object->second.ptr.get(), {}, *this);
                    } else {
                        const std::string path = decode(t[3]);
                        auto getter = binding.getters.find(path);
                        auto member = binding.members.find(path);
                        if (getter != binding.getters.end()) {
                            value = getter->second(object->second.ptr.get());
                        } else if (member != binding.members.end()) {
                            value = member->second(object->second.ptr.get(), {}, *this);
                        } else if (const size_t dot = path.rfind('.'); isArrayShapePath(path) && dot != std::string::npos) {
                            // `array.1` reads one element of the whole array the engine stores; an
                            // index past it, or an array the class does not expose, is the named shape.
                            auto whole = binding.getters.find(path.substr(0, dot));
                            const std::string digits = path.substr(dot + 1);
                            if (whole == binding.getters.end() || digits.size() > 15) throw Unsupported{"TN_ARRAY_SHAPE"};
                            const Value all = whole->second(object->second.ptr.get());
                            const uint64_t i = std::stoull(digits);
                            if (all.kind != Value::Kind::Numbers || i >= all.numbers.size()) throw Unsupported{"TN_ARRAY_SHAPE"};
                            value = Value::of(all.numbers[i]);
                        } else {
                            if (isArrayShapePath(path)) throw Unsupported{"TN_ARRAY_SHAPE"};
                            throw Unsupported{object->second.cls + "." + path};
                        }
                    }
                }
                const std::string& kind = t[5];
                out << "obs " << index << " " << kind << " ";
                if (kind == "number" && value.kind == Value::Kind::Number) {
                    out << bits(value.number);
                } else if (kind == "numbers" && value.kind == Value::Kind::Numbers) {
                    for (size_t i = 0; i < value.numbers.size(); ++i) out << (i ? "," : "") << bits(value.numbers[i]);
                } else if (kind == "boolean" && value.kind == Value::Kind::Bool) {
                    out << (value.flag ? "b:1" : "b:0");
                } else if ((kind == "string" || kind == "json") && value.kind == Value::Kind::String) {
                    out << "s:" << encode(value.text);
                } else {
                    out << "\n";
                    throw Unsupported{"observation kind " + kind + " does not match the native value"};
                }
                out << "\n";
                continue;
            }
            throw Unsupported{"command " + command};
        } catch (const Unsupported& u) {
            const std::string index = command == "observe" && t.size() > 1 ? t[1] : "-";
            out << "unsupported " << index << " " << encode(u.reason) << "\n";
        } catch (const std::exception& e) {
            out << "error " << encode(e.what()) << "\n";
        }
    }
    out.flush();
    return 0;
}

}  // namespace tn::fixture
