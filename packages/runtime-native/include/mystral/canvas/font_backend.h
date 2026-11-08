#pragma once

namespace mystral::canvas {

enum class FontPlatform { Apple, Android, Linux, Other };
enum class FontBackend { CoreText, AndroidSystem, FontConfig, Empty };

// Which font manager each platform builds. Android reads the system font directory: Fontconfig
// finds nothing there and the empty manager resolves no face, so canvas text would not draw.
constexpr FontBackend fontBackendFor(FontPlatform platform) {
    switch (platform) {
        case FontPlatform::Apple: return FontBackend::CoreText;
        case FontPlatform::Android: return FontBackend::AndroidSystem;
        case FontPlatform::Linux: return FontBackend::FontConfig;
        default: return FontBackend::Empty;
    }
}

#if defined(__APPLE__)
constexpr FontPlatform kBuildFontPlatform = FontPlatform::Apple;
#elif defined(__ANDROID__)
constexpr FontPlatform kBuildFontPlatform = FontPlatform::Android;
#elif defined(__linux__)
constexpr FontPlatform kBuildFontPlatform = FontPlatform::Linux;
#else
constexpr FontPlatform kBuildFontPlatform = FontPlatform::Other;
#endif

// A change to the mapping above fails the Android build here, before any test runs on a device.
#if defined(__ANDROID__)
static_assert(fontBackendFor(kBuildFontPlatform) == FontBackend::AndroidSystem,
              "Android canvas text needs the Android system font manager");
#endif

}  // namespace mystral::canvas
