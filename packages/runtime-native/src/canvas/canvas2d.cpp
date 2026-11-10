/**
 * Canvas 2D Context Implementation
 *
 * Uses Skia for hardware-accelerated 2D graphics when available.
 * Falls back to a stub implementation when Skia is not present.
 */

#include "mystral/canvas/canvas2d.h"
#include "mystral/canvas/font_backend.h"
#include <iostream>
#include <unordered_map>
#include <cmath>
#include <regex>
#include <stack>
#include <algorithm>
#include <sstream>

// M_PI is not defined by default on Windows MSVC
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#if defined(MYSTRAL_HAS_SKIA)
// Skia headers (include path is third_party/skia/build/include, headers use "include/core/..." internally)
#include "include/core/SkCanvas.h"
#include "include/core/SkSurface.h"
#include "include/core/SkPath.h"
#include "include/core/SkPathBuilder.h"  // Skia m145+ uses SkPathBuilder for path construction
#include "include/core/SkPaint.h"
#include "include/core/SkFont.h"
#include "include/core/SkFontMgr.h"
#include "include/core/SkFontMetrics.h"
#include "include/core/SkTypeface.h"
#include "include/core/SkColor.h"
#include "include/core/SkColorSpace.h"
#include "include/core/SkImageInfo.h"
#include "include/core/SkBitmap.h"
#include "include/core/SkPixmap.h"
#include "include/core/SkImage.h"
#include "include/effects/SkGradient.h"
#include "include/effects/SkDashPathEffect.h"
#include "include/utils/SkParse.h"

// Platform-specific font manager
#if defined(__APPLE__)
#include "include/ports/SkFontMgr_mac_ct.h"
#elif defined(__ANDROID__)
#include "include/ports/SkFontMgr_android.h"
#include "include/ports/SkFontScanner_FreeType.h"
#elif defined(_WIN32)
#include "include/ports/SkFontMgr_directory.h"
#else
#include "include/ports/SkFontMgr_fontconfig.h"
#include "include/ports/SkFontScanner_FreeType.h"
#endif
#endif

namespace mystral {
namespace canvas {

// ============================================================================
// Color Parsing Utilities
// ============================================================================

struct Color {
    uint8_t r = 0, g = 0, b = 0, a = 255;
};

/**
 * The numbers out of a functional CSS colour, in order, with the function's name.
 *
 * Returns false for anything that is not `name( <number> [, <number>]* )`; a trailing `%` is
 * consumed and ignored, which is what the callers want — `hsl` means percentages by position.
 */
static bool scanColorFunction(const std::string& text, std::string& name, float values[4],
                              int& count) {
    const size_t open = text.find('(');
    if (open == std::string::npos || text.empty() || text.back() != ')') return false;
    name = text.substr(0, open);
    count = 0;
    size_t cursor = open + 1;
    const size_t end = text.size() - 1;
    while (cursor < end) {
        while (cursor < end &&
               (std::isspace(static_cast<unsigned char>(text[cursor])) || text[cursor] == ',')) {
            cursor += 1;
        }
        if (cursor >= end) break;
        if (count == 4) return false;
        const char* begin = text.c_str() + cursor;
        char* stop = nullptr;
        const double value = std::strtod(begin, &stop);
        if (stop == begin) return false;
        values[count] = static_cast<float>(value);
        count += 1;
        cursor += static_cast<size_t>(stop - begin);
        if (cursor < end && text[cursor] == '%') cursor += 1;
    }
    return count > 0;
}

static Color parseColor(const std::string& colorStr, bool* valid = nullptr) {
    Color color;
    if (valid) *valid = true;

    if (colorStr.empty()) {
        if (valid) *valid = false;
        return color;
    }

    // Handle hex colors: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
    if (colorStr[0] == '#') {
        std::string hex = colorStr.substr(1);
        if ((hex.size() != 3 && hex.size() != 4 && hex.size() != 6 && hex.size() != 8) ||
            hex.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) {
            if (valid) *valid = false;
            return color;
        }
        if (hex.length() == 3) {
            // #RGB -> #RRGGBB
            color.r = std::stoi(std::string(2, hex[0]), nullptr, 16);
            color.g = std::stoi(std::string(2, hex[1]), nullptr, 16);
            color.b = std::stoi(std::string(2, hex[2]), nullptr, 16);
        } else if (hex.length() == 4) {
            // #RGBA -> #RRGGBBAA
            color.r = std::stoi(std::string(2, hex[0]), nullptr, 16);
            color.g = std::stoi(std::string(2, hex[1]), nullptr, 16);
            color.b = std::stoi(std::string(2, hex[2]), nullptr, 16);
            color.a = std::stoi(std::string(2, hex[3]), nullptr, 16);
        } else if (hex.length() == 6) {
            color.r = std::stoi(hex.substr(0, 2), nullptr, 16);
            color.g = std::stoi(hex.substr(2, 2), nullptr, 16);
            color.b = std::stoi(hex.substr(4, 2), nullptr, 16);
        } else if (hex.length() == 8) {
            color.r = std::stoi(hex.substr(0, 2), nullptr, 16);
            color.g = std::stoi(hex.substr(2, 2), nullptr, 16);
            color.b = std::stoi(hex.substr(4, 2), nullptr, 16);
            color.a = std::stoi(hex.substr(6, 2), nullptr, 16);
        }
        return color;
    }

    // `rgb(1, 2, 3)`, `rgba(1, 2, 3, 0.5)`, `hsl(210, 50%, 20%)`: a scan and a `strtod` per
    // component. The regexes these replace compiled and matched per call, on a path a page hits
    // once per painted rectangle — 20.6 us a rect on a real game, against 1.4 us here.
    std::string function;
    float values[4] = {0, 0, 0, 0};
    int componentCount = 0;
    if (scanColorFunction(colorStr, function, values, componentCount)) {
        if ((function == "rgb" || function == "rgba") && componentCount >= 3) {
            color.r = static_cast<uint8_t>(values[0]);
            color.g = static_cast<uint8_t>(values[1]);
            color.b = static_cast<uint8_t>(values[2]);
            if (componentCount >= 4) color.a = static_cast<uint8_t>(values[3] * 255);
            return color;
        }
        if ((function == "hsl" || function == "hsla") && componentCount >= 3) {
            float h = std::fmod(values[0], 360.0f);
            if (h < 0) h += 360.0f;
            float s = values[1] / 100.0f;
            float l = values[2] / 100.0f;
            float a = componentCount >= 4 ? values[3] : 1.0f;

            // HSL to RGB conversion
            float c = (1.0f - std::fabs(2.0f * l - 1.0f)) * s;
            float x = c * (1.0f - std::fabs(std::fmod(h / 60.0f, 2.0f) - 1.0f));
            float m = l - c / 2.0f;

            float r1, g1, b1;
            if (h < 60)       { r1 = c; g1 = x; b1 = 0; }
            else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
            else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
            else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
            else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
            else              { r1 = c; g1 = 0; b1 = x; }

            color.r = static_cast<uint8_t>((r1 + m) * 255);
            color.g = static_cast<uint8_t>((g1 + m) * 255);
            color.b = static_cast<uint8_t>((b1 + m) * 255);
            color.a = static_cast<uint8_t>(a * 255);
            return color;
        }
    }

    // Named colors (basic set)
    if (colorStr == "black") { color.r = 0; color.g = 0; color.b = 0; }
    else if (colorStr == "white") { color.r = 255; color.g = 255; color.b = 255; }
    else if (colorStr == "red") { color.r = 255; color.g = 0; color.b = 0; }
    else if (colorStr == "green") { color.r = 0; color.g = 128; color.b = 0; }
    else if (colorStr == "blue") { color.r = 0; color.g = 0; color.b = 255; }
    else if (colorStr == "transparent") { color.r = 0; color.g = 0; color.b = 0; color.a = 0; }
    else if (valid) *valid = false;

    return color;
}

// ============================================================================
// Font Parsing Utilities
// ============================================================================

struct FontInfo {
    float size = 16.0f;
    std::string family = "sans-serif";
    int weight = 400;
    bool italic = false;
};

static FontInfo parseFont(const std::string& fontStr) {
    FontInfo info;

    // Parse CSS font string: "italic bold 16px Arial"
    // Simplified parser - handles: [style] [weight] size[px/pt] family
    static const std::regex fontRegex(R"((?:(italic|oblique)\s+)?(?:(bold|normal|\d+)\s+)?(\d+(?:\.\d+)?)(px|pt|em)\s+(.+))");
    std::smatch match;

    if (std::regex_match(fontStr, match, fontRegex)) {
        if (match[1].matched) {
            info.italic = (match[1] == "italic" || match[1] == "oblique");
        }
        if (match[2].matched) {
            std::string weight = match[2];
            info.weight = weight == "bold" ? 700 : weight == "normal" ? 400 : std::stoi(weight);
        }
        info.size = std::stof(match[3]);
        std::string unit = match[4];
        if (unit == "pt") {
            info.size *= 1.333f;  // pt to px conversion
        } else if (unit == "em") {
            info.size *= 16.0f;  // Assume 16px base
        }
        info.family = match[5];
    } else {
        // Fallback: just try to extract size
        static const std::regex sizeRegex(R"((\d+(?:\.\d+)?)(px|pt))");
        if (std::regex_search(fontStr, match, sizeRegex)) {
            info.size = std::stof(match[1]);
        }
    }

    return info;
}

// ============================================================================
// Canvas2D State (for save/restore)
// ============================================================================

struct Canvas2DState {
    std::string fillStyle = "#000000";
    std::string strokeStyle = "#000000";
    // Parsed once where the style is set, because `makeFillPaint` runs per draw and parsing a
    // CSS colour there cost 18 us a rect on a real game — the same work repeated for every
    // rectangle the page paints, to say the same thing.
    Color fillColor{0, 0, 0, 255};
    Color strokeColor{0, 0, 0, 255};
    std::shared_ptr<CanvasGradient> fillGradient;
    std::shared_ptr<CanvasGradient> strokeGradient;
    float lineWidth = 1.0f;
    std::string lineCap = "butt";
    std::string lineJoin = "miter";
    /** Canvas dash pattern; empty means a solid line. An odd count is doubled, per spec. */
    std::vector<float> lineDash;
    float globalAlpha = 1.0f;
    std::string font = "10px sans-serif";
    std::string textAlign = "start";
    std::string textBaseline = "alphabetic";
};

bool CanvasGradient::addColorStop(float offset, const std::string& text) {
    if (!std::isfinite(offset) || offset < 0 || offset > 1) return false;
    bool parsed = false;
    Color color;
    try { color = parseColor(text, &parsed); } catch (...) { return false; }
#if defined(MYSTRAL_HAS_SKIA)
    SkColor skColor;
    const char* end = !parsed ? SkParse::FindNamedColor(text.c_str(), text.size(), &skColor) : nullptr;
    if (end && *end == '\0') {
        color = {static_cast<uint8_t>(SkColorGetR(skColor)), static_cast<uint8_t>(SkColorGetG(skColor)),
                 static_cast<uint8_t>(SkColorGetB(skColor)), static_cast<uint8_t>(SkColorGetA(skColor))};
        parsed = true;
    }
#endif
    if (!parsed) return false;
    const uint32_t rgba = (uint32_t(color.a) << 24) | (uint32_t(color.r) << 16) |
                          (uint32_t(color.g) << 8) | color.b;
    stops.push_back({offset, rgba});
    std::stable_sort(stops.begin(), stops.end(), [](const Stop& a, const Stop& b) { return a.offset < b.offset; });
    return true;
}

// ============================================================================
// Implementation
// ============================================================================

#if defined(MYSTRAL_HAS_SKIA)

/**
 * The process's font manager, built on first use.
 *
 * Building one is not per-canvas work: on Linux it reads the fontconfig configuration and builds a
 * FreeType scanner over the installed fonts, and the result is process state that every canvas
 * shares - which is how a browser holds it. Measured on Midway, which creates 65 canvases while
 * its modules load: 690 ms in total when each canvas built its own, 145 ms when they share one.
 *
 * That is 1.8% of this game's 30 s startup and it is deliberately *not* offered as the startup's
 * problem - the startup's problem is that it runs inside a single frame, which is a loader/pump
 * change. This is worth having because a font manager is process state, not because it is fast.
 * SkFontMgr lookups are thread-safe, so one instance serves every canvas on every thread.
 */
// One factory per backend. A backend that the platform's mapping (font_backend.h) picks and this
// file does not define fails to link, so the choice cannot drift without a build failing.
template <FontBackend B>
sk_sp<SkFontMgr> makeFontMgr();

#if defined(__APPLE__)
template <>
sk_sp<SkFontMgr> makeFontMgr<FontBackend::CoreText>() { return SkFontMgr_New_CoreText(nullptr); }
#elif defined(__ANDROID__)
template <>
sk_sp<SkFontMgr> makeFontMgr<FontBackend::AndroidSystem>() {
    return SkFontMgr_New_Android(nullptr, SkFontScanner_Make_FreeType());
}
#elif defined(__linux__)
template <>
sk_sp<SkFontMgr> makeFontMgr<FontBackend::FontConfig>() {
    return SkFontMgr_New_FontConfig(nullptr, SkFontScanner_Make_FreeType());
}
#endif
template <>
sk_sp<SkFontMgr> makeFontMgr<FontBackend::Empty>() { return SkFontMgr::RefEmpty(); }

sk_sp<SkFontMgr> sharedFontMgr() {
    static sk_sp<SkFontMgr> manager = makeFontMgr<fontBackendFor(kBuildFontPlatform)>();
    return manager;
}

struct Canvas2DContext::Impl {
    sk_sp<SkSurface> surface;
    SkCanvas* canvas = nullptr;  // Owned by surface
    SkPathBuilder pathBuilder;  // Skia m145+ uses SkPathBuilder for path construction
    Canvas2DState currentState;
    std::stack<Canvas2DState> stateStack;
    sk_sp<SkFontMgr> fontMgr;
    sk_sp<SkTypeface> currentTypeface;
    SkFont currentFont;
    /** The font string `currentFont` was resolved from; `updateFont` is a no-op while it matches. */
    std::string resolvedFontSpec;
    /** Resolved typefaces, keyed by the family and style that decide them. */
    std::unordered_map<std::string, sk_sp<SkTypeface>> typefaceCache;

    Impl(int width, int height) {
        // Create RGBA surface using new API (SkSurfaces namespace)
        SkImageInfo info = SkImageInfo::Make(
            width, height,
            kRGBA_8888_SkColorType,
            kPremul_SkAlphaType
        );
        surface = SkSurfaces::Raster(info);
        if (surface) {
            canvas = surface->getCanvas();
            canvas->clear(SK_ColorTRANSPARENT);
        }

        fontMgr = sharedFontMgr();
        if (fontMgr) {
            currentTypeface = fontMgr->matchFamilyStyle("sans-serif", SkFontStyle::Normal());
            if (!currentTypeface) {
                currentTypeface = fontMgr->matchFamilyStyle(nullptr, SkFontStyle::Normal());
            }
        }
        currentFont = SkFont(currentTypeface, 10.0f);
        // The default family is resolved above, so the default spec is already satisfied.
        resolvedFontSpec = currentState.font;
    }

    void resize(int width, int height) {
        SkImageInfo info = SkImageInfo::Make(
            width, height,
            kRGBA_8888_SkColorType,
            kPremul_SkAlphaType
        );
        surface = SkSurfaces::Raster(info);
        if (surface) {
            canvas = surface->getCanvas();
            canvas->clear(SK_ColorTRANSPARENT);
        }
    }

    void applyGradient(SkPaint& paint, const std::shared_ptr<CanvasGradient>& gradient) {
        if (!gradient) return;
        // A degenerate gradient paints nothing. For a radial that means both circles identical —
        // equal centres AND equal radii; concentric circles of different radii are the ordinary
        // case (`createRadialGradient(x,y,0,x,y,r)`) and must still draw.
        const bool degenerate = gradient->radial
            ? (gradient->x0 == gradient->x1 && gradient->y0 == gradient->y1 && gradient->r0 == gradient->r1)
            : (gradient->x0 == gradient->x1 && gradient->y0 == gradient->y1);
        if (gradient->stops.empty() || degenerate) {
            paint.setColor(SK_ColorTRANSPARENT);
            return;
        }
        std::vector<SkColor4f> colors;
        std::vector<SkScalar> offsets;
        for (const auto& stop : gradient->stops) {
            colors.push_back(SkColor4f::FromColor(stop.color));
            offsets.push_back(stop.offset);
        }
        if (colors.size() == 1) {
            colors.push_back(colors.front());
            offsets = {0, 1};
        }
        const SkPoint points[] = {{gradient->x0, gradient->y0}, {gradient->x1, gradient->y1}};
        paint.setColor(SK_ColorWHITE);
        paint.setAlphaf(currentState.globalAlpha);
        const SkGradient::Colors stops({colors.data(), colors.size()},
                                       {offsets.data(), offsets.size()}, SkTileMode::kClamp);
        paint.setShader(gradient->radial
            ? SkShaders::TwoPointConicalGradient(points[0], gradient->r0, points[1], gradient->r1,
                                                 SkGradient(stops, {}))
            : SkShaders::LinearGradient(points, SkGradient(stops, {})));
    }

    SkPaint makeFillPaint() {
        SkPaint paint;
        paint.setAntiAlias(true);
        paint.setStyle(SkPaint::kFill_Style);
        const Color c = currentState.fillColor;
        paint.setColor(SkColorSetARGB(
            static_cast<uint8_t>(c.a * currentState.globalAlpha),
            c.r, c.g, c.b
        ));
        applyGradient(paint, currentState.fillGradient);
        return paint;
    }

    SkPaint makeStrokePaint() {
        SkPaint paint;
        paint.setAntiAlias(true);
        paint.setStyle(SkPaint::kStroke_Style);
        paint.setStrokeWidth(currentState.lineWidth);
        paint.setStrokeCap(currentState.lineCap == "round" ? SkPaint::kRound_Cap :
                           currentState.lineCap == "square" ? SkPaint::kSquare_Cap : SkPaint::kButt_Cap);
        paint.setStrokeJoin(currentState.lineJoin == "round" ? SkPaint::kRound_Join :
                            currentState.lineJoin == "bevel" ? SkPaint::kBevel_Join : SkPaint::kMiter_Join);
        if (!currentState.lineDash.empty()) {
            // setLineDash already doubled an odd-length pattern, so this list alternates on/off.
            const std::vector<SkScalar> intervals(currentState.lineDash.begin(), currentState.lineDash.end());
            paint.setPathEffect(SkDashPathEffect::Make({intervals.data(), intervals.size()}, 0.0f));
        }
        const Color c = currentState.strokeColor;
        paint.setColor(SkColorSetARGB(
            static_cast<uint8_t>(c.a * currentState.globalAlpha),
            c.r, c.g, c.b
        ));
        applyGradient(paint, currentState.strokeGradient);
        return paint;
    }

    void updateFont() {
        // `restore()` calls this after every `save()` and `setFont()` calls it on every set, so a
        // canvas that draws text inside save/restore pairs asks for the same family hundreds of
        // times over. Each ask ran the platform's font matcher end to end — on Linux that is
        // fontconfig's FcPatternFilter — and it was the hottest stack in Midway's native startup
        // and again when a HUD redraw followed a click: the main thread sat inside
        // `SkFontMgr_fontconfig::onMatchFamilyStyle` rather than in any game or engine work, while
        // all 109 of that startup's module compiles cost 0.07 s between them.
        //
        // Comparing only the *last* spec was the first fix and it was not enough: a HUD draws its
        // labels at several sizes and weights, so the spec alternates and nearly every draw asked
        // for a family the previous draw had not. The family and its style are what the matcher
        // resolves, and a spec's size is not part of that — so the cache is keyed by family and
        // style, and a size change only rebuilds the (cheap) `SkFont` around the same typeface.
        if (resolvedFontSpec == currentState.font) return;
        resolvedFontSpec = currentState.font;
        FontInfo fi = parseFont(currentState.font);
        SkFontStyle style = SkFontStyle(
            fi.weight,
            SkFontStyle::kNormal_Width,
            fi.italic ? SkFontStyle::kItalic_Slant : SkFontStyle::kUpright_Slant
        );

        if (fontMgr) {
            const std::string cacheKey = fi.family + '\x1f' + std::to_string(fi.weight) +
                                         (fi.italic ? "\x1fi" : "\x1fn");
            const auto cached = typefaceCache.find(cacheKey);
            if (cached != typefaceCache.end()) {
                currentTypeface = cached->second;
            } else {
                currentTypeface.reset();
                std::istringstream families(fi.family);
                std::string family;
                while (std::getline(families, family, ',')) {
                    const auto first = family.find_first_not_of(" \t\"'");
                    if (first == std::string::npos) continue;
                    family = family.substr(first, family.find_last_not_of(" \t\"'") - first + 1);
                    if (family == "ui-monospace") family = "monospace";
                    else if (family == "ui-serif") family = "serif";
                    else if (family == "ui-sans-serif" || family == "system-ui") family = "sans-serif";
                    currentTypeface = fontMgr->matchFamilyStyle(family.c_str(), style);
                    if (currentTypeface) break;
                }
                if (!currentTypeface) {
                    currentTypeface = fontMgr->matchFamilyStyle("sans-serif", style);
                }
                if (!currentTypeface) {
                    currentTypeface = fontMgr->matchFamilyStyle(nullptr, style);
                }
                typefaceCache[cacheKey] = currentTypeface;
            }
        }

        currentFont = SkFont(currentTypeface, fi.size);
        currentFont.setEdging(SkFont::Edging::kSubpixelAntiAlias);
    }
};

#else  // No Skia - stub implementation

struct Canvas2DContext::Impl {
    Canvas2DState currentState;
    std::stack<Canvas2DState> stateStack;
    std::vector<uint8_t> pixelData;
    int pixelWidth = 0;
    int pixelHeight = 0;

    Impl(int width, int height) : pixelWidth(width), pixelHeight(height) {
        pixelData.resize(width * height * 4, 0);
        std::cout << "[Canvas2D] Stub implementation (no Skia)" << std::endl;
    }

    void resize(int width, int height) {
        pixelWidth = width;
        pixelHeight = height;
        pixelData.resize(width * height * 4, 0);
    }
};

#endif  // MYSTRAL_HAS_SKIA

// ============================================================================
// Canvas2DContext Public API
// ============================================================================

Canvas2DContext::Canvas2DContext(int width, int height)
    : width_(width), height_(height) {
    impl_ = std::make_unique<Impl>(width, height);
    std::cout << "[Canvas2D] Created " << width << "x" << height << " context" << std::endl;
}

Canvas2DContext::~Canvas2DContext() = default;

void Canvas2DContext::resize(int width, int height) {
    width_ = width;
    height_ = height;
    impl_->resize(width, height);
    markDirty();
}

// State Management
void Canvas2DContext::save() {
    impl_->stateStack.push(impl_->currentState);
#if defined(MYSTRAL_HAS_SKIA)
    if (impl_->canvas) {
        impl_->canvas->save();  // Save Skia canvas transform state
    }
#endif
}

void Canvas2DContext::restore() {
    if (!impl_->stateStack.empty()) {
        impl_->currentState = impl_->stateStack.top();
        impl_->stateStack.pop();
#if defined(MYSTRAL_HAS_SKIA)
        if (impl_->canvas) {
            impl_->canvas->restore();  // Restore Skia canvas transform state
        }
        impl_->updateFont();
#endif
    }
}

// Fill and Stroke Styles
void Canvas2DContext::setFillStyle(const std::string& color) {
    impl_->currentState.fillStyle = color;
    impl_->currentState.fillColor = parseColor(color);
    impl_->currentState.fillGradient.reset();
}

void Canvas2DContext::setStrokeStyle(const std::string& color) {
    impl_->currentState.strokeStyle = color;
    impl_->currentState.strokeColor = parseColor(color);
    impl_->currentState.strokeGradient.reset();
}

void Canvas2DContext::setGradient(bool stroke, std::shared_ptr<CanvasGradient> gradient) {
    (stroke ? impl_->currentState.strokeGradient : impl_->currentState.fillGradient) = std::move(gradient);
}

size_t Canvas2DContext::createLinearGradient(float x0, float y0, float x1, float y1) {
    gradients_.push_back(std::make_shared<CanvasGradient>(CanvasGradient{x0, y0, x1, y1, 0.0f, 0.0f, false, {}}));
    return gradients_.size() - 1;
}

size_t Canvas2DContext::createRadialGradient(float x0, float y0, float r0, float x1, float y1, float r1) {
    gradients_.push_back(std::make_shared<CanvasGradient>(CanvasGradient{x0, y0, x1, y1, r0, r1, true, {}}));
    return gradients_.size() - 1;
}

std::shared_ptr<CanvasGradient> Canvas2DContext::getGradient(size_t index) const {
    return index < gradients_.size() ? gradients_[index] : nullptr;
}

void Canvas2DContext::setLineWidth(float width) {
    impl_->currentState.lineWidth = width;
}

void Canvas2DContext::setLineCap(const std::string& cap) {
    if (cap == "butt" || cap == "round" || cap == "square") impl_->currentState.lineCap = cap;
}

std::string Canvas2DContext::getLineCap() const {
    return impl_->currentState.lineCap;
}

void Canvas2DContext::setLineJoin(const std::string& join) {
    if (join == "miter" || join == "round" || join == "bevel") impl_->currentState.lineJoin = join;
}

std::string Canvas2DContext::getLineJoin() const {
    return impl_->currentState.lineJoin;
}

void Canvas2DContext::setLineDash(const std::vector<float>& segments) {
    // A negative or non-finite entry makes the whole call a no-op, as the spec requires.
    for (const float segment : segments) if (!std::isfinite(segment) || segment < 0) return;
    impl_->currentState.lineDash = segments;
    // An odd-length pattern is concatenated with itself so it always alternates on and off, and
    // the doubled list is also what reads back: setLineDash({5}) gives getLineDash() {5, 5}, the
    // way a browser does. Doubling here rather than at stroke time keeps the two the same list.
    if (segments.size() % 2 == 1)
        impl_->currentState.lineDash.insert(impl_->currentState.lineDash.end(), segments.begin(), segments.end());
}

std::vector<float> Canvas2DContext::getLineDash() const {
    return impl_->currentState.lineDash;
}

void Canvas2DContext::clip() {
#if defined(MYSTRAL_HAS_SKIA)
    // save()/restore() already wrap SkCanvas::save/restore, so the clip unwinds with the state.
    if (impl_->canvas) impl_->canvas->clipPath(impl_->pathBuilder.snapshot(), SkClipOp::kIntersect, true);
#endif
}

void Canvas2DContext::setGlobalAlpha(float alpha) {
    impl_->currentState.globalAlpha = alpha;
}

std::string Canvas2DContext::getFillStyle() const {
    return impl_->currentState.fillStyle;
}

std::string Canvas2DContext::getStrokeStyle() const {
    return impl_->currentState.strokeStyle;
}

float Canvas2DContext::getLineWidth() const {
    return impl_->currentState.lineWidth;
}

float Canvas2DContext::getGlobalAlpha() const {
    return impl_->currentState.globalAlpha;
}

// Text
void Canvas2DContext::setFont(const std::string& font) {
    impl_->currentState.font = font;
#if defined(MYSTRAL_HAS_SKIA)
    impl_->updateFont();
#endif
}

void Canvas2DContext::setTextAlign(const std::string& align) {
    impl_->currentState.textAlign = align;
}

void Canvas2DContext::setTextBaseline(const std::string& baseline) {
    impl_->currentState.textBaseline = baseline;
}

std::string Canvas2DContext::getFont() const {
    return impl_->currentState.font;
}

std::string Canvas2DContext::getTextAlign() const {
    return impl_->currentState.textAlign;
}

std::string Canvas2DContext::getTextBaseline() const {
    return impl_->currentState.textBaseline;
}

void Canvas2DContext::fillText(const std::string& text, float x, float y) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;

    SkPaint paint = impl_->makeFillPaint();

    // Adjust x based on textAlign
    SkScalar textWidth = impl_->currentFont.measureText(text.c_str(), text.length(), SkTextEncoding::kUTF8);
    if (impl_->currentState.textAlign == "center") {
        x -= textWidth / 2;
    } else if (impl_->currentState.textAlign == "right" || impl_->currentState.textAlign == "end") {
        x -= textWidth;
    }

    // Adjust y based on textBaseline
    SkFontMetrics metrics;
    impl_->currentFont.getMetrics(&metrics);
    if (impl_->currentState.textBaseline == "top") {
        y -= metrics.fAscent;
    } else if (impl_->currentState.textBaseline == "middle") {
        y -= (metrics.fAscent + metrics.fDescent) / 2;
    } else if (impl_->currentState.textBaseline == "bottom") {
        y -= metrics.fDescent;
    }
    // "alphabetic" is the default - no adjustment needed

    impl_->canvas->drawString(text.c_str(), x, y, impl_->currentFont, paint);
#endif
}

void Canvas2DContext::strokeText(const std::string& text, float x, float y) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;

    SkPaint paint = impl_->makeStrokePaint();

    // Adjust x based on textAlign
    SkScalar textWidth = impl_->currentFont.measureText(text.c_str(), text.length(), SkTextEncoding::kUTF8);
    if (impl_->currentState.textAlign == "center") {
        x -= textWidth / 2;
    } else if (impl_->currentState.textAlign == "right" || impl_->currentState.textAlign == "end") {
        x -= textWidth;
    }

    // Adjust y based on textBaseline
    SkFontMetrics metrics;
    impl_->currentFont.getMetrics(&metrics);
    if (impl_->currentState.textBaseline == "top") {
        y -= metrics.fAscent;
    } else if (impl_->currentState.textBaseline == "middle") {
        y -= (metrics.fAscent + metrics.fDescent) / 2;
    } else if (impl_->currentState.textBaseline == "bottom") {
        y -= metrics.fDescent;
    }
    // "alphabetic" is the default - no adjustment needed

    impl_->canvas->drawString(text.c_str(), x, y, impl_->currentFont, paint);
#endif
}

TextMetrics Canvas2DContext::measureText(const std::string& text) {
    TextMetrics metrics;

#if defined(MYSTRAL_HAS_SKIA)
    SkRect bounds;
    metrics.width = impl_->currentFont.measureText(text.c_str(), text.length(), SkTextEncoding::kUTF8, &bounds);

    SkFontMetrics fm;
    impl_->currentFont.getMetrics(&fm);

    metrics.actualBoundingBoxLeft = -bounds.fLeft;
    metrics.actualBoundingBoxRight = bounds.fRight;
    metrics.actualBoundingBoxAscent = -bounds.fTop;
    metrics.actualBoundingBoxDescent = bounds.fBottom;
    metrics.fontBoundingBoxAscent = -fm.fAscent;
    metrics.fontBoundingBoxDescent = fm.fDescent;
#else
    // Stub: estimate width based on font size
    FontInfo fi = parseFont(impl_->currentState.font);
    metrics.width = text.length() * fi.size * 0.6f;  // Rough estimate
    metrics.fontBoundingBoxAscent = fi.size * 0.8f;
    metrics.fontBoundingBoxDescent = fi.size * 0.2f;
#endif

    return metrics;
}

// Rectangles
void Canvas2DContext::fillRect(float x, float y, float width, float height) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->drawRect(SkRect::MakeXYWH(x, y, width, height), impl_->makeFillPaint());
#endif
}

void Canvas2DContext::strokeRect(float x, float y, float width, float height) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->drawRect(SkRect::MakeXYWH(x, y, width, height), impl_->makeStrokePaint());
#endif
}

void Canvas2DContext::clearRect(float x, float y, float width, float height) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    SkPaint clearPaint;
    clearPaint.setBlendMode(SkBlendMode::kClear);
    impl_->canvas->drawRect(SkRect::MakeXYWH(x, y, width, height), clearPaint);
#else
    // Stub: clear pixel data
    int x0 = std::max(0, static_cast<int>(x));
    int y0 = std::max(0, static_cast<int>(y));
    int x1 = std::min(impl_->pixelWidth, static_cast<int>(x + width));
    int y1 = std::min(impl_->pixelHeight, static_cast<int>(y + height));
    for (int py = y0; py < y1; py++) {
        for (int px = x0; px < x1; px++) {
            int idx = (py * impl_->pixelWidth + px) * 4;
            impl_->pixelData[idx] = 0;
            impl_->pixelData[idx + 1] = 0;
            impl_->pixelData[idx + 2] = 0;
            impl_->pixelData[idx + 3] = 0;
        }
    }
#endif
}

// Paths
void Canvas2DContext::beginPath() {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder = SkPathBuilder();  // Reset path builder
#endif
}

void Canvas2DContext::closePath() {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.close();
#endif
}

void Canvas2DContext::moveTo(float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.moveTo(x, y);
#endif
}

void Canvas2DContext::lineTo(float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.lineTo(x, y);
#endif
}

void Canvas2DContext::quadraticCurveTo(float cpx, float cpy, float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.quadTo(cpx, cpy, x, y);
#endif
}

void Canvas2DContext::bezierCurveTo(float cp1x, float cp1y, float cp2x, float cp2y, float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.cubicTo(cp1x, cp1y, cp2x, cp2y, x, y);
#endif
}

void Canvas2DContext::arc(float x, float y, float radius, float startAngle, float endAngle, bool counterclockwise) {
#if defined(MYSTRAL_HAS_SKIA)
    if (radius <= 0) return;

    SkRect oval = SkRect::MakeLTRB(x - radius, y - radius, x + radius, y + radius);

    // Convert radians to degrees
    float startDeg = startAngle * 180.0f / M_PI;
    float sweepDeg = (endAngle - startAngle) * 180.0f / M_PI;

    if (counterclockwise && sweepDeg > 0) {
        sweepDeg -= 360.0f;
    } else if (!counterclockwise && sweepDeg < 0) {
        sweepDeg += 360.0f;
    }

    // For a full circle (or near-full), use addOval for better results
    if (std::fabs(sweepDeg) >= 359.9f) {
        impl_->pathBuilder.addOval(oval);
    } else {
        // For partial arcs, compute the start point and move there first
        float startRad = startAngle;
        float startX = x + radius * std::cos(startRad);
        float startY = y + radius * std::sin(startRad);

        // If path is empty, move to start point; otherwise line to it
        SkPath currentPath = impl_->pathBuilder.snapshot();
        if (currentPath.isEmpty()) {
            impl_->pathBuilder.moveTo(startX, startY);
        } else {
            impl_->pathBuilder.lineTo(startX, startY);
        }

        impl_->pathBuilder.arcTo(oval, startDeg, sweepDeg, false);
    }
#endif
}

void Canvas2DContext::arcTo(float x1, float y1, float x2, float y2, float radius) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.arcTo(SkPoint::Make(x1, y1), SkPoint::Make(x2, y2), radius);
#endif
}

void Canvas2DContext::ellipse(float x, float y, float radiusX, float radiusY, float rotation,
                              float startAngle, float endAngle, bool counterclockwise) {
#if defined(MYSTRAL_HAS_SKIA)
    for (float value : {x, y, radiusX, radiusY, rotation, startAngle, endAngle}) {
        if (!std::isfinite(value)) return;
    }
    if (radiusX < 0 || radiusY < 0) return; // The JS boundary throws IndexSizeError.
    constexpr float tau = 2.0f * M_PI;
    float sweep = endAngle - startAngle;
    if (!counterclockwise && sweep >= tau) sweep = tau;
    else if (counterclockwise && -sweep >= tau) sweep = -tau;
    else {
        sweep = std::fmod(sweep, tau);
        if (!counterclockwise && sweep < 0) sweep += tau;
        if (counterclockwise && sweep > 0) sweep -= tau;
    }

    // Build a unit arc then transform it into the rotated ellipse. addOval keeps the
    // full-circle contour intact on every native backend; arcTo treats a 360-degree
    // sweep as zero and its two-half workaround is not reliable on Android.
    const float start = std::fmod(startAngle, tau) * 180.0f / M_PI;
    const float halfSweep = sweep * 90.0f / M_PI;
    const SkRect unit = SkRect::MakeLTRB(-1, -1, 1, 1);
    SkPathBuilder arc;
    if (std::fabs(sweep) >= tau) {
        arc.addOval(unit, sweep > 0 ? SkPathDirection::kCW : SkPathDirection::kCCW);
    } else {
        arc.moveTo(std::cos(startAngle), std::sin(startAngle));
        arc.arcTo(unit, start, halfSweep, false);
        arc.arcTo(unit, start + halfSweep, halfSweep, false);
    }
    SkMatrix matrix;
    matrix.setAll(radiusX * std::cos(rotation), -radiusY * std::sin(rotation), x,
                  radiusX * std::sin(rotation), radiusY * std::cos(rotation), y, 0, 0, 1);
    impl_->pathBuilder.addPath(arc.snapshot(), matrix, SkPath::kExtend_AddPathMode);
#endif
}

void Canvas2DContext::rect(float x, float y, float width, float height) {
#if defined(MYSTRAL_HAS_SKIA)
    impl_->pathBuilder.addRect(SkRect::MakeXYWH(x, y, width, height));
#endif
}

void Canvas2DContext::fill() {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    // snapshot() returns an SkPath without consuming the builder
    impl_->canvas->drawPath(impl_->pathBuilder.snapshot(), impl_->makeFillPaint());
#endif
}

void Canvas2DContext::stroke() {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    // snapshot() returns an SkPath without consuming the builder
    impl_->canvas->drawPath(impl_->pathBuilder.snapshot(), impl_->makeStrokePaint());
#endif
}

// Transformations
void Canvas2DContext::scale(float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->scale(x, y);
#endif
}

void Canvas2DContext::rotate(float angle) {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->rotate(SkRadiansToDegrees(angle));
#endif
}

void Canvas2DContext::translate(float x, float y) {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->translate(x, y);
#endif
}

void Canvas2DContext::setTransform(float a, float b, float c, float d, float e, float f) {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    // Canvas 2D transform matrix: [a c e]
    //                             [b d f]
    //                             [0 0 1]
    // SkMatrix uses column-major format
    SkMatrix matrix;
    matrix.setAll(a, c, e, b, d, f, 0, 0, 1);
    impl_->canvas->setMatrix(matrix);
#endif
}

void Canvas2DContext::transform(float a, float b, float c, float d, float e, float f) {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    SkMatrix matrix;
    matrix.setAll(a, c, e, b, d, f, 0, 0, 1);
    impl_->canvas->concat(matrix);
#endif
}

void Canvas2DContext::resetTransform() {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;
    impl_->canvas->resetMatrix();
#endif
}

// Pixel Manipulation
ImageData Canvas2DContext::getImageData(int x, int y, int width, int height) {
    ImageData data;
    data.width = width;
    data.height = height;
    data.data.resize(width * height * 4);

#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->surface) return data;

    SkImageInfo info = SkImageInfo::Make(width, height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    impl_->surface->readPixels(info, data.data.data(), width * 4, x, y);
#else
    // Stub: return pixel data from our buffer
    for (int py = 0; py < height; py++) {
        for (int px = 0; px < width; px++) {
            int srcX = x + px;
            int srcY = y + py;
            if (srcX >= 0 && srcX < impl_->pixelWidth && srcY >= 0 && srcY < impl_->pixelHeight) {
                int srcIdx = (srcY * impl_->pixelWidth + srcX) * 4;
                int dstIdx = (py * width + px) * 4;
                data.data[dstIdx] = impl_->pixelData[srcIdx];
                data.data[dstIdx + 1] = impl_->pixelData[srcIdx + 1];
                data.data[dstIdx + 2] = impl_->pixelData[srcIdx + 2];
                data.data[dstIdx + 3] = impl_->pixelData[srcIdx + 3];
            }
        }
    }
#endif

    return data;
}

void Canvas2DContext::putImageData(const ImageData& imageData, int x, int y) {
    markDirty();
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->canvas) return;

    SkImageInfo info = SkImageInfo::Make(imageData.width, imageData.height, kRGBA_8888_SkColorType, kUnpremul_SkAlphaType);
    SkBitmap bitmap;
    bitmap.installPixels(info, const_cast<uint8_t*>(imageData.data.data()), imageData.width * 4);

    impl_->canvas->drawImage(bitmap.asImage(), x, y);
#endif
}

const uint8_t* Canvas2DContext::getPixelData() const {
#if defined(MYSTRAL_HAS_SKIA)
    if (!impl_->surface) return nullptr;

    // For raster surfaces, we can directly peek at the pixels
    SkPixmap pixmap;
    if (impl_->surface->peekPixels(&pixmap)) {
        return static_cast<const uint8_t*>(pixmap.addr());
    }
    return nullptr;
#else
    return impl_->pixelData.data();
#endif
}

size_t Canvas2DContext::getPixelDataSize() const {
    return width_ * height_ * 4;
}

}  // namespace canvas
}  // namespace mystral
