#pragma once

// The native side of the differential fixture runner (PRD-498). run-native.ts writes a fixture as
// line commands on stdin; this driver executes them against native engine classes and answers each
// observation on stdout. Doubles cross as IEEE-754 bit patterns, so a comparison is bit-exact.
//
//   fixture <name> | new <id> <Class> <arg>* | call <id> <method> <result|-> <arg>*
//   set <id> <path> <arg> | observe <index> <id> <path|-> <method|-> <kind> | end
//   render <scene> <camera> <width> <height> <toneMapping> <exposure> <srgb|linear> <png> (a
//   render-capable driver only; the `pixels` observation then answers with the PNG's path)
//   arg: n:<16 hex> | s:<percent-encoded> | b:1 | b:0 | null | r:<id>
//   reply: obs <index> <kind> <value> | unsupported <index|-> <reason> | error <message>

#include "engine/abi/binding.h"

#include <cstdint>
#include <functional>
#include <iosfwd>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace tn::fixture {

using namespace tn::binding;

/** The differential fixture driver: a binding Store keyed by the fixture's own string ids. */
/** One `render` line: the frame a render fixture asks for. */
struct RenderRequest {
    uint32_t width = 0;
    uint32_t height = 0;
    std::string toneMapping;  // none|linear|reinhard|cineon|aces|agx|neutral
    double exposure = 1;
    bool srgb = true;
    std::string png;          // where to write the frame
    bool shadowMap = false;   // a trailing `shadowMap` token: three's renderer.shadowMap.enabled
    int shadowMapType = 1;    // `shadowMapSoft` instead: PCFSoftShadowMap (2), else PCFShadowMap (1)
    /** `tsl` ops since the last render: each named TSL program and the bound object it applies to. */
    std::vector<std::pair<std::string, Object>> tsl;
};

class Driver : public Store {
public:
    /** Every native class the fixtures can name. */
    Registry classes;
    /**
     * Draws `scene` from `camera` into `request.png`; empty on success, else why not. Unset in the
     * portable driver (Wasm, Android), which then refuses `render` as unsupported.
     */
    std::function<std::string(Object& scene, Object& camera, const RenderRequest& request)> render;

    Object* find(const Value& arg) override;
    Value adopt(std::string cls, std::shared_ptr<void> ptr) override;
    Value adoptAlias(std::string cls, void* member, void* owner) override;
    Value share(std::string cls, std::shared_ptr<void> object) override;
    /**
     * The numeric array a `toArray()` result was boxed into, which is how `fromArray(array)`
     * receives what the reference receives as a plain JS array. Empty for any other argument.
     */
    std::vector<double> numbers(const Value& arg) override;

    /** Runs one fixture script; returns the process exit status. */
    int run(std::istream& in, std::ostream& out);

private:
    /** Stores an object under `id` and remembers the pointer an alias member would name it by. */
    void hold(const std::string& id, std::string cls, std::shared_ptr<void> ptr);

    std::map<std::string, Object> objects_;
    std::string frame_;  // the last frame `render` wrote, which a `pixels` observation names
    std::vector<std::pair<std::string, Object>> tsl_;  // `tsl` ops waiting for the next render
    std::unordered_map<const void*, std::shared_ptr<void>> owners_;
    uint32_t nextTemp_ = 0;
};

}  // namespace tn::fixture
