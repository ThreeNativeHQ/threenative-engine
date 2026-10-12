#pragma once

// A JSON reader and writer for engine inputs that arrive as text: world packages, playtest protocol
// frames (PRD-521, PRD-529). RFC 8259, with JavaScript's JSON.parse/JSON.stringify answers where they
// show: object members keep their order (as a JavaScript object's string keys do), a repeated key
// keeps its first position and its last value, numbers are binary64, correctly rounded, and written
// as Number::toString writes them. Strings are WTF-8: UTF-8, except that a lone surrogate a JSON text
// escapes keeps its own 3-byte encoding, so a JavaScript string survives the round trip. Inputs are
// untrusted, so it fails closed with a byte offset, refuses nesting deeper than kMaxDepth and never
// throws.

#include <charconv>
#include <cerrno>
#include <cmath>
#if defined(__APPLE__)
#include <xlocale.h>
#elif defined(__ANDROID__)
#include <locale.h>
#endif
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <system_error>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tn::engine::json {

// Each nesting level is a recursive call; 64 keeps the worst case inside Emscripten's 64 KiB default
// stack (256 overflowed it). Engine inputs (world packages, protocol frames) nest about ten deep.
inline constexpr int kMaxDepth = 64;

class Value {
  public:
    enum class Kind : uint8_t { Null, Bool, Number, String, Array, Object };

    Value() = default;
    [[nodiscard]] Kind kind() const { return kind_; }
    [[nodiscard]] bool isNull() const { return kind_ == Kind::Null; }
    [[nodiscard]] bool isBool() const { return kind_ == Kind::Bool; }
    [[nodiscard]] bool isNumber() const { return kind_ == Kind::Number; }
    [[nodiscard]] bool isString() const { return kind_ == Kind::String; }
    [[nodiscard]] bool isArray() const { return kind_ == Kind::Array; }
    [[nodiscard]] bool isObject() const { return kind_ == Kind::Object; }

    [[nodiscard]] bool boolean() const { return bool_; }
    [[nodiscard]] double number() const { return number_; }
    [[nodiscard]] const std::string& string() const { return string_; }
    [[nodiscard]] const std::vector<Value>& items() const { return items_; }
    /** Members in first-seen order; a repeated key kept its first position and took the last value. */
    [[nodiscard]] const std::vector<std::pair<std::string, Value>>& members() const { return members_; }
    /** The member named `key`, or null when absent or when this is not an object. */
    [[nodiscard]] const Value* find(std::string_view key) const {
        for (const auto& [name, value] : members_)
            if (name == key)
                return &value;
        return nullptr;
    }

    static Value makeNull() { return Value(); }
    static Value makeBool(bool b) {
        Value v;
        v.kind_ = Kind::Bool;
        v.bool_ = b;
        return v;
    }
    static Value makeNumber(double n) {
        Value v;
        v.kind_ = Kind::Number;
        v.number_ = n;
        return v;
    }
    static Value makeString(std::string s) {
        Value v;
        v.kind_ = Kind::String;
        v.string_ = std::move(s);
        return v;
    }
    static Value makeArray(std::vector<Value> items) {
        Value v;
        v.kind_ = Kind::Array;
        v.items_ = std::move(items);
        return v;
    }
    static Value makeObject(std::vector<std::pair<std::string, Value>> members) {
        Value v;
        v.kind_ = Kind::Object;
        v.members_ = std::move(members);
        return v;
    }

  private:
    Kind kind_ = Kind::Null;
    bool bool_ = false;
    double number_ = 0;
    std::string string_;
    std::vector<Value> items_;
    std::vector<std::pair<std::string, Value>> members_;
};

/** Why `parse` refused: TN_JSON_SYNTAX or TN_JSON_DEPTH, the byte offset and what was expected. */
struct Error {
    std::string code;
    std::size_t offset = 0;
    std::string detail;
};

namespace detail {

class Parser {
  public:
    explicit Parser(std::string_view text) : text_(text) {}

    bool document(Value& out, Error& error) {
        skip();
        if (!value(out, 0, error))
            return false;
        skip();
        if (at_ != text_.size())
            return fail(error, "TN_JSON_SYNTAX", "text after the value");
        return true;
    }

  private:
    bool fail(Error& error, const char* code, std::string detail) {
        error = Error{code, at_, std::move(detail)};
        return false;
    }
    void skip() {
        while (at_ < text_.size() &&
               (text_[at_] == ' ' || text_[at_] == '\t' || text_[at_] == '\n' || text_[at_] == '\r'))
            ++at_;
    }
    bool literal(std::string_view word) {
        if (text_.substr(at_, word.size()) != word)
            return false;
        at_ += word.size();
        return true;
    }

    bool value(Value& out, int depth, Error& error) {
        if (depth > kMaxDepth)
            return fail(error, "TN_JSON_DEPTH", "nested deeper than 64");
        if (at_ >= text_.size())
            return fail(error, "TN_JSON_SYNTAX", "a value");
        switch (text_[at_]) {
        case '{':
            return object(out, depth, error);
        case '[':
            return array(out, depth, error);
        case '"': {
            std::string s;
            if (!string(s, error))
                return false;
            out = Value::makeString(std::move(s));
            return true;
        }
        case 't':
            if (literal("true"))
                return out = Value::makeBool(true), true;
            break;
        case 'f':
            if (literal("false"))
                return out = Value::makeBool(false), true;
            break;
        case 'n':
            if (literal("null"))
                return out = Value::makeNull(), true;
            break;
        default:
            if (text_[at_] == '-' || (text_[at_] >= '0' && text_[at_] <= '9'))
                return number(out, error);
        }
        return fail(error, "TN_JSON_SYNTAX", "a value");
    }

    // The RFC 8259 number grammar exactly (no leading zeros, no '+', no bare '.'), then a correctly
    // rounded conversion of the whole token.
    bool number(Value& out, Error& error) {
        const std::size_t start = at_;
        const auto digit = [&] { return at_ < text_.size() && text_[at_] >= '0' && text_[at_] <= '9'; };
        if (text_[at_] == '-')
            ++at_;
        if (!digit())
            return fail(error, "TN_JSON_SYNTAX", "a digit");
        if (text_[at_] == '0')
            ++at_;
        else
            while (digit())
                ++at_;
        if (at_ < text_.size() && text_[at_] == '.') {
            ++at_;
            if (!digit())
                return fail(error, "TN_JSON_SYNTAX", "a digit after '.'");
            while (digit())
                ++at_;
        }
        if (at_ < text_.size() && (text_[at_] == 'e' || text_[at_] == 'E')) {
            ++at_;
            if (at_ < text_.size() && (text_[at_] == '+' || text_[at_] == '-'))
                ++at_;
            if (!digit())
                return fail(error, "TN_JSON_SYNTAX", "an exponent digit");
            while (digit())
                ++at_;
        }
        out = Value::makeNumber(toDouble(text_.substr(start, at_ - start)));
        return true;
    }

    // from_chars, not strtod: it ignores the C locale (a host's setlocale can make strtod stop at
    // '.') and rounds correctly. Past binary64's range it reports out_of_range and leaves the value
    // alone; JSON.parse answers ±Infinity for an overflow and ±0 for an underflow, told apart here by
    // the token's decimal exponent at its first significant digit.
    static double toDouble(std::string_view token) {
        double value = 0;
#if defined(__APPLE__) || defined(__ANDROID__)
        // These libc++ builds have no floating-point from_chars: strtod_l in the C locale is the same
        // correctly rounded, locale-free parse. ERANGE with 0 or ±HUGE_VAL is an overflow or an
        // underflow (handled below); a subnormal result is a valid value.
        static const locale_t cLocale = newlocale(LC_ALL_MASK, "C", nullptr);
        const std::string text(token);
        char* end = nullptr;
        errno = 0;
        value = strtod_l(text.c_str(), &end, cLocale);
        const bool range = errno == ERANGE && (value == 0 || std::abs(value) == HUGE_VAL);
        if (!range && end == text.c_str() + text.size())
            return value;
        value = 0;
#else
        const auto [end, ec] = std::from_chars(token.data(), token.data() + token.size(), value);
        if (ec == std::errc() && end == token.data() + token.size())
            return value;
#endif
        const bool negative = token.front() == '-';
        long exponent = 0, firstSignificant = 0;
        bool seen = false, afterPoint = false;
        long position = 0; // digits before the decimal point, minus those after it, to the first non-zero
        for (std::size_t i = negative ? 1 : 0; i < token.size(); ++i) {
            const char c = token[i];
            if (c == '.') {
                afterPoint = true;
                continue;
            }
            if (c == 'e' || c == 'E') {
                exponent = std::strtol(std::string(token.substr(i + 1)).c_str(), nullptr, 10);
                break;
            }
            if (!afterPoint)
                ++position;
            if (!seen && c != '0') {
                seen = true;
                firstSignificant = afterPoint ? -(static_cast<long>(i) - static_cast<long>(token.find('.'))) : 0;
            }
        }
        const long magnitude = exponent + (firstSignificant < 0 ? firstSignificant : position);
        const double inf = std::numeric_limits<double>::infinity();
        return magnitude > 0 ? (negative ? -inf : inf) : (negative ? -0.0 : 0.0);
    }

    static void utf8(std::string& out, uint32_t cp) {
        if (cp < 0x80) {
            out += char(cp);
        } else if (cp < 0x800) {
            out += char(0xC0 | (cp >> 6));
            out += char(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += char(0xE0 | (cp >> 12));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        } else {
            out += char(0xF0 | (cp >> 18));
            out += char(0x80 | ((cp >> 12) & 0x3F));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
    }
    bool hex4(uint32_t& out) {
        if (at_ + 4 > text_.size())
            return false;
        out = 0;
        for (int i = 0; i < 4; ++i) {
            const char c = text_[at_++];
            out <<= 4;
            if (c >= '0' && c <= '9')
                out |= uint32_t(c - '0');
            else if (c >= 'a' && c <= 'f')
                out |= uint32_t(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F')
                out |= uint32_t(c - 'A' + 10);
            else
                return false;
        }
        return true;
    }

    // A lone surrogate escape keeps its code point (WTF-8), as JavaScript keeps it in UTF-16; control
    // characters must be escaped, as RFC 8259 requires.
    bool string(std::string& out, Error& error) {
        ++at_; // the opening quote
        while (true) {
            if (at_ >= text_.size())
                return fail(error, "TN_JSON_SYNTAX", "a closing quote");
            const char c = text_[at_];
            if (c == '"') {
                ++at_;
                return true;
            }
            if (static_cast<unsigned char>(c) < 0x20)
                return fail(error, "TN_JSON_SYNTAX", "an escaped control character");
            if (c != '\\') {
                out += c;
                ++at_;
                continue;
            }
            if (++at_ >= text_.size())
                return fail(error, "TN_JSON_SYNTAX", "an escape");
            const char e = text_[at_++];
            switch (e) {
            case '"':
                out += '"';
                break;
            case '\\':
                out += '\\';
                break;
            case '/':
                out += '/';
                break;
            case 'b':
                out += '\b';
                break;
            case 'f':
                out += '\f';
                break;
            case 'n':
                out += '\n';
                break;
            case 'r':
                out += '\r';
                break;
            case 't':
                out += '\t';
                break;
            case 'u': {
                uint32_t cp = 0;
                if (!hex4(cp))
                    return fail(error, "TN_JSON_SYNTAX", "four hex digits");
                if (cp >= 0xD800 && cp <= 0xDBFF && text_.substr(at_, 2) == "\\u") {
                    const std::size_t save = at_;
                    at_ += 2;
                    uint32_t low = 0;
                    if (hex4(low) && low >= 0xDC00 && low <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
                    } else {
                        at_ = save; // a lone high surrogate; the next escape is read on its own
                    }
                }
                utf8(out, cp);
                break;
            }
            default:
                return fail(error, "TN_JSON_SYNTAX", "a valid escape");
            }
        }
    }

    bool array(Value& out, int depth, Error& error) {
        ++at_;
        std::vector<Value> items;
        skip();
        if (at_ < text_.size() && text_[at_] == ']') {
            ++at_;
            out = Value::makeArray({});
            return true;
        }
        while (true) {
            Value item;
            skip();
            if (!value(item, depth + 1, error))
                return false;
            items.push_back(std::move(item));
            skip();
            if (at_ < text_.size() && text_[at_] == ',') {
                ++at_;
                continue;
            }
            if (at_ < text_.size() && text_[at_] == ']') {
                ++at_;
                out = Value::makeArray(std::move(items));
                return true;
            }
            return fail(error, "TN_JSON_SYNTAX", "',' or ']'");
        }
    }

    bool object(Value& out, int depth, Error& error) {
        ++at_;
        std::vector<std::pair<std::string, Value>> members;
        skip();
        if (at_ < text_.size() && text_[at_] == '}') {
            ++at_;
            out = Value::makeObject({});
            return true;
        }
        while (true) {
            skip();
            if (at_ >= text_.size() || text_[at_] != '"')
                return fail(error, "TN_JSON_SYNTAX", "a member name");
            std::string name;
            if (!string(name, error))
                return false;
            skip();
            if (at_ >= text_.size() || text_[at_] != ':')
                return fail(error, "TN_JSON_SYNTAX", "':'");
            ++at_;
            skip();
            Value member;
            if (!value(member, depth + 1, error))
                return false;
            bool replaced = false;
            for (auto& [existing, value] : members) {
                if (existing == name) {
                    value = std::move(member); // JSON.parse: the last value, at the first position
                    replaced = true;
                    break;
                }
            }
            if (!replaced)
                members.emplace_back(std::move(name), std::move(member));
            skip();
            if (at_ < text_.size() && text_[at_] == ',') {
                ++at_;
                continue;
            }
            if (at_ < text_.size() && text_[at_] == '}') {
                ++at_;
                out = Value::makeObject(std::move(members));
                return true;
            }
            return fail(error, "TN_JSON_SYNTAX", "',' or '}'");
        }
    }

    std::string_view text_;
    std::size_t at_ = 0;
};

} // namespace detail

/**
 * ECMAScript Number::toString(10): the shortest digits that round-trip (to_chars gives them), laid
 * out as JavaScript does — plain up to 21 integer digits, `0.000ddd` down to 1e-7, else `d.ddde±n`.
 */
inline std::string numberToString(double x) {
    if (x != x)
        return "NaN";
    if (x == 0)
        return "0"; // -0 too
    if (x == std::numeric_limits<double>::infinity())
        return "Infinity";
    if (x == -std::numeric_limits<double>::infinity())
        return "-Infinity";
    char buf[64];
    const auto result = std::to_chars(buf, buf + sizeof buf, x, std::chars_format::scientific);
    const std::string_view sci(buf, static_cast<std::size_t>(result.ptr - buf));
    const bool negative = sci.front() == '-';
    const std::size_t e = sci.find('e');
    std::string digits;
    for (char c : sci.substr(negative ? 1 : 0, e - (negative ? 1 : 0)))
        if (c != '.')
            digits += c;
    const int n = std::atoi(std::string(sci.substr(e + 1)).c_str()) + 1; // s * 10^(n - k) = |x|
    const int k = static_cast<int>(digits.size());
    std::string out = negative ? "-" : "";
    if (k <= n && n <= 21) {
        out += digits + std::string(static_cast<std::size_t>(n - k), '0');
    } else if (0 < n && n <= 21) {
        out += digits.substr(0, static_cast<std::size_t>(n)) + "." + digits.substr(static_cast<std::size_t>(n));
    } else if (-6 < n && n <= 0) {
        out += "0." + std::string(static_cast<std::size_t>(-n), '0') + digits;
    } else {
        out += digits.substr(0, 1);
        if (k > 1)
            out += "." + digits.substr(1);
        out += (n - 1 >= 0 ? "e+" : "e-") + std::to_string(n - 1 >= 0 ? n - 1 : 1 - n);
    }
    return out;
}

/** JSON.stringify of a parsed value: no whitespace, members in order, NaN and ±Infinity as null. */
inline void stringify(const Value& v, std::string& out) {
    switch (v.kind()) {
    case Value::Kind::Null:
        out += "null";
        return;
    case Value::Kind::Bool:
        out += v.boolean() ? "true" : "false";
        return;
    case Value::Kind::Number: {
        const double x = v.number();
        out += (x != x || x - x != 0) ? "null" : numberToString(x);
        return;
    }
    case Value::Kind::String: {
        static const char* const hex = "0123456789abcdef";
        const std::string& s = v.string();
        out += '"';
        for (std::size_t i = 0; i < s.size(); ++i) {
            const auto c = static_cast<unsigned char>(s[i]);
            // Well-formed JSON.stringify: a lone surrogate (WTF-8: ED A0..BF xx) is written as \udxxx.
            if (c == 0xED && i + 2 < s.size() && (static_cast<unsigned char>(s[i + 1]) & 0xE0) == 0xA0) {
                const uint32_t cp = 0xD000 | ((static_cast<unsigned char>(s[i + 1]) & 0x3F) << 6) |
                                    (static_cast<unsigned char>(s[i + 2]) & 0x3F);
                out += "\\u";
                for (int shift = 12; shift >= 0; shift -= 4)
                    out += hex[(cp >> shift) & 15];
                i += 2;
                continue;
            }
            switch (c) {
            case '"':
                out += "\\\"";
                break;
            case '\\':
                out += "\\\\";
                break;
            case '\b':
                out += "\\b";
                break;
            case '\f':
                out += "\\f";
                break;
            case '\n':
                out += "\\n";
                break;
            case '\r':
                out += "\\r";
                break;
            case '\t':
                out += "\\t";
                break;
            default:
                if (c < 0x20) {
                    out += "\\u00";
                    out += hex[c >> 4];
                    out += hex[c & 15];
                } else {
                    out += static_cast<char>(c);
                }
            }
        }
        out += '"';
        return;
    }
    case Value::Kind::Array:
        out += '[';
        for (std::size_t i = 0; i < v.items().size(); ++i) {
            if (i)
                out += ',';
            stringify(v.items()[i], out);
        }
        out += ']';
        return;
    case Value::Kind::Object:
        out += '{';
        for (std::size_t i = 0; i < v.members().size(); ++i) {
            if (i)
                out += ',';
            stringify(Value::makeString(v.members()[i].first), out);
            out += ':';
            stringify(v.members()[i].second, out);
        }
        out += '}';
        return;
    }
}

inline std::string stringify(const Value& v) {
    std::string out;
    stringify(v, out);
    return out;
}

/** Parses one JSON text into `out`; false with `error` (and `out` untouched) when it is not one. */
inline bool parse(std::string_view text, Value& out, Error& error) {
    Value parsed;
    if (!detail::Parser(text).document(parsed, error))
        return false;
    out = std::move(parsed);
    return true;
}

} // namespace tn::engine::json
