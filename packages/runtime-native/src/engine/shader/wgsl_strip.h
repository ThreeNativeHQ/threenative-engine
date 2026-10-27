#pragma once

#include <cstddef>
#include <string_view>

namespace tn::engine {

// Compile-time strip of an embedded WGSL source: `//` comments, indentation, runs of blanks and blanks beside `{}(),;=:`
// go; newlines stay, so a compiler message keeps its source line. The raw literal is read only by the constant
// evaluator, so the web engine's 4 MiB budget pays for the stripped copy alone and a shader keeps its comments.
constexpr bool wgslPunct(char c) { return c == '{' || c == '}' || c == '(' || c == ')' || c == ',' || c == ';' || c == '=' || c == ':'; }

// Writes the stripped text to `out` (nullptr counts only) and returns its length.
constexpr std::size_t wgslStripInto(std::string_view in, char* out) {
    std::size_t n = 0;
    bool blank = false;
    char last = '\n';
    const auto put = [&](char c) {
        if (out) out[n] = c;
        ++n;
        last = c;
    };
    for (std::size_t i = 0; i < in.size(); ++i) {
        const char c = in[i];
        if (c == '/' && i + 1 < in.size() && in[i + 1] == '/') {
            while (i + 1 < in.size() && in[i + 1] != '\n') ++i;
            continue;
        }
        if (c == ' ' || c == '\t') {
            blank = true;
            continue;
        }
        if (c == '\n') {
            blank = false;
            put(c);
            continue;
        }
        if (blank && last != '\n' && !wgslPunct(last) && !wgslPunct(c)) put(' ');
        blank = false;
        put(c);
    }
    return n;
}

constexpr std::size_t wgslStripLength(std::string_view in) { return wgslStripInto(in, nullptr); }

template <std::size_t N>
struct WgslStripped {
    char text[N + 1];
};

template <std::size_t N>
constexpr WgslStripped<N> wgslStrip(std::string_view in) {
    WgslStripped<N> stripped{};
    wgslStripInto(in, stripped.text);
    return stripped;
}

}  // namespace tn::engine

// A namespace-level shader: `TN_WGSL_STRIPPED(kName, R"WGSL(...)WGSL");` declares `constexpr const char* kName`.
#define TN_WGSL_STRIPPED(name, source)                                                                          \
    constexpr std::string_view name##Source = source;                                                            \
    constexpr auto name##Stripped = ::tn::engine::wgslStrip<::tn::engine::wgslStripLength(name##Source)>(name##Source); \
    constexpr const char* name = name##Stripped.text
