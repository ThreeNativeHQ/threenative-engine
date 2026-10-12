#!/usr/bin/env node

/**
 * Download prebuilt dependencies for Mystral Native Runtime
 *
 * Usage:
 *   node scripts/download-deps.mjs              # Download desktop deps for current platform
 *   node scripts/download-deps.mjs --ios        # Download iOS deps (macOS only)
 *   node scripts/download-deps.mjs --android    # Download Android deps
 *   node scripts/download-deps.mjs --android --backend dawn  # Check the local Dawn arm64 spike drop
 *   node scripts/download-deps.mjs --all        # Download everything (desktop + iOS + Android)
 *   node scripts/download-deps.mjs --only wgpu  # Download only wgpu-native
 *   node scripts/download-deps.mjs --only skia-ios  # Download only iOS Skia
 *   node scripts/download-deps.mjs --rebuild-wgpu-cache-api  # Rebuild patched wgpu-native from source
 *   node scripts/download-deps.mjs --force      # Re-download even if exists
 *
 * Desktop deps: wgpu, sdl3, dawn, v8, quickjs, stb, cgltf, webp, webp-source, skia, swc
 * iOS deps: wgpu-ios, skia-ios, webp-source (for cross-compilation from macOS)
 * Android deps: sdl3 (Java glue), wgpu-android, sdl3-android, webp-source
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, createWriteStream, rmSync, readdirSync, statSync, copyFileSync, readFileSync, writeFileSync, mkdtempSync, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, dirname, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { SDL3_ANDROID_VERSION } from './package-android.mjs';
import { SDL3_IOS_VERSION } from './package-ios.mjs';
import { provisionAndroidV8 } from './build-android-v8.mjs';
import { assertAndroid16KbAlignment } from './check-android-16kb-alignment.mjs';
import { resolveWgpuCacheToolchain } from './wgpu-cache-toolchain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const THIRD_PARTY = join(ROOT, 'third_party');
const NATIVE_DEPS_LOCK_PATH = join(ROOT, 'native-deps.lock.json');
const LOCK_RECEIPT_DIRNAME = '.threenative-receipts';
const REPO_ROOT = join(ROOT, '..', '..');
const GRADLE_WRAPPER = join(ROOT, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar');
const GRADLE_WRAPPER_URL = 'https://raw.githubusercontent.com/gradle/gradle/v8.13.0/gradle/wrapper/gradle-wrapper.jar';
const GRADLE_WRAPPER_SHA256 = '81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f';

// Detect platform
const PLATFORM = process.platform; // 'darwin', 'win32', 'linux'
const ARCH = process.arch; // 'x64', 'arm64'

const PLATFORM_MAP = {
  darwin: 'macos',
  win32: 'windows',
  linux: 'linux',
};

const ARCH_MAP = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

const platformName = PLATFORM_MAP[PLATFORM] || PLATFORM;
const archName = ARCH_MAP[ARCH] || ARCH;

export const DEFAULT_WGPU_VERSION = 'v25.0.2.2';
export const WGPU_REGRESSION_VERSIONS = Object.freeze(['v24.0.3.1', DEFAULT_WGPU_VERSION]);
export const DAWN_ANDROID_COMMIT = 'd14ae3d97ad74100e9f382efef5e9c0872ddbeb2';
export const DAWN_ANDROID_ARCHIVE_NAME =
  `Dawn-${DAWN_ANDROID_COMMIT}-android-arm64-v8a-Release.tar.gz`;
export const WGPU_CACHE_SOURCE_URL =
  `https://github.com/gfx-rs/wgpu-native/archive/refs/tags/${DEFAULT_WGPU_VERSION}.tar.gz`;
export const WGPU_CACHE_SOURCE_ARCHIVE_NAME = `wgpu-native-${DEFAULT_WGPU_VERSION}.tar.gz`;
export const WGPU_CACHE_SOURCE_ARCHIVE_SHA256 =
  'cdee831cd5ca39c5f6df6a4dc556b8eb6c2f9c291c07d4f87926d264ad038b5a';
export const WGPU_CACHE_HEADER_SHA256 =
  'a6fccf7f9f2fa674d1adfe4f6ea89784a876395b2307bfc2b06f2e77cf6cf356';
const WGPU_CACHE_LOCAL_ARCHIVE = join(
  REPO_ROOT,
  'artifacts',
  'startup-measure-reduce',
  'pipeline-cache-spike',
  WGPU_CACHE_SOURCE_ARCHIVE_NAME,
);
const WGPU_CACHE_PATCH_PATH = join(REPO_ROOT, 'patches', 'wgpu-native@25.0.2.2.patch');
const WGPU_DEPS = new Set(['wgpu', 'wgpu-ios', 'wgpu-android']);
let wgpuVersionOverride = null;

// Dependency versions and URLs
const DEPS = {
  wgpu: {
    version: DEFAULT_WGPU_VERSION,
    getUrl: () => {
      // wgpu-native releases: https://github.com/gfx-rs/wgpu-native/releases
      // Windows releases include toolchain suffix: wgpu-windows-x86_64-msvc-release.zip
      // Asset arches are aarch64/x86_64 (the ARCH_MAP names, not raw ARCH).
      const platform = platformName === 'macos' ? 'macos' : platformName;
      const arch = archName;
      if (platformName === 'windows') {
        return `https://github.com/gfx-rs/wgpu-native/releases/download/${DEPS.wgpu.version}/wgpu-${platform}-${arch}-msvc-release.zip`;
      }
      return `https://github.com/gfx-rs/wgpu-native/releases/download/${DEPS.wgpu.version}/wgpu-${platform}-${arch}-release.zip`;
    },
    extractTo: 'wgpu',
    cacheApiPatch: WGPU_CACHE_PATCH_PATH,
  },
  'wgpu-ios': {
    // wgpu-native iOS builds for cross-compilation from macOS
    // Downloads both device (arm64) and simulator (arm64 + x86_64) builds
    version: DEFAULT_WGPU_VERSION,
    getUrl: () => {
      // This is a special multi-file download - handled separately
      return null;
    },
    extractTo: 'wgpu-ios',
    // Individual archive URLs for iOS
    archives: {
      device: `https://github.com/gfx-rs/wgpu-native/releases/download/${DEFAULT_WGPU_VERSION}/wgpu-ios-aarch64-release.zip`,
      simulatorArm64: `https://github.com/gfx-rs/wgpu-native/releases/download/${DEFAULT_WGPU_VERSION}/wgpu-ios-aarch64-simulator-release.zip`,
      simulatorX64: `https://github.com/gfx-rs/wgpu-native/releases/download/${DEFAULT_WGPU_VERSION}/wgpu-ios-x86_64-simulator-release.zip`,
    },
  },
  sdl3: {
    // SDL3 source - we build it statically for all platforms to get a single binary
    //
    // Kept on the same version as the Android AAR above. Android takes its native library from
    // that AAR and its SDL Java classes from this tarball's `android-project`, so a skew between
    // the two is a Java layer talking to a runtime it was not built against.
    version: SDL3_ANDROID_VERSION,
    getUrl: () => {
      // Always download source tarball - we build it statically
      return `https://github.com/libsdl-org/SDL/releases/download/release-${DEPS.sdl3.version}/SDL3-${DEPS.sdl3.version}.tar.gz`;
    },
    extractTo: 'sdl3',
  },
  'sdl3-ios': {
    // SDL3 source for iOS ONLY. Upstream 3.4.16 ships SDLUIKitSceneDelegate, which owns
    // startup/lifecycle/window attachment on iOS 13+ (TN3187 scene opt-in). Desktop and
    // Android stay on DEPS.sdl3 / sdl3-android at 3.2.30 with the matching Android Java/AAR.
    version: SDL3_IOS_VERSION,
    getUrl: () => {
      return `https://github.com/libsdl-org/SDL/releases/download/release-${DEPS['sdl3-ios'].version}/SDL3-${DEPS['sdl3-ios'].version}.tar.gz`;
    },
    extractTo: 'sdl3-ios',
  },
  dawn: {
    // Dawn prebuilts from official releases: https://github.com/google/dawn/releases
    // Naming: Dawn-{commit}-{platform}-Release.tar.gz
    // Headers: dawn-headers-{commit}.tar.gz
    //
    // Note: Windows Dawn prebuilts use /MD (dynamic CRT), which conflicts with
    // Skia's /MT (static CRT). See Skia section for workaround details.
    //
    version: 'v20260117.152313',
    commit: DAWN_ANDROID_COMMIT,
    getUrl: () => {
      // Dawn releases have platform-specific binaries and separate headers
      const commit = DEPS.dawn.commit;
      if (platformName === 'macos') {
        // macos-latest = arm64, macos-15-intel = x64
        const variant = ARCH === 'arm64' ? 'macos-latest' : 'macos-15-intel';
        return `https://github.com/google/dawn/releases/download/${DEPS.dawn.version}/Dawn-${commit}-${variant}-Release.tar.gz`;
      }if (platformName === 'linux') {
        return `https://github.com/google/dawn/releases/download/${DEPS.dawn.version}/Dawn-${commit}-ubuntu-latest-Release.tar.gz`;
      }if (platformName === 'windows') {
        return `https://github.com/google/dawn/releases/download/${DEPS.dawn.version}/Dawn-${commit}-windows-latest-Release.tar.gz`;
      }
      console.warn(`Dawn prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    getHeadersUrl: () => {
      const commit = DEPS.dawn.commit;
      return `https://github.com/google/dawn/releases/download/${DEPS.dawn.version}/dawn-headers-${commit}.tar.gz`;
    },
    extractTo: 'dawn',
    needsHeaders: true,
  },
  v8: {
    // V8 prebuilts from kuoruan/libv8 (see docs/V8_PREBUILTS.md for fork info)
    // https://github.com/kuoruan/libv8/releases
    version: 'v13.1.201.22',
    getUrl: () => {
      // Platform mapping for kuoruan/libv8 releases
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x64';
        return `https://github.com/kuoruan/libv8/releases/download/${DEPS.v8.version}/v8_macOS_${arch}.tar.xz`;
      }if (platformName === 'linux') {
        // Only x64 available for Linux
        return `https://github.com/kuoruan/libv8/releases/download/${DEPS.v8.version}/v8_Linux_x64.tar.xz`;
      }if (platformName === 'windows') {
        // Only x64 available for Windows (7z format)
        return `https://github.com/kuoruan/libv8/releases/download/${DEPS.v8.version}/v8_Windows_x64.7z`;
      }
      console.warn(`V8 prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'v8',
    // Library names differ by platform
    libName: platformName === 'windows' ? 'v8_monolith.lib' : 'libv8_monolith.a',
  },
  quickjs: {
    // quickjs-ng - actively maintained fork with MSVC/Windows support
    version: '0.11.0',
    getUrl: () => {
      // QuickJS-NG source from GitHub
      return `https://github.com/quickjs-ng/quickjs/archive/refs/tags/v${DEPS.quickjs.version}.zip`;
    },
    extractTo: 'quickjs',
  },
  quiche: {
    // Cloudflare quiche - QUIC + HTTP/3 (native backend for the WebTransport API).
    // Prebuilt static libs (libquiche.a / quiche.lib + patched quiche.h, BoringSSL
    // bundled) come from mystralengine/library-builder, exactly like libuv/swc.
    // The library is built there (build-quiche.py + build-quiche.yml) so the engine
    // repo never compiles Rust/BoringSSL itself. If no prebuilt exists for this
    // platform/arch, the C++ build compiles a WebTransport stub (MYSTRAL_HAS_QUICHE off).
    // https://github.com/mystralengine/library-builder/releases
    version: 'quiche-0.24.6-3',
    getUrl: () => {
      const baseUrl = 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3';
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
        return `${baseUrl}/quiche-mac-${arch}.zip`;
      }if (platformName === 'linux') {
        if (ARCH !== 'x64') {
          console.warn(`quiche prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/quiche-linux-x64.zip`;
      }if (platformName === 'windows') {
        if (ARCH !== 'x64') {
          console.warn(`quiche prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/quiche-win-x64.zip`;
      }
      console.warn(`quiche prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'quiche',
  },
  'quiche-ios': {
    // quiche (QUIC + HTTP/3) iOS prebuilts from library-builder.
    // device (arm64) + simulator (arm64 + x86_64). Each archive contains
    // libquiche.a + include/quiche.h. Extracts to third_party/quiche-ios/<variant>/.
    // https://github.com/mystralengine/library-builder/releases
    version: 'quiche-0.24.6-3',
    getUrl: () => null, // multi-archive, handled by downloadIosDep
    extractTo: 'quiche-ios',
    archives: {
      device: 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3/quiche-ios-arm64.zip',
      simulatorX64: 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3/quiche-ios-sim-x64.zip',
      // NOTE: arm64 simulator (simulatorArm64) is temporarily unavailable — the
      // BoringSSL arm64 asm cross-compiles for device, not the simulator. See
      // docs/realtimecommunication.md. Device arm64 + x86_64 simulator are shipped.
    },
  },
  'quiche-android': {
    // quiche (QUIC + HTTP/3) Android prebuilts from library-builder.
    // arm64-v8a + armeabi-v7a + x86_64. Each archive contains libquiche.a +
    // include/quiche.h. Extracts to third_party/quiche-android/<variant>/.
    // https://github.com/mystralengine/library-builder/releases
    version: 'quiche-0.24.6-3',
    getUrl: () => null, // multi-archive, handled by downloadIosDep
    extractTo: 'quiche-android',
    archives: {
      aarch64: 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3/quiche-android-arm64.zip',
      armv7: 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3/quiche-android-armv7.zip',
      x86_64: 'https://github.com/mystralengine/library-builder/releases/download/quiche-0.24.6-3/quiche-android-x64.zip',
    },
  },
  stb: {
    // stb single-header libraries from nothings/stb
    version: 'master',
    // stb doesn't use archives - we download individual headers
    getUrl: () => null,  // Special handling below
    headerUrl: (header) => `https://raw.githubusercontent.com/nothings/stb/master/${header}`,
    extractTo: 'stb',
    headers: [
      'stb_image.h',
      'stb_image_write.h',
      // Ogg Vorbis decode for `decodeAudioData`. The runtime carried no Vorbis decoder at all —
      // `decodeAudioFile` was one call to `SDL_LoadWAV_IO` — so every native target rejected the
      // `.ogg` files the web half of the same source plays, and an APK built from a repository's
      // own assets died at startup. `stb_vorbis.c` follows the same vendored single-file precedent
      // as stb_image above; `src/audio/vorbis_impl.c` is the one translation unit that compiles it.
      'stb_vorbis.c',
    ],
  },
  cgltf: {
    // cgltf parses glTF/GLB for the native engine's loader (PRD-515); parsing only, construction
    // is owned code. One header, pinned to a release tag.
    version: '1.15',
    getUrl: () => null,
    headerUrl: (header) => `https://raw.githubusercontent.com/jkuhlmann/cgltf/v1.15/${header}`,
    extractTo: 'cgltf',
    headers: ['cgltf.h'],
  },
  webp: {
    // libwebp for WebP image decoding (used by GLTF EXT_texture_webp extension)
    // https://developers.google.com/speed/webp/download
    version: '1.5.0',
    getUrl: () => {
      const version = DEPS.webp.version;
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x86-64';
        return `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${version}-mac-${arch}.tar.gz`;
      }if (platformName === 'linux') {
        return `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${version}-linux-x86-64.tar.gz`;
      }if (platformName === 'windows') {
        return `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${version}-windows-x64.zip`;
      }
      console.warn(`libwebp prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'webp',
  },
  'webp-source': {
    // libwebp upstream source, for platforms with no prebuilt release (Android,
    // iOS) and for the native engine's glTF loader on every platform (NativeEngineCore.cmake
    // builds it once). Games embed WebP textures in glTF (EXT_texture_webp); without this a
    // native build silently reports "WebP format support: NO" and GLTFLoader
    // drops every model texture, which renders as untextured white meshes.
    // The runtime's CMakeLists builds the extracted tree with the cross toolchain.
    // Same release line as the desktop prebuilts above; kept as a literal because
    // DEPS cannot reference itself during construction.
    version: '1.5.0',
    getUrl: () => {
      return `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${DEPS['webp-source'].version}.tar.gz`;
    },
    // Its own directory, not webp/: the skip-if-exists guard is per destination,
    // so sharing one would make whichever dep extracts first block the other.
    extractTo: 'webp-source',
  },
  skia: {
    // Skia 2D graphics library for Canvas 2D implementation
    // https://github.com/olilarkin/skia-builder/releases - Modern Skia builds (chrome/m145)
    //
    // Previously used Aseprite's builds (m124) but they were ~8k commits behind.
    // olilarkin/skia-builder provides up-to-date builds for all platforms including iOS.
    //
    // Directory structure after extraction:
    //   skia/build/include/include/core/SkPath.h etc.
    //   skia/build/{platform}-gpu/lib/Release/libskia.a
    //
    // Note: m145 uses SkPathBuilder instead of direct SkPath mutation.
    //
    version: 'chrome/m145',
    getUrl: () => {
      const baseUrl = 'https://github.com/olilarkin/skia-builder/releases/download/chrome%2Fm145';
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
        return `${baseUrl}/skia-build-mac-${arch}-gpu-release.zip`;
      }if (platformName === 'linux') {
        return `${baseUrl}/skia-build-linux-x64-gpu-release.zip`;
      }if (platformName === 'windows') {
        return `${baseUrl}/skia-build-win-x64-gpu-release.zip`;
      }
      console.warn(`Skia prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'skia',
  },
  swc: {
    version: 'swc-11',
    getUrl: () => {
      const baseUrl = 'https://github.com/mystralengine/library-builder/releases/download/swc-11';
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
        return `${baseUrl}/swc-mac-${arch}.zip`;
      }if (platformName === 'linux') {
        if (ARCH !== 'x64') {
          console.warn(`SWC prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/swc-linux-x64.zip`;
      }if (platformName === 'windows') {
        if (ARCH !== 'x64') {
          console.warn(`SWC prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/swc-win-x64.zip`;
      }
      console.warn(`SWC prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'swc',
  },
  libuv: {
    // libuv - async I/O library (used by Node.js)
    // For non-blocking HTTP, file I/O, and timers
    // https://github.com/mystralengine/library-builder/releases
    version: 'libuv-1.51.0-5',
    getUrl: () => {
      const baseUrl = 'https://github.com/mystralengine/library-builder/releases/download/libuv-1.51.0-5';
      if (platformName === 'macos') {
        const arch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
        return `${baseUrl}/libuv-mac-${arch}.zip`;
      }if (platformName === 'linux') {
        if (ARCH !== 'x64') {
          console.warn(`libuv prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/libuv-linux-x64.zip`;
      }if (platformName === 'windows') {
        if (ARCH !== 'x64') {
          console.warn(`libuv prebuilts not available for ${platformName}-${archName}`);
          return null;
        }
        return `${baseUrl}/libuv-win-x64.zip`;
      }
      console.warn(`libuv prebuilts not available for ${platformName}-${archName}`);
      return null;
    },
    extractTo: 'libuv',
  },
  'libuv-source': {
    // libuv upstream source, matching the prebuilt's 1.51.0. Consumed wherever the prebuilt cannot
    // be used: under AddressSanitizer (which cannot instrument inside the prebuilt libuv.a, so a
    // write-after-free on libuv's own closing list is invisible to the lane that exists to catch
    // exactly that - PRD-177 and PRD-184 are parked on this), and on Linux arm64, which has no
    // arm64 prebuilt. The source is architecture-independent, so one payload serves both.
    version: '1.51.0',
    getUrl: () => `https://github.com/libuv/libuv/archive/refs/tags/v${DEPS['libuv-source'].version}.tar.gz`,
    extractTo: 'libuv-src',
  },
  openriglogic: {
    // OpenRigLogic (RigLogic) source for TN_ENABLE_METAHUMAN, pinned to the commit rather than
    // to the 5.8 branch so the archive can never move under a review. codeload answers a commit
    // archive directly instead of redirecting, which is what the lock wants; the commit has to be
    // the last path segment, so the default archive naming (the URL's last segment) would produce
    // an extensionless file no extractor recognises, hence the explicit archiveName. GitHub
    // names the extracted directory `OpenRigLogic-<full revision>`, and CMakeLists.txt reads the
    // revision back out of that name rather than carrying a second copy of the pin.
    // `packages/metahuman/scripts/openriglogic.mjs` carries the same commit constant for the
    // browser WASM lane; keep the two in step.
    version: '7b9e7a88898f51f29aa308acb4877276f27e1507',
    getUrl: () => `https://codeload.github.com/EpicGames/OpenRigLogic/tar.gz/${DEPS.openriglogic.version}`,
    archiveName: 'openriglogic-7b9e7a88898f51f29aa308acb4877276f27e1507.tar.gz',
    extractTo: 'openriglogic',
  },
  'skia-win-static': {
    // Static Skia + Dawn for Windows from mystralengine/library-builder
    // This build uses /MT (static CRT) and includes dawn_combined.lib with
    // full D3D11/D3D12 WebGPU implementation (not just proc stubs)
    // Use this for Windows Dawn builds to avoid CRT mismatch with Skia
    // https://github.com/mystralengine/library-builder/releases
    version: 'skia-win-dawn-v1',
    getUrl: () => {
      if (platformName !== 'windows') {
        console.warn('skia-win-static is only for Windows');
        return null;
      }
      // Download from library-builder - includes Skia + Dawn with D3D11/D3D12 backends
      return 'https://github.com/mystralengine/library-builder/releases/download/skia-win-dawn-v1/skia-build-win-x64-static-gpu-release.zip';
    },
    extractTo: 'skia',  // Extract to same place as regular skia
  },
  'skia-ios': {
    // Skia for iOS from olilarkin/skia-builder
    // https://github.com/olilarkin/skia-builder/releases
    //
    // This is a more up-to-date Skia build (chrome/m145) that includes:
    // - iOS device (arm64)
    // - iOS simulator (arm64 + x86_64 universal)
    // - Dawn support via Metal backend
    //
    // Use this for iOS builds until mystralengine/library-builder is ready.
    //
    version: 'chrome/m145',
    getUrl: () => {
      // Multi-file download - handled separately
      return null;
    },
    extractTo: 'skia-ios',
    archives: {
      device: "https://github.com/olilarkin/skia-builder/releases/download/chrome%2Fm145/skia-build-ios-device-arm64-gpu-release.zip",
      simulator: "https://github.com/olilarkin/skia-builder/releases/download/chrome%2Fm145/skia-build-ios-simulator-arm64-x86_64-gpu-release.zip",
    },
  },
  // ============================================================================
  // Android Dependencies
  // ============================================================================
  'wgpu-android': {
    // wgpu-native Android builds for cross-compilation
    // Downloads aarch64 (ARM64) and x86_64 (emulator) builds
    version: 'v25.0.2.2',
    getUrl: () => {
      // Multi-file download - handled separately
      return null;
    },
    extractTo: 'wgpu-android',
    archives: {
      aarch64: `https://github.com/gfx-rs/wgpu-native/releases/download/${DEFAULT_WGPU_VERSION}/wgpu-android-aarch64-release.zip`,
      x86_64: `https://github.com/gfx-rs/wgpu-native/releases/download/${DEFAULT_WGPU_VERSION}/wgpu-android-x86_64-release.zip`,
    },
  },
  'v8-android': {
    // Owned source and toolchain revisions replace the historical 4 KB-only archive.
    // The builder validates every cached library, header and ABI-specific snapshot before reuse.
    // Upstream build-script distribution revision; the V8 commit and recipe are pinned in the builder.
    version: '11.110.1',
    extractTo: 'v8-android',
  },
  'sdl3-android': {
    // SDL3 Android development package
    // Contains AAR with prefab structure for CMake integration
    //
    // 3.2.30 rather than 3.2.8 for one reason: its 64-bit libraries are linked with 16 KB LOAD
    // alignment, and 3.2.8's are not. Android 15 and later can run with 16 KB memory pages, where
    // a 4 KB-aligned library cannot be loaded — the system warns about it on 4 KB devices with a
    // modal dialog over the game naming each offending library. Same minor line, so this is a
    // patch bump and not an SDL migration.
    version: SDL3_ANDROID_VERSION,
    getUrl: () => {
      return `https://github.com/libsdl-org/SDL/releases/download/release-${DEPS['sdl3-android'].version}/SDL3-devel-${DEPS['sdl3-android'].version}-android.zip`;
    },
    sha256: '0525e4bc9cc1370e6d664ec93c927846e311c19a819de05a232bca452b0e3a7a',
    extractTo: 'sdl3-android',
    // Need to extract the AAR to get prefab structure
    needsAarExtraction: true,
  },
};

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function normalizeWebgpuBackend(value) {
  if (!['auto', 'dawn', 'wgpu'].includes(value)) {
    throw new Error(`TN_WEBGPU_BACKEND_INVALID: expected auto, dawn, or wgpu; received ${value}`);
  }
  return value;
}

export function dawnAndroidArchivePath(thirdPartyRoot = THIRD_PARTY) {
  return join(thirdPartyRoot, 'dawn-android', DAWN_ANDROID_ARCHIVE_NAME);
}

export function assertDawnAndroidArchive(thirdPartyRoot = THIRD_PARTY) {
  const archive = dawnAndroidArchivePath(thirdPartyRoot);
  if (!existsSync(archive)) {
    throw new Error(
      `TN_DAWN_ANDROID_ARCHIVE_MISSING: ${archive}; build Dawn ${DAWN_ANDROID_COMMIT} for arm64-v8a and place the archive beside its extracted include/ and lib/ directories`,
    );
  }
  return archive;
}

export function normalizeWgpuVersion(value) {
  if (!WGPU_REGRESSION_VERSIONS.includes(value)) {
    throw new Error(
      `Unsupported --wgpu-version ${value}; supported regression versions: ${WGPU_REGRESSION_VERSIONS.join(', ')}`,
    );
  }
  return value;
}

export function wgpuOverrideRoot(version, dependency) {
  if (!WGPU_DEPS.has(dependency)) throw new Error(`${dependency} is not a wgpu-native dependency`);
  const normalized = normalizeWgpuVersion(version);
  return join(ROOT, '.runtime', 'wgpu-version-matrix', normalized, DEPS[dependency].extractTo);
}

function configureWgpuOverride(version) {
  wgpuVersionOverride = normalizeWgpuVersion(version);
  for (const name of WGPU_DEPS) {
    const dep = DEPS[name];
    dep.version = wgpuVersionOverride;
    if (dep.archives) {
      dep.archives = Object.fromEntries(
        Object.entries(dep.archives).map(([variant, url]) => [
          variant,
          url.replace(`/download/${DEFAULT_WGPU_VERSION}/`, `/download/${wgpuVersionOverride}/`),
        ]),
      );
    }
  }
}

function destinationFor(name, dep) {
  return wgpuVersionOverride && WGPU_DEPS.has(name)
    ? wgpuOverrideRoot(wgpuVersionOverride, name)
    : join(THIRD_PARTY, dep.extractTo);
}

function findFilesRecursive(rootDir, predicate, found = []) {
  for (const entry of readdirSync(rootDir)) {
    const fullPath = join(rootDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) findFilesRecursive(fullPath, predicate, found);
    else if (predicate(entry, fullPath)) found.push(fullPath);
  }
  return found;
}

export function inspectWgpuInstallation(name, destDir, expectedVersion) {
  if (!WGPU_DEPS.has(name)) throw new Error(`${name} is not a wgpu-native dependency`);
  if (!existsSync(destDir)) throw new Error(`${name} is missing at ${destDir}`);
  const tagFiles = findFilesRecursive(destDir, (entry) => entry === 'wgpu-native-git-tag').sort();
  const expectedArtifacts = DEPS[name].archives ? Object.keys(DEPS[name].archives).length : 1;
  if (tagFiles.length !== expectedArtifacts) {
    throw new Error(
      `${name} must contain ${expectedArtifacts} wgpu-native-git-tag file(s), found ${tagFiles.length} at ${destDir}`,
    );
  }
  const tags = tagFiles.map((path) => readFileSync(path, 'utf8').trim());
  const mismatches = tags.filter((tag) => tag !== expectedVersion);
  if (mismatches.length > 0) {
    throw new Error(`${name} version mismatch at ${destDir}: expected ${expectedVersion}, found ${[...new Set(tags)].join(', ')}`);
  }
  const libraryNames = new Set([
    'libwgpu_native.a',
    'libwgpu_native.so',
    'libwgpu_native.dylib',
    'wgpu_native.dll',
    'wgpu_native.dll.lib',
    'wgpu_native.lib',
  ]);
  const libraries = findFilesRecursive(destDir, (entry) => libraryNames.has(entry)).sort();
  if (libraries.length < expectedArtifacts) {
    throw new Error(`${name} must contain at least ${expectedArtifacts} wgpu-native library artifact(s), found ${libraries.length}`);
  }
  return {
    schemaVersion: 1,
    dependency: name,
    version: expectedVersion,
    root: resolve(destDir),
    tags: tagFiles.map((path, index) => ({
      path: relative(destDir, path).replaceAll('\\', '/'),
      value: tags[index],
    })),
    libraries: libraries.map((path) => ({
      path: relative(destDir, path).replaceAll('\\', '/'),
      bytes: statSync(path).size,
      sha256: sha256(path),
    })),
  };
}

function verifyAndRecordWgpuInstallation(name, destDir, expectedVersion) {
  const manifest = inspectWgpuInstallation(name, destDir, expectedVersion);
  writeFileSync(join(destDir, '.threenative-wgpu.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// A hosted runner shares one egress IP with every other job on the pool, and
// raw.githubusercontent.com rate-limits it. On 2026-09-07 that took the whole Android lane down:
// every cached dependency reported OK and then `stb` — three single headers fetched fresh on each
// run, outside the third-party cache — came back 429, so `Install Android build prerequisites`
// exited 1, the emulator never booted, and the two steps after it reported a missing report and a
// BLOCKED collector. One transient status must not read as a missing dependency.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

// One retry may never outlast the job that is waiting for it. A server is free to answer
// `Retry-After: 600`, and four of those inside `android-emulator-parity` (timeout-minutes: 45)
// would sleep past the job's own ceiling and report as an emulator hang rather than a rate limit.
const MAX_RETRY_DELAY_MS = 30_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `Retry-After` in seconds when the server names one, else exponential backoff from 1s; capped
 * either way. A malformed, non-positive or HTTP-date value falls through to the backoff.
 */
function retryDelayMs(response, attempt) {
  const header = Number(response?.headers?.get?.('retry-after'));
  const requested = Number.isFinite(header) && header > 0 ? header * 1000 : 1000 * 2 ** attempt;
  return Math.min(requested, MAX_RETRY_DELAY_MS);
}

// No Authorization header is ever attached here, and that is deliberate rather than an omission.
// raw.githubusercontent.com gates on the header instead of ignoring it: measured 2026-09-07 against
// nothings/stb, an anonymous GET returns 200 while the same GET carrying a bearer token the host
// cannot validate for that repository returns 404. `secrets.GITHUB_TOKEN` is scoped to this
// repository and has no grant on the upstreams this script fetches, so sending it would convert a
// retryable 429 into the one status this function refuses to retry, failing first-try and reading
// as a deleted upstream file. The cache restore in the workflow is what removes the fetch; this
// retry only has to survive the cold-cache run.
export async function downloadFile(url, destPath, options = {}) {
  const { fetchImpl = fetch, sleep = defaultSleep, retries = 4 } = options;

  console.log(`Downloading: ${url}`);

  const init = { redirect: 'follow' };

  let response;
  for (let attempt = 0; ; attempt += 1) {
    let failure;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      // A rate limit is not the only way this leg loses the network. `fetch` throws rather than
      // answering on ECONNRESET, a DNS failure or a dropped TLS handshake, and a retry that
      // survives only HTTP statuses would give up on exactly the flakiness it exists to absorb.
      if (attempt >= retries) throw error;
      failure = error;
    }

    if (!failure) {
      if (response.ok) break;
      // A 404 is the answer, not a transient failure: retrying it only delays a real error.
      if (!TRANSIENT_STATUSES.has(response.status) || attempt >= retries) {
        throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
      }
    }

    const delay = retryDelayMs(failure ? undefined : response, attempt);
    const reason = failure
      ? `${failure.code ?? failure.name ?? 'network error'}`
      : `${response.status} ${response.statusText}`;
    console.log(
      `  ${reason} — retrying in ${delay}ms (attempt ${attempt + 2} of ${retries + 1})`,
    );
    // The rejected response's body is never read; release it rather than holding the connection
    // open until GC across every retry.
    if (!failure) await response.body?.cancel?.().catch(() => {});
    await sleep(delay);
  }

  const dir = dirname(destPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const fileStream = createWriteStream(destPath);
  await pipeline(response.body, fileStream);

  console.log(`Downloaded to: ${destPath}`);
  return destPath;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Bytes(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

// PRD-059 Phase 1: the tracked lock is the only authority for which bytes may
// enter third_party/. Every payload below carries its immutable URL, expected
// SHA-256, source revision, license evidence and bootstrap source.
function readNativeDepsLock() {
  if (!existsSync(NATIVE_DEPS_LOCK_PATH)) {
    throw new Error(
      `TN_NATIVE_DEP_LOCK_MISSING: ${NATIVE_DEPS_LOCK_PATH} does not exist; the dependency lock is required before any acquisition.`,
    );
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(NATIVE_DEPS_LOCK_PATH, 'utf8'));
  } catch (error) {
    throw new Error(
      `TN_NATIVE_DEP_LOCK_MALFORMED: ${NATIVE_DEPS_LOCK_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (lock?.schemaVersion !== 1 || !Array.isArray(lock?.components)) {
    throw new Error(
      `TN_NATIVE_DEP_LOCK_MALFORMED: ${NATIVE_DEPS_LOCK_PATH} must carry schemaVersion 1 and a components array.`,
    );
  }
  const payloads = new Map();
  for (const component of lock.components) {
    if (!Array.isArray(component?.payloads)) {
      throw new Error(`TN_NATIVE_DEP_LOCK_MALFORMED: component '${component?.name ?? '?'}' has no payloads array.`);
    }
    for (const payload of component.payloads) {
      if (typeof payload?.id !== 'string' || typeof payload?.url !== 'string') {
        throw new Error('TN_NATIVE_DEP_LOCK_MALFORMED: every payload needs string id and url.');
      }
      if (!/^[0-9a-f]{64}$/.test(payload?.sha256 ?? '')) {
        throw new Error(`TN_NATIVE_DEP_LOCK_MALFORMED: payload '${payload.id}' has no 64-hex sha256.`);
      }
      if (payloads.has(payload.id)) {
        throw new Error(`TN_NATIVE_DEP_LOCK_DUPLICATE: payload id '${payload.id}' appears twice.`);
      }
      payloads.set(payload.id, { ...payload, component: component.name, version: component.version });
    }
  }
  return { lock, payloads };
}

function readNativeDepsLockContext() {
  const { lock, payloads } = readNativeDepsLock();
  return { lockHash: sha256Bytes(Buffer.from(JSON.stringify(lock))), payloads };
}

function lockPayloadForUrl(payloads, url) {
  for (const payload of payloads.values()) {
    if (payload.url === url) return payload;
  }
  return undefined;
}

function receiptPathFor(destDir) {
  return join(destDir, LOCK_RECEIPT_DIRNAME, 'receipt.json');
}

function readReceipt(destDir, lockHash) {
  const path = receiptPathFor(destDir);
  if (!existsSync(path)) return undefined;
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (receipt?.lockHash !== lockHash) return undefined;
    return receipt;
  } catch {
    return undefined;
  }
}

function writeReceipt(destDir, receipt) {
  const path = receiptPathFor(destDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporary, path);
}

function listInstalledFiles(destDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === LOCK_RECEIPT_DIRNAME) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(destDir, full).replaceAll('\\', '/'));
    }
  };
  walk(destDir);
  return out.sort();
}

function verifyBytesBeforeExtract(kind, id, url, bytes, expected) {
  const actual = sha256Bytes(bytes);
  if (actual !== expected) {
    throw new Error(
      `TN_NATIVE_DEP_CHECKSUM_MISMATCH: ${kind} '${id}' from ${url}: expected ${expected}, got ${actual}. No extractor ran and no destination was touched.`,
    );
  }
  return actual;
}

function verifyFinalUrl(id, requested, response) {
  // GitHub answers archive fetches from same-payload signer hosts on every
  // request: release assets from a signed release-assets URL (expiry/token
  // query, never a lockable identity), source archives from codeload. What the
  // lock pins is the requested URL, and what the digest proves is the bytes.
  // A redirect anywhere else is still a lock miss.
  const final = response?.url;
  if (typeof final !== 'string' || final.length === 0 || final === requested) return;
  let finalHost = '';
  try {
    finalHost = new URL(final).hostname;
  } catch {
    finalHost = '';
  }
  if (finalHost === 'release-assets.githubusercontent.com') return;
  if (finalHost === 'codeload.github.com') {
    let requestedPath = '';
    try {
      requestedPath = new URL(requested).pathname;
    } catch {
      requestedPath = '';
    }
    if (requestedPath.includes('/archive/refs/tags/')) return;
  }
  throw new Error(
    `TN_NATIVE_DEP_URL_MISMATCH: payload '${id}' requested ${requested} but answered from ${final}. Lock the redirect target instead of accepting it silently.`,
  );
}

async function ensureGradleWrapper() {
  if (existsSync(GRADLE_WRAPPER) && sha256(GRADLE_WRAPPER) === GRADLE_WRAPPER_SHA256) return;
  if (existsSync(GRADLE_WRAPPER)) rmSync(GRADLE_WRAPPER);
  await downloadFile(GRADLE_WRAPPER_URL, GRADLE_WRAPPER);
  const actual = sha256(GRADLE_WRAPPER);
  if (actual !== GRADLE_WRAPPER_SHA256) {
    rmSync(GRADLE_WRAPPER);
    throw new Error(`Gradle wrapper checksum mismatch: expected ${GRADLE_WRAPPER_SHA256}, got ${actual}`);
  }
}

/**
 * The tar to run. On Windows the PATH `tar` is often Git's GNU tar, which reads `D:\\...` as a remote
 * host and mangles `C:\\...` in `-C`; the bundled bsdtar in System32 takes native paths as they are.
 */
export function tarBinary(platform = process.platform, env = process.env) {
  return platform === 'win32' ? win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

export async function extractArchive(archivePath, destDir) {
  console.log(`Extracting: ${archivePath} -> ${destDir}`);

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  if (archivePath.endsWith('.zip') || archivePath.endsWith('.aar')) {
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: 'inherit' });
  } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    execFileSync(tarBinary(), ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
  } else if (archivePath.endsWith('.tar.xz')) {
    execFileSync(tarBinary(), ['-xJf', archivePath, '-C', destDir], { stdio: 'inherit' });
  } else if (archivePath.endsWith('.7z')) {
    // 7z format - requires p7zip (brew install p7zip on macOS)
    try {
      execSync(`7z x "${archivePath}" -o"${destDir}" -y`, { stdio: 'inherit' });
    } catch (e) {
      console.error('7z extraction failed. Install p7zip:');
      console.error('  macOS: brew install p7zip');
      console.error('  Linux: sudo apt install p7zip-full');
      console.error('  Windows: Install 7-Zip and add to PATH');
      throw e;
    }
  } else if (archivePath.endsWith('.dmg')) {
    // macOS DMG - mount, copy, unmount
    const mountPoint = '/tmp/mystral-dmg-mount';
    execSync(`hdiutil attach "${archivePath}" -mountpoint "${mountPoint}"`, { stdio: 'inherit' });
    execSync(`cp -R "${mountPoint}"/* "${destDir}/"`, { stdio: 'inherit' });
    execSync(`hdiutil detach "${mountPoint}"`, { stdio: 'inherit' });
  }

  console.log(`Extracted to: ${destDir}`);
}

function configuredWgpuCacheSourceArchive(sourceArchive) {
  const configured =
    sourceArchive ??
    process.env.THREENATIVE_WGPU_CACHE_SOURCE_ARCHIVE ??
    process.env.THREENATIVE_WGPU_SOURCE_ARCHIVE;
  return configured ? resolve(configured) : null;
}

function wgpuCacheSourceRoot(extractedDir) {
  const candidates = readdirSync(extractedDir)
    .map((entry) => join(extractedDir, entry))
    .filter((entry) => statSync(entry).isDirectory() && existsSync(join(entry, 'Cargo.toml')));
  if (candidates.length !== 1) {
    throw new Error(
      `TN_WGPU_CACHE_SOURCE_LAYOUT: expected one extracted wgpu-native Cargo root, found ${candidates.length}`,
    );
  }
  return candidates[0];
}

/**
 * Rebuilds the pinned wgpu-native release with the maintained pipeline-cache C API patch.
 *
 * This is deliberately opt-in: normal dependency installation remains the upstream prebuilt
 * path, while this route makes the cache ABI reproducible from one exact source archive and the
 * checked-in four-file patch. The local archive used by the Phase 1A receipt is preferred so a
 * cold local rebuild does not need network access; the exact GitHub archive is the fallback.
 */
export async function rebuildWgpuCacheApiFromSource({ sourceArchive, target = 'linux-x64' } = {}) {
  const toolchain = resolveWgpuCacheToolchain({ target });
  const android = target === 'android-arm64';
  const dependencyRoot = join(THIRD_PARTY, android ? 'wgpu-android' : 'wgpu');
  const destination = android ? join(dependencyRoot, 'aarch64') : dependencyRoot;
  const scratch = mkdtempSync(join(tmpdir(), 'threenative-wgpu-cache-api-'));
  let downloadedArchive = null;
  let stageDir = null;
  try {
    const configuredArchive = configuredWgpuCacheSourceArchive(sourceArchive);
    let archivePath = configuredArchive ?? WGPU_CACHE_LOCAL_ARCHIVE;
    if (!configuredArchive && !existsSync(archivePath)) {
      archivePath = join(scratch, WGPU_CACHE_SOURCE_ARCHIVE_NAME);
      await downloadFile(WGPU_CACHE_SOURCE_URL, archivePath);
      downloadedArchive = archivePath;
    }
    if (!existsSync(archivePath)) {
      throw new Error(
        `TN_WGPU_CACHE_SOURCE_MISSING: ${archivePath}; provide --wgpu-source-archive or ${
          'THREENATIVE_WGPU_CACHE_SOURCE_ARCHIVE'
        }`,
      );
    }
    const sourceArchiveSha256 = sha256(archivePath);
    if (sourceArchiveSha256 !== WGPU_CACHE_SOURCE_ARCHIVE_SHA256) {
      throw new Error(
        `TN_WGPU_CACHE_SOURCE_CHECKSUM: expected ${WGPU_CACHE_SOURCE_ARCHIVE_SHA256}, got ${sourceArchiveSha256}`,
      );
    }

    const wgpu = DEPS.wgpu;
    if (!wgpu.cacheApiPatch || !existsSync(wgpu.cacheApiPatch)) {
      throw new Error(`TN_WGPU_CACHE_PATCH_MISSING: ${wgpu.cacheApiPatch ?? '(no patch path)'}`);
    }
    const currentHeader = join(destination, 'include', 'webgpu', 'webgpu.h');
    if (!existsSync(currentHeader)) {
      throw new Error(`TN_WGPU_CACHE_HEADER_MISSING: ${currentHeader}`);
    }
    const currentHeaderSha256 = sha256(currentHeader);
    if (currentHeaderSha256 !== WGPU_CACHE_HEADER_SHA256) {
      throw new Error(
        `TN_WGPU_CACHE_HEADER_CHECKSUM: expected ${WGPU_CACHE_HEADER_SHA256}, got ${currentHeaderSha256}`,
      );
    }

    const extractedDir = join(scratch, 'source');
    await extractArchive(archivePath, extractedDir);
    const sourceRoot = wgpuCacheSourceRoot(extractedDir);
    const sourceHeader = join(sourceRoot, 'ffi', 'webgpu-headers', 'webgpu.h');
    copyFileSync(currentHeader, sourceHeader);
    if (sha256(sourceHeader) !== WGPU_CACHE_HEADER_SHA256) {
      throw new Error(`TN_WGPU_CACHE_HEADER_COPY: copied source header checksum changed at ${sourceHeader}`);
    }

    console.log(`Applying wgpu-native cache API patch: ${wgpu.cacheApiPatch}`);
    execFileSync('patch', ['--batch', '--forward', '-p1', '--input', wgpu.cacheApiPatch], {
      cwd: sourceRoot,
      stdio: 'inherit',
    });

    console.log(`Building patched wgpu-native ${target} with Rust ${toolchain.rustVersion}, NDK ${toolchain.ndkVersion}`);
    execFileSync('cargo', toolchain.cargoArgs, {
      cwd: sourceRoot,
      env: toolchain.env,
      stdio: 'inherit',
    });

    const releaseDir = join(toolchain.env.CARGO_TARGET_DIR || join(sourceRoot, 'target'), ...(toolchain.rustTarget ? [toolchain.rustTarget] : []), 'release');
    const libraryNames = [
      'libwgpu_native.a',
      'libwgpu_native.so',
      'libwgpu_native.dylib',
      'wgpu_native.dll',
      'wgpu_native.dll.lib',
      'wgpu_native.lib',
    ];
    const builtLibraries = libraryNames.filter((name) => existsSync(join(releaseDir, name)));
    if (builtLibraries.length === 0) {
      throw new Error(`TN_WGPU_CACHE_BUILD_OUTPUT: no wgpu-native library in ${releaseDir}`);
    }

    stageDir = mkdtempSync(join(THIRD_PARTY, '.wgpu-cache-api-stage-'));
    mkdirSync(join(stageDir, 'include', 'webgpu'), { recursive: true });
    mkdirSync(join(stageDir, 'lib'), { recursive: true });
    mkdirSync(join(stageDir, 'wgpu-native-meta'), { recursive: true });
    copyFileSync(sourceHeader, join(stageDir, 'include', 'webgpu', 'webgpu.h'));
    copyFileSync(join(sourceRoot, 'ffi', 'wgpu.h'), join(stageDir, 'include', 'webgpu', 'wgpu.h'));
    for (const library of builtLibraries) {
      copyFileSync(join(releaseDir, library), join(stageDir, 'lib', library));
    }
    const metadata = join(destination, 'wgpu-native-meta', 'webgpu.yml');
    if (existsSync(metadata)) copyFileSync(metadata, join(stageDir, 'wgpu-native-meta', 'webgpu.yml'));
    writeFileSync(
      join(stageDir, 'wgpu-native-meta', 'wgpu-native-git-tag'),
      `${DEFAULT_WGPU_VERSION}\n`,
    );
    inspectWgpuInstallation('wgpu', stageDir, DEFAULT_WGPU_VERSION);

    for (const name of ['LICENSE.APACHE', 'LICENSE.MIT']) {
      const license = join(sourceRoot, name);
      if (existsSync(license)) copyFileSync(license, join(stageDir, name));
    }
    writeFileSync(join(stageDir, '.threenative-cache-api-build.json'), `${JSON.stringify({
      schemaVersion: 1, target, version: DEFAULT_WGPU_VERSION,
      sourceArchiveSha256, headerSha256: currentHeaderSha256,
      patchSha256: sha256(wgpu.cacheApiPatch), rustVersion: toolchain.rustVersion,
      ndkVersion: toolchain.ndkVersion,
      libraries: builtLibraries.map((name) => ({ name, sha256: sha256(join(stageDir, 'lib', name)) })),
    }, null, 2)}\n`);
    if (android) assertAndroid16KbAlignment(builtLibraries.filter((name) => name.endsWith('.so')).map((name) => join(stageDir, 'lib', name)));
    const backup = `${destination}.before-cache-api-${process.pid}-${Date.now()}`;
    if (existsSync(destination)) renameSync(destination, backup);
    try {
      renameSync(stageDir, destination);
      stageDir = null;
    } catch (error) {
      if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
      throw error;
    }
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove the previous wgpu-native dependency backup: ${error.message}`);
    }
    const manifest = verifyAndRecordWgpuInstallation(android ? 'wgpu-android' : 'wgpu', dependencyRoot, DEFAULT_WGPU_VERSION);
    console.log(`Staged patched wgpu-native ${manifest.version} at ${destination}`);
    return manifest;
  } finally {
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    if (downloadedArchive && existsSync(downloadedArchive)) rmSync(downloadedArchive);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function findFileRecursive(rootDir, fileName) {
  const entries = readdirSync(rootDir);
  for (const entry of entries) {
    const fullPath = join(rootDir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) {
        return found;
      }
    } else if (entry === fileName) {
      return fullPath;
    }
  }
  return null;
}

function normalizeSwcLayout(destDir) {
  const includeDir = join(destDir, 'include');
  const libDir = join(destDir, 'lib');
  const headerPath = join(includeDir, 'swc.h');
  const libPath = join(libDir, process.platform === 'win32' ? 'swc.lib' : 'libswc.a');

  if (!existsSync(headerPath)) {
    const foundHeader = findFileRecursive(destDir, 'swc.h');
    if (foundHeader) {
      mkdirSync(includeDir, { recursive: true });
      copyFileSync(foundHeader, headerPath);
    }
  }

  if (!existsSync(libPath)) {
    const targetLibName = process.platform === 'win32' ? 'swc.lib' : 'libswc.a';
    const foundLib = findFileRecursive(destDir, targetLibName);
    if (foundLib) {
      mkdirSync(libDir, { recursive: true });
      copyFileSync(foundLib, libPath);
    }
  }
}

async function downloadLockedArchive(payloads, _lockHash, id, url, archivePath, fetchImpl) {
  // PRD-059 Phase 1 transaction: quarantine, verify redirect + SHA-256, then hand
  // back verified bytes. The caller extracts; nothing is written to third_party/
  // before this returns. A mismatch throws and no extractor ever runs.
  const payload = lockPayloadForUrl(payloads, url);
  if (!payload) {
    throw new Error(
      `TN_NATIVE_DEP_LOCK_MISSING: no lock payload covers ${url} (requested as '${id}'). Refusing an unreviewed download.`,
    );
  }
  mkdirSync(dirname(archivePath), { recursive: true });
  const response = await (fetchImpl ?? fetch)(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`TN_NATIVE_DEP_FETCH_FAILED: ${url}: HTTP ${response.status}.`);
  }
  verifyFinalUrl(payload.id, url, response);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyBytesBeforeExtract('payload', payload.id, url, bytes, payload.sha256);
  if (payload.bytes !== undefined && bytes.length !== payload.bytes) {
    throw new Error(
      `TN_NATIVE_DEP_SIZE_MISMATCH: payload '${payload.id}': lock says ${payload.bytes} bytes, received ${bytes.length}.`,
    );
  }
  writeFileSync(archivePath, bytes);
  console.log(`Verified ${payload.id} archive checksum (${bytes.length} bytes)`);
  return payload;
}

async function downloadIosDep(name, dep, lockContext) {
  // Special handler for iOS dependencies with multiple archives
  const destDir = destinationFor(name, dep);

  if (existsSync(destDir)) {
    console.log(`${name} already exists at ${destDir}`);
    if (!process.argv.includes('--force')) {
      if (!WGPU_DEPS.has(name)) {
        if (lockContext) {
          const receipt = readReceipt(destDir, lockContext.lockHash);
          if (!receipt) {
            console.warn(`${name} has no receipt for the current lock; replacing the stale dependency cache`);
          } else {
            console.log('Skipping (use --force to re-download)');
            return true;
          }
        } else {
          console.log('Skipping (use --force to re-download)');
          return true;
        }
      } else {
        try {
          verifyAndRecordWgpuInstallation(name, destDir, dep.version);
          console.log(`Verified installed ${name} ${dep.version}`);
          return true;
        } catch (error) {
          console.warn(`${error.message}; replacing the stale dependency cache`);
        }
      }
    }
    rmSync(destDir, { recursive: true });
  }

  mkdirSync(destDir, { recursive: true });

  try {
    const verified = [];
    for (const [variant, url] of Object.entries(dep.archives)) {
      console.log(`\nDownloading ${name} (${variant})...`);
      const archiveName = url.split('/').pop();
      const archiveRoot = wgpuVersionOverride && WGPU_DEPS.has(name)
        ? join(dirname(destDir), '.downloads')
        : THIRD_PARTY;
      const archivePath = join(archiveRoot, archiveName);
      const variantDir = join(destDir, variant);

      if (lockContext) {
        const payload = await downloadLockedArchive(lockContext.payloads, lockContext.lockHash, `${name} (${variant})`, url, archivePath);
        verified.push(payload.id);
      } else {
        await downloadFile(url, archivePath);
      }
      const stageDir = mkdtempSync(join(tmpdir(), 'threenative-dep-'));
      try {
        await extractArchive(archivePath, stageDir);
        mkdirSync(variantDir, { recursive: true });
        execSync(`cp -R "${stageDir}/"* "${variantDir}/"`, { stdio: 'inherit' });
      } finally {
        rmSync(stageDir, { force: true, recursive: true });
      }
      rmSync(archivePath);

      console.log(`Extracted ${variant} to ${variantDir}`);
    }
    if (WGPU_DEPS.has(name)) {
      const manifest = verifyAndRecordWgpuInstallation(name, destDir, dep.version);
      console.log(`Verified ${name} ${manifest.version}: ${manifest.libraries.length} library artifact(s)`);
    }
    console.log(`Successfully installed ${name}`);
    return true;
  } catch (error) {
    console.error(`Failed to download ${name}:`, error.message);
    return false;
  }
}

export async function downloadDep(name, options = {}) {
  const dep = DEPS[name];
  if (!dep) {
    console.error(`Unknown dependency: ${name}`);
    return false;
  }

  console.log(`\n=== Downloading ${name} ${dep.version} ===`);
  const lock = options.lockContext ?? readNativeDepsLockContext();

  if (name === 'v8-android') {
    const destination = join(options.thirdPartyRoot ?? THIRD_PARTY, dep.extractTo);
    try {
      await (options.provisionV8 ?? provisionAndroidV8)(destination, {
        force: options.force ?? process.argv.includes('--force'),
      });
      return true;
    } catch (error) {
      console.error(`Failed to provision ${name}:`, error.message);
      return false;
    }
  }

  // Special handling for iOS dependencies with multiple archives
  if (dep.archives && !dep.getUrl()) {
    return downloadIosDep(name, dep, lock);
  }

  const destDir = destinationFor(name, dep);

  // Header-only dependencies (stb, cgltf): individual files, each verified against the lock.
  if (dep.headers) {
    // Per header, not per directory. Testing the directory meant that adding a header to the list
    // above provisioned nothing on any checkout that already had the others: `stb_vorbis.c` was
    // added for Ogg decode and every existing tree reported "already exists" and skipped it, so
    // the build failed on a missing include with the download step reporting success.
    if (process.argv.includes('--force') && existsSync(destDir)) rmSync(destDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    const missing = dep.headers.filter((header) => !existsSync(join(destDir, header)));
    if (missing.length === 0) {
      if (readReceipt(destDir, lock.lockHash)) {
        console.log(`${name} already exists at ${destDir}`);
        console.log('Skipping (use --force to re-download)');
        return true;
      }
      // Same as every other dependency: any lock bump invalidates every receipt, so a stale
      // cache is replaced rather than failing the whole native build.
      console.warn(`${name} has no receipt for the current lock; replacing the stale dependency cache`);
      missing.push(...dep.headers);
    }
    try {
      const verified = [];
      for (const header of missing) {
        const url = dep.headerUrl(header);
        const quarantine = mkdtempSync(join(tmpdir(), 'threenative-dep-'));
        try {
          const staged = join(quarantine, header);
          const payload = await downloadLockedArchive(lock.payloads, lock.lockHash, `${name} ${header}`, url, staged);
          copyFileSync(staged, join(destDir, header));
          verified.push(payload.id);
        } finally {
          rmSync(quarantine, { force: true, recursive: true });
        }
      }
      writeReceipt(destDir, {
        schemaVersion: 1, dependency: name, lockHash: lock.lockHash,
        payloads: verified, files: listInstalledFiles(destDir),
      });
      console.log(`Successfully installed ${name}: ${missing.join(', ')}`);
      return true;
    } catch (error) {
      console.error(`Failed to download ${name}:`, error.message);
      return false;
    }
  }

  const url = dep.getUrl();
  if (!url) {
    console.warn(`Skipping ${name} - no prebuilt available for this platform`);
    return false;
  }
  if (!lockPayloadForUrl(lock.payloads, url)) {
    console.error(
      `TN_NATIVE_DEP_LOCK_MISSING: no lock payload covers ${url} (requested as '${name}'). Refusing an unreviewed download.`,
    );
    return false;
  }

  // Check if already downloaded
  if (existsSync(destDir)) {
    console.log(`${name} already exists at ${destDir}`);
    if (!process.argv.includes('--force')) {
      if (!WGPU_DEPS.has(name)) {
        const receipt = readReceipt(destDir, lock.lockHash);
        if (!receipt) {
          console.warn(`${name} has no receipt for the current lock; replacing the stale dependency cache`);
        } else {
          console.log('Skipping (use --force to re-download)');
          return true;
        }
      } else {
        try {
          verifyAndRecordWgpuInstallation(name, destDir, dep.version);
          console.log(`Verified installed ${name} ${dep.version}`);
          return true;
        } catch (error) {
          console.warn(`${error.message}; replacing the stale dependency cache`);
        }
      }
    }
    rmSync(destDir, { recursive: true });
  }

  // Download
  const ext = url.split('.').slice(-1)[0];
  const archiveName =
    dep.archiveName ??
    (url.includes('.tar.') ? url.split('/').pop() : `${name}.${ext}`);
  const archiveRoot = wgpuVersionOverride && WGPU_DEPS.has(name)
    ? join(dirname(destDir), '.downloads')
    : THIRD_PARTY;
  const archivePath = join(archiveRoot, archiveName);

  try {
    const payload = await downloadLockedArchive(lock.payloads, lock.lockHash, name, url, archivePath);
    const stageDir = mkdtempSync(join(tmpdir(), 'threenative-dep-'));
    try {
      await extractArchive(archivePath, stageDir);
      mkdirSync(destDir, { recursive: true });
      execSync(`cp -R "${stageDir}/"* "${destDir}/"`, { stdio: 'inherit' });
    } finally {
      rmSync(stageDir, { force: true, recursive: true });
    }

    // Clean up archive
    rmSync(archivePath);

    // Download headers if needed (e.g., Dawn)
    const verifiedExtra = [];
    if (dep.needsHeaders && dep.getHeadersUrl) {
      const headersUrl = dep.getHeadersUrl();
      if (headersUrl) {
        console.log(`\nDownloading headers for ${name}...`);
        const headersArchiveName = headersUrl.split('/').pop();
        const headersArchivePath = join(THIRD_PARTY, headersArchiveName);
        const headerPayload = await downloadLockedArchive(lock.payloads, lock.lockHash, `${name} headers`, headersUrl, headersArchivePath);
        verifiedExtra.push(headerPayload.id);
        // Extract headers to a temp dir, then merge into destDir
        const headersTempDir = join(THIRD_PARTY, `${name}-headers-temp`);
        await extractArchive(headersArchivePath, headersTempDir);
        // Copy headers into destDir/include
        execSync(`cp -R "${headersTempDir}/"* "${destDir}/"`, { stdio: 'inherit' });
        rmSync(headersArchivePath);
        rmSync(headersTempDir, { recursive: true });
        console.log(`Headers merged into ${destDir}`);
      }
    }
    writeReceipt(destDir, {
      schemaVersion: 1, dependency: name, lockHash: lock.lockHash,
      payloads: [payload.id, ...verifiedExtra], files: listInstalledFiles(destDir),
    });

    // Post-install fixes
    if (name === 'quickjs') {
      // QuickJS has a 'version' file that conflicts with C++ <version> header
      // Rename it to avoid the conflict
      const versionFile = join(destDir, 'quickjs-2024-01-13', 'version');
      const versionFileNew = join(destDir, 'quickjs-2024-01-13', 'VERSION.txt');
      try {
        const { renameSync, existsSync: exists } = await import('node:fs');
        if (exists(versionFile)) {
          renameSync(versionFile, versionFileNew);
          console.log('Renamed version -> VERSION.txt (C++ header conflict fix)');
        }
      } catch (e) {
        console.warn('Could not rename version file:', e.message);
      }
    }

    if (name === 'swc') {
      normalizeSwcLayout(destDir);
    }

    if (name === 'sdl3') {
      const activityPath = join(
        destDir,
        `SDL3-${dep.version}`,
        'android-project/app/src/main/java/org/libsdl/app/SDLActivity.java',
      );
      const activity = readFileSync(activityPath, 'utf8');
      const defaultThread = 'mSDLThread = new Thread(new SDLMain(), "SDLThread");';
      const boundedThread =
        'mSDLThread = new Thread(null, new SDLMain(), "SDLThread", 8 * 1024 * 1024);';
      if (!activity.includes(defaultThread) && !activity.includes(boundedThread)) {
        throw new Error('SDLActivity.java no longer contains the expected SDLThread constructor');
      }
      if (!activity.includes(boundedThread)) {
        writeFileSync(activityPath, activity.replace(defaultThread, boundedThread));
        console.log('Applied the Android QuickJS SDLThread stack-size patch');
      }
    }

    if (WGPU_DEPS.has(name)) {
      const manifest = verifyAndRecordWgpuInstallation(name, destDir, dep.version);
      console.log(`Verified ${name} ${manifest.version}: ${manifest.libraries.length} library artifact(s)`);
    }

    // Extract AAR if needed (SDL3 Android)
    if (dep.needsAarExtraction) {
      const aarFiles = await import('node:fs/promises').then(fs => fs.readdir(destDir));
      const aarFile = aarFiles.find(f => f.endsWith('.aar'));
      if (aarFile) {
        const aarPath = join(destDir, aarFile);
        const extractedDir = join(destDir, 'extracted');
        console.log(`Extracting AAR: ${aarFile} -> extracted/`);
        await extractArchive(aarPath, extractedDir);
        console.log('AAR extracted successfully');
      }
    }

    console.log(`Successfully installed ${name}`);
    return true;
  } catch (error) {
    console.error(`Failed to download ${name}:`, error.message);
    return false;
  }
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (statSync(source).isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

function printHelp() {
  // Read-only: stdout only, no directory, acquisition, or network side effects.
  console.log(`Mystral Native Runtime - Dependency Downloader

Usage:
  node scripts/download-deps.mjs                                # desktop deps for the current platform
  node scripts/download-deps.mjs --android                      # Android cross-compilation deps
  node scripts/download-deps.mjs --ios                          # iOS dependencies for macOS builds
  node scripts/download-deps.mjs --all                          # everything (desktop + iOS + Android)
  node scripts/download-deps.mjs --only <name>                  # one dependency (e.g. --only stb, --only v8-android)
  node scripts/download-deps.mjs --check-lock                   # list locked payloads; no fetch, no toolchain

Options:
  --only <name>                 fetch a single dependency
  --force                       re-fetch even if the cache exists
  --backend <auto|dawn|wgpu>    Android WebGPU backend (only with --android)
  --wgpu-version <version>      wgpu-native regression version (isolated under .runtime/wgpu-version-matrix)
  --rebuild-wgpu-cache-api [--wgpu-source-archive <path>] [--wgpu-cache-target <target>]
  --only skia-android [--source <dir>] [--dest <dir>] [--jobs <n>]
  --check-lock                  show locked payloads without downloading
  --help, -h                    print this usage and exit without touching caches or network`);
}

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // Read-only usage: return before any directory mutation, acquisition, or network.
    printHelp();
    return;
  }
  console.log(`Platform: ${platformName}-${archName}`);
  // Ensure third_party directory exists
  if (!existsSync(THIRD_PARTY)) {
    mkdirSync(THIRD_PARTY, { recursive: true });
  }

  if (args.includes('--check-lock')) {
    // PRD-059 Phase 1 user verification: report every locked payload without
    // downloading, extracting, or invoking any toolchain. No network access.
    const { lock, payloads } = readNativeDepsLock();
    const byComponent = new Map();
    for (const payload of payloads.values()) {
      if (!byComponent.has(payload.component)) byComponent.set(payload.component, []);
      byComponent.get(payload.component).push(payload.id);
    }
    console.log(`Dependency lock: ${NATIVE_DEPS_LOCK_PATH}`);
    console.log(`Schema: ${lock.schemaVersion}; components: ${lock.components.length}; payloads: ${payloads.size}`);
    for (const [component, ids] of [...byComponent.entries()].sort()) {
      console.log(`  ${component}: ${ids.sort().join(', ')}`);
    }
    return;
  }
  const onlyIndex = args.indexOf('--only');
  const requestedWgpuVersion = valueAfter(args, '--wgpu-version');
  const rebuildWgpuCacheApi = args.includes('--rebuild-wgpu-cache-api');
  const sourceArchive = valueAfter(args, '--wgpu-source-archive');
  const cacheTarget = valueAfter(args, '--wgpu-cache-target');
  if (cacheTarget && !rebuildWgpuCacheApi) throw new Error('--wgpu-cache-target requires --rebuild-wgpu-cache-api');
  if (sourceArchive && !rebuildWgpuCacheApi) {
    throw new Error('--wgpu-source-archive requires --rebuild-wgpu-cache-api');
  }
  if (rebuildWgpuCacheApi) {
    if (requestedWgpuVersion && normalizeWgpuVersion(requestedWgpuVersion) !== DEFAULT_WGPU_VERSION) {
      throw new Error(`--rebuild-wgpu-cache-api only supports ${DEFAULT_WGPU_VERSION}`);
    }
    const conflictingFlags = ['--only', '--ios', '--android', '--all', '--backend'];
    const conflict = conflictingFlags.find((flag) => args.includes(flag));
    if (conflict) throw new Error(`--rebuild-wgpu-cache-api cannot be combined with ${conflict}`);
    console.log('Mystral Native Runtime - Reproducible wgpu-native cache API rebuild');
    console.log('=========================================================================');
    const manifest = await rebuildWgpuCacheApiFromSource({
      ...(sourceArchive ? { sourceArchive } : {}),
      ...(cacheTarget ? { target: cacheTarget } : {}),
    });
    console.log(`  wgpu: OK (${manifest.version}, ${manifest.libraries.length} library artifact(s))`);
    return;
  }
  const requestedBackend = normalizeWebgpuBackend(valueAfter(args, '--backend') ?? 'auto');
  const androidRequested = args.includes('--android');
  if (requestedBackend !== 'auto' && !androidRequested) {
    throw new Error('--backend is only supported with --android');
  }
  if (requestedBackend === 'dawn') assertDawnAndroidArchive();
  if (requestedWgpuVersion) configureWgpuOverride(requestedWgpuVersion);

  // Linux arm64 has no prebuilt for the x64 desktop stack: kuoruan/libv8 ships Linux x64 only,
  // Dawn's `ubuntu-latest` release asset is x64, and skia/swc/quiche/webp publish no arm64 Linux
  // archive. A source V8 build is not allowed in CI. The arm64 desktop host is therefore built with
  // the QuickJS engine over wgpu-native, whose `wgpu-linux-aarch64` prebuilt is already in the
  // dependency lock; the CMake build disables the optional features whose libraries are absent
  // (Canvas2D/Skia, WebTransport/quiche, TS/SWC) instead of linking a foreign architecture. libuv
  // has no arm64 prebuilt either, so arm64 also fetches the architecture-independent `libuv-source`
  // and CMake builds it from that pinned source (see CMakeLists.txt). See scripts/native-build.mjs
  // for the matching configure overrides.
  const linuxArm64 = platformName === 'linux' && ARCH === 'arm64';
  const desktopDeps = linuxArm64
    ? ['wgpu', 'sdl3', 'quickjs', 'stb', 'cgltf', 'libuv-source', 'webp-source']
    : ['wgpu', 'sdl3', 'dawn', 'v8', 'quickjs', 'stb', 'cgltf', 'webp', 'webp-source', platformName === 'windows' ? 'skia-win-static' : 'skia', 'swc', 'libuv', 'libuv-source', 'quiche'];

  // iOS deps (only downloaded with --only or --ios)
  const iosDeps = ['wgpu-ios', 'skia-ios', 'quiche-ios', 'sdl3-ios', 'webp-source'];

  // Android deps (only downloaded with --only or --android)
  const androidDeps = ['sdl3', 'wgpu-android', 'sdl3-android', 'quiche-android', 'v8-android', 'webp-source'];
  const selectedAndroidDeps = requestedBackend === 'dawn'
    ? androidDeps.filter((name) => name !== 'wgpu-android')
    : androidDeps;

  // Windows-specific deps (only downloaded with --only)
  // skia-win-static: Static Skia+Dawn build from library-builder with /MT
  const windowsDeps = ['skia-win-static'];

  // skia-android is a bounded source build, not an archive download. Keep it reachable
  // through --only, but out of --android and --all until Android proof is complete.
  const sourceBuildDeps = ['skia-android'];

  // Downloadable dependencies and the complete --only allowlist.
  const allDeps = [...new Set([...desktopDeps, ...iosDeps, ...androidDeps, ...windowsDeps])];
  const availableDeps = [...new Set([...allDeps, ...sourceBuildDeps, 'openriglogic'])];

  let depsToDownload;
  if (onlyIndex !== -1) {
    const depName = args[onlyIndex + 1];
    if (!availableDeps.includes(depName)) {
      console.error(`Unknown dependency: ${depName}`);
      console.error(`Available: ${availableDeps.join(', ')}`);
      process.exit(1);
    }
    if (depName === 'skia-android') {
      const { buildSkiaAndroidFromStagedSource } = await import('./build-skia-android.mjs');
      const source = valueAfter(args, '--source');
      const dest = valueAfter(args, '--dest');
      const jobs = valueAfter(args, '--jobs');
      await buildSkiaAndroidFromStagedSource({
        ...(source ? { sourceRoot: source } : {}),
        ...(dest ? { destDir: dest } : {}),
        ...(jobs ? { jobs: Number(jobs) } : {}),
      });
      console.log('\n=== Summary ===\n  skia-android: OK');
      return;
    }
    depsToDownload = [depName];
  } else if (args.includes('--ios')) {
    // Download iOS cross-compilation deps (macOS only)
    if (PLATFORM !== 'darwin') {
      console.error('iOS dependencies can only be downloaded on macOS');
      process.exit(1);
    }
    depsToDownload = iosDeps;
  } else if (args.includes('--android')) {
    // Download Android cross-compilation deps
    depsToDownload = selectedAndroidDeps;
  } else if (args.includes('--all')) {
    // Download everything
    depsToDownload = allDeps;
  } else {
    // Default: desktop deps only
    depsToDownload = desktopDeps;
  }

  if (requestedWgpuVersion && !depsToDownload.some((name) => WGPU_DEPS.has(name))) {
    throw new Error('--wgpu-version requires downloading wgpu, wgpu-ios, or wgpu-android');
  }

  console.log('Mystral Native Runtime - Dependency Downloader');
  console.log('==============================================');
  console.log(`Dependencies to download: ${depsToDownload.join(', ')}`);
  if (requestedWgpuVersion) {
    console.log(`wgpu-native override: ${requestedWgpuVersion} (isolated under .runtime/wgpu-version-matrix)`);
  }

  if (depsToDownload.some((name) => androidDeps.includes(name))) await ensureGradleWrapper();

  // The lock is read once per invocation so every selected payload resolves
  // against the same reviewed bytes. No acquisition runs without it.
  const lock = readNativeDepsLockContext();
  const results = {};
  for (const dep of depsToDownload) {
    results[dep] = await downloadDep(dep, { lockContext: lock });
  }

  console.log('\n=== Summary ===');
  for (const [name, success] of Object.entries(results)) {
    console.log(`  ${name}: ${success ? 'OK' : 'FAILED'}`);
    if (success && requestedWgpuVersion && WGPU_DEPS.has(name)) {
      console.log(`    THREENATIVE_WGPU_ROOT=${destinationFor(name, DEPS[name])}`);
    }
  }

  const failed = Object.entries(results).filter(([, success]) => !success).map(([name]) => name);
  if (failed.length > 0) throw new Error(`Dependency download failed: ${failed.join(', ')}`);

  // Print next steps
  console.log('\n=== Next Steps ===');
  console.log('1. Run: npm run configure');
  console.log('2. Run: npm run build');
  console.log('3. Run: npm run example:triangle');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
