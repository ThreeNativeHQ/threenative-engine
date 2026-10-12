// PRD-531: the native `MathUtils` binding and the template's constants, bit-for-bit against what the
// pinned three produces (mathutils_reference.json, written by mathutils-reference.ts). The test
// drives the binding registry, not the free functions, so it proves the bound surface a game reaches.
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

#include "engine/abi/bindings.h"
#include "engine/foundation/ThreeConstants.h"
#include "engine/foundation/json.h"

using namespace tn::binding;
using JsonValue = tn::engine::json::Value;

namespace {

std::string readFile(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

double bits(const std::string& hex) {
    return std::bit_cast<double>(std::stoull(hex, nullptr, 16));
}

/** Two doubles are the same value when every bit matches; any NaN matches any NaN (payload is not a claim). */
bool same(double expected, double actual) {
    if (std::isnan(expected) && std::isnan(actual)) return true;
    return std::bit_cast<uint64_t>(expected) == std::bit_cast<uint64_t>(actual);
}

/** The methods never touch the store; a MathUtils call takes no object reference. */
class EmptyStore : public Store {
public:
    Object* find(const Value&) override { return nullptr; }
    Value adopt(std::string, std::shared_ptr<void>) override { return Value{}; }
    Value adoptAlias(std::string, void*, void*) override { return Value{}; }
    Value share(std::string, std::shared_ptr<void>) override { return Value{}; }
    std::vector<double> numbers(const Value&) override { return {}; }
};

std::string text(const JsonValue& value) { return value.isString() ? value.string() : std::string(); }

}  // namespace

int main() {
    JsonValue reference;
    tn::engine::json::Error error;
    if (!tn::engine::json::parse(readFile(TN_MATHUTILS_REFERENCE), reference, error)) {
        std::printf("FAIL: cannot read %s\n", TN_MATHUTILS_REFERENCE);
        return 1;
    }

    Registry registry;
    registerAll(registry);
    const ClassBinding& math = registry.at("MathUtils");
    EmptyStore store;
    int checks = 0, differ = 0;

    for (const JsonValue& fn : reference.find("functions")->items()) {
        const std::string name = text(*fn.find("name"));
        const auto method = math.methods.find(name);
        if (method == math.methods.end()) {
            std::printf("  %s is not bound\n", name.c_str());
            ++differ;
            continue;
        }
        for (const JsonValue& test : fn.find("cases")->items()) {
            Args args;
            for (const JsonValue& arg : test.find("args")->items()) args.push_back(Value::of(bits(text(arg))));
            const double expected = bits(text(*test.find("expected")));
            const Value actual = method->second(nullptr, args, store);
            ++checks;
            if (actual.kind != Value::Kind::Number || !same(expected, actual.number)) {
                std::printf("  %s differs: expected %016llx, got %016llx\n", name.c_str(),
                            static_cast<unsigned long long>(std::bit_cast<uint64_t>(expected)),
                            actual.kind == Value::Kind::Number
                                ? static_cast<unsigned long long>(std::bit_cast<uint64_t>(actual.number))
                                : 0ULL);
                ++differ;
            }
        }
    }

    for (const JsonValue& constant : reference.find("constants")->items()) {
        const std::string name = text(*constant.find("name"));
        const std::string kind = text(*constant.find("kind"));
        const std::string value = text(*constant.find("value"));
        ++checks;
        if (kind == "number") {
            double native = 0;
            if (name == "ACESFilmicToneMapping") native = tn::engine::ACESFilmicToneMapping;
            else if (name == "AgXToneMapping") native = tn::engine::AgXToneMapping;
            else if (name == "NeutralToneMapping") native = tn::engine::NeutralToneMapping;
            else if (name == "PCFSoftShadowMap") native = tn::engine::PCFSoftShadowMap;
            else {
                std::printf("  constant %s is not implemented natively\n", name.c_str());
                ++differ;
                continue;
            }
            if (!same(bits(value), native)) {
                std::printf("  constant %s differs\n", name.c_str());
                ++differ;
            }
        } else {
            const char* native = name == "NoColorSpace"       ? tn::engine::NoColorSpace
                                 : name == "LinearSRGBColorSpace" ? tn::engine::LinearSRGBColorSpace
                                                                  : nullptr;
            if (native == nullptr || value != native) {
                std::printf("  constant %s differs\n", name.c_str());
                ++differ;
            }
        }
    }

    std::printf("mathutils: %d checks, %d differ\n", checks, differ);
    if (checks == 0 || differ != 0) {
        std::printf("FAIL\n");
        return 1;
    }
    std::printf("PASS\n");
    return 0;
}
