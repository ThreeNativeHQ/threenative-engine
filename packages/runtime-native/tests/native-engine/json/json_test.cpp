// The engine's JSON reader against JSON.parse. `corpus`: 89 texts recorded from V8 (number edges and
// rounding, overflow to Infinity and underflow to zero, escapes, surrogate pairs and lone surrogates,
// duplicate keys, member order, whitespace, and the usual malformed inputs) parse to the same value
// or are refused, as V8 refuses them. `limits`: nesting past kMaxDepth is refused by name instead of
// exhausting the stack, and a decimal comma locale does not change a number.
#include "check.h"
#include "engine/foundation/json.h"

#include <bit>
#include <cinttypes>
#include <clocale>
#include <cstdio>
#include <iterator>
#include <string>
#include <utility>

#include "json_reference.inc"

using namespace tn::engine;

namespace {

// A WTF-8 string as JavaScript holds it: UTF-16 code units, four hex digits each.
std::string hex(std::string_view bytes) {
    std::string out;
    char unit[5];
    const auto put = [&](uint32_t u) {
        std::snprintf(unit, sizeof unit, "%04x", u);
        out += unit;
    };
    for (std::size_t i = 0; i < bytes.size();) {
        const auto b = [&](std::size_t k) { return static_cast<uint32_t>(static_cast<unsigned char>(bytes[i + k])); };
        uint32_t cp;
        if (b(0) < 0x80)
            cp = b(0), i += 1;
        else if (b(0) < 0xE0)
            cp = ((b(0) & 0x1F) << 6) | (b(1) & 0x3F), i += 2;
        else if (b(0) < 0xF0)
            cp = ((b(0) & 0x0F) << 12) | ((b(1) & 0x3F) << 6) | (b(2) & 0x3F), i += 3;
        else
            cp = ((b(0) & 0x07) << 18) | ((b(1) & 0x3F) << 12) | ((b(2) & 0x3F) << 6) | (b(3) & 0x3F), i += 4;
        if (cp >= 0x10000) {
            put(0xD800 + ((cp - 0x10000) >> 10));
            put(0xDC00 + ((cp - 0x10000) & 0x3FF));
        } else {
            put(cp);
        }
    }
    return out;
}

std::string dump(const json::Value& v) {
    switch (v.kind()) {
    case json::Value::Kind::Null:
        return "n";
    case json::Value::Kind::Bool:
        return v.boolean() ? "t" : "f";
    case json::Value::Kind::Number: {
        char out[18];
        std::snprintf(out, sizeof out, "d%016" PRIx64, std::bit_cast<uint64_t>(v.number()));
        return out;
    }
    case json::Value::Kind::String:
        return "s" + hex(v.string());
    case json::Value::Kind::Array: {
        std::string out = "[";
        for (std::size_t i = 0; i < v.items().size(); ++i)
            out += (i ? "," : "") + dump(v.items()[i]);
        return out + "]";
    }
    case json::Value::Kind::Object: {
        std::string out = "{";
        for (std::size_t i = 0; i < v.members().size(); ++i)
            out += (i ? "," : "") + hex(v.members()[i].first) + ":" + dump(v.members()[i].second);
        return out + "}";
    }
    }
    return "?";
}

void corpus() {
    std::size_t mismatched = 0;
    for (const auto& [text, expected, stringified] : kCorpus) {
        json::Value v;
        json::Error error;
        const bool parsed = json::parse(text, v, error);
        const std::string got = parsed ? dump(v) : "throws";
        if (got != expected) {
            ++mismatched;
            std::fprintf(stderr, "%s: native %s, JSON.parse %s (%s)\n", text, got.c_str(), expected,
                         error.code.c_str());
        }
        // JSON.stringify(JSON.parse(text)): order, escapes and number layout on the way back out.
        if (parsed && json::stringify(v) != stringified) {
            ++mismatched;
            std::fprintf(stderr, "%s: stringify native %s, JSON.stringify %s\n", text, json::stringify(v).c_str(),
                         stringified);
        }
    }
    for (const auto& [bits, expected] : kNumbers) {
        const std::string got = json::numberToString(std::bit_cast<double>(bits));
        if (got != expected) {
            ++mismatched;
            std::fprintf(stderr, "Number::toString %s: native %s\n", expected, got.c_str());
        }
    }
    std::printf("json: %zu texts, %zu numbers, %zu differ\n", std::size(kCorpus), std::size(kNumbers), mismatched);
    CHECK(mismatched == 0);
}

void limits() {
    std::string deep(100, '[');
    deep += std::string(100, ']');
    json::Value v;
    json::Error error;
    CHECK(!json::parse(deep, v, error) && error.code == "TN_JSON_DEPTH");
    std::string fine(60, '[');
    fine += std::string(60, ']');
    CHECK(json::parse(fine, v, error));
    CHECK(!json::parse("[1,", v, error) && error.code == "TN_JSON_SYNTAX" && error.offset == 3);
    // A host may set a decimal-comma locale (GTK does); numbers must not notice.
    if (std::setlocale(LC_NUMERIC, "de_DE.UTF-8") || std::setlocale(LC_NUMERIC, "fr_FR.UTF-8")) {
        CHECK(json::parse("1.5", v, error) && v.number() == 1.5);
        std::setlocale(LC_NUMERIC, "C");
    }
}

} // namespace

TN_TEST_MAIN({"corpus", corpus}, {"limits", limits})
