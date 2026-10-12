import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { nativeDefinition } from "../../../test-support/native-definition.js";

const compiler = process.env.CXX || "c++";
const probe = spawnSync(compiler, ["--version"], { encoding: "utf8" });
const nativeTest = probe.error?.code === "ENOENT" ? test.skip : test;

nativeTest(
  "shared Android presentation configures latency and stops a wedged acquire at its deadline",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "tn-android-acquire-"));
    try {
      const root = fileURLToPath(new URL("../", import.meta.url));
      mkdirSync(join(directory, "android"));
      writeFileSync(
        join(directory, "android/log.h"),
        `
#pragma once
#include <cstdarg>
#include <cstdio>
#define ANDROID_LOG_INFO 4
#define ANDROID_LOG_ERROR 6
inline int __android_log_print(int, const char*, const char* format, ...) {
  va_list args; va_start(args, format);
  int result = std::vfprintf(stderr, format, args);
  va_end(args); std::fputc('\\n', stderr); return result;
}
`,
      );
      const source = join(directory, "acquire.cpp");
      const executable = join(directory, "acquire");
      writeFileSync(
        source,
        `
#include "mystral/webgpu/presentation.h"
#include <webgpu/webgpu.h>
#include <webgpu/wgpu.h>
#include <chrono>
#include <thread>
bool hang = false;
bool configured = false;
extern "C" void wgpuSurfaceConfigure(WGPUSurface, const WGPUSurfaceConfiguration* config) {
  const auto* extras = reinterpret_cast<const WGPUSurfaceConfigurationExtras*>(config->nextInChain);
  configured = config->presentMode == WGPUPresentMode_Immediate &&
    config->alphaMode == WGPUCompositeAlphaMode_Auto && extras &&
    extras->chain.sType == static_cast<WGPUSType>(WGPUSType_SurfaceConfigurationExtras) &&
    extras->desiredMaximumFrameLatency == 2;
}
extern "C" void wgpuSurfaceGetCurrentTexture(WGPUSurface, WGPUSurfaceTexture*) {
  while (hang) std::this_thread::sleep_for(std::chrono::milliseconds(10));
}
int main(int argc, char**) {
  WGPUSurfaceConfiguration config{};
  config.presentMode = WGPUPresentMode_Immediate;
  mystral::webgpu::configurePresentationSurface(nullptr, &config);
  if (!configured) return 3;
  hang = argc > 1;
  WGPUSurfaceTexture texture{};
  mystral::webgpu::acquirePresentationSurface(nullptr, &texture);
  // A returned acquire must disarm the deadline rather than abort during later CPU work.
  std::this_thread::sleep_for(std::chrono::milliseconds(2100));
}
`,
      );
      const built = spawnSync(
        compiler,
        [
          "-std=c++20",
          "-pthread",
          "-D__ANDROID__",
          "-DMYSTRAL_WEBGPU_WGPU",
          "-DTN_WEBGPU_DESIRED_FRAME_LATENCY=0",
          `-I${directory}`,
          `-I${join(root, "include")}`,
          `-I${join(root, "third_party/wgpu/include")}`,
          join(root, "src/webgpu/presentation.cpp"),
          source,
          "-o",
          executable,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(built.status, 0, built.error?.message ?? built.stderr);
      const returned = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000 });
      assert.equal(returned.status, 0, returned.error?.message ?? returned.stderr);
      const begin = Date.now();
      const wedged = spawnSync(executable, ["hang"], { encoding: "utf8", timeout: 5_000 });
      assert.equal(wedged.status, 2, wedged.error?.message ?? wedged.stderr);
      assert.match(wedged.stderr, /TN_SURFACE_ACQUIRE_TIMEOUT/u);
      assert.ok(Date.now() - begin >= 1900, "acquire must get its two-second allowance");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

// Compile the production synchronization body against controlled platform/GPU boundaries.
// This proves its state transitions, not driver behavior; the source-built hosted test proves
// actual canvas/depth attachments and rendered destination pixels with the real WebGPU backend.
nativeTest("canvas resolution changes never configure a differently sized native drawable", () => {
  const directory = mkdtempSync(join(tmpdir(), "tn-presentation-resize-"));
  try {
    const source = join(directory, "contract.cpp");
    const executable = join(directory, process.platform === "win32" ? "contract.exe" : "contract");
    writeFileSync(source, `
#include <cstdint>
#include <iostream>
#include <map>
#include <string>
#include <vector>
using WGPUTexture = void*;
namespace js { struct JSValueHandle { uint32_t width, height; }; }
struct PresentationState {
  uint32_t canvasWidth = 640, canvasHeight = 400;
  uint32_t surfaceWidth = 640, surfaceHeight = 400;
  void* surfaceNativeHandle = nullptr;
  bool requiresSrgbPresentationBridge = false;
  WGPUTexture currentTexture = nullptr;
  uint64_t currentSurfaceTextureId = 0;
  bool framePresentPending = false, surfaceRenderPassEnded = false;
  void* surfaceRenderEncoder = nullptr;
  int nativeSurfaceFormat = 1, surfaceFormat = 1, presentMode = 7;
};
struct Engine { std::string error; void throwException(const char* text) { error = text; } };
struct BindingsState {
  Engine engineValue;
  Engine* engine = &engineValue;
  void* surface = reinterpret_cast<void*>(1);
  void* device = reinterpret_cast<void*>(2);
  PresentationState presentation;
  struct { std::map<uint64_t, int> textureRegistry; } registries;
  bool verboseLogging = false;
};
struct WGPUSurfaceConfiguration {
  void* device; int format, usage, alphaMode; uint32_t width, height; int presentMode;
};
constexpr int WGPUTextureUsage_RenderAttachment = 1, WGPUTextureUsage_CopySrc = 2;
constexpr int WGPUCompositeAlphaMode_Auto = 1;
int drawableWidth = 640, drawableHeight = 400;
bool canFlush = true;
std::vector<std::string> calls;
WGPUSurfaceConfiguration lastConfig{};
struct WGPUSurfaceTexture { int status = 0; WGPUTexture texture = nullptr; };
constexpr int success = 1, outdated = 2, timeout = 3;
int firstStatus = outdated, secondStatus = success, acquireCalls = 0;
std::vector<WGPUTexture> releasedTextures;
bool wgpuSurfaceTextureStatusNeedsReconfigure(int status) { return status == outdated; }
void acquirePresentationSurface(void*, WGPUSurfaceTexture* texture) {
  calls.push_back("acquire");
  texture->status = acquireCalls == 0 ? firstStatus : secondStatus;
  texture->texture = reinterpret_cast<void*>(static_cast<uintptr_t>(100 + ++acquireCalls));
}
namespace mystral::platform {
  bool getWindowDrawableSize(void*, int* w, int* h) {
    *w = drawableWidth; *h = drawableHeight; return *w > 0 && *h > 0;
  }
}
namespace platform = mystral::platform;
bool readCanvasDimension(BindingsState*, js::JSValueHandle canvas, const char* name, uint32_t& value) {
  value = std::string(name) == "width" ? canvas.width : canvas.height; return value > 0;
}
bool flushRecordedFrameOps(BindingsState*) { calls.push_back("flush"); return canFlush; }
void releaseCurrentSurfaceTextureViews(BindingsState*) { calls.push_back("views"); }
void wgpuTextureRelease(WGPUTexture texture) { calls.push_back("texture"); releasedTextures.push_back(texture); }
void configurePresentationSurface(void*, const WGPUSurfaceConfiguration* config) {
  calls.push_back("configure"); lastConfig = *config;
}
void reportSurfaceFormatMarker(int, int, bool, int) {}
${nativeDefinition("syncSurfaceSizeToCanvas").text}
${nativeDefinition("requiresPresentationBridge").text}
${nativeDefinition("reconfigureSurfaceForAcquire").text}
${nativeDefinition("acquireSurfaceImage").text}
int main() {
  BindingsState state;
  if (requiresPresentationBridge(&state)) return 6;
  if (!syncSurfaceSizeToCanvas(&state, {320, 240}) || !calls.empty() ||
      state.presentation.canvasWidth != 320 || state.presentation.canvasHeight != 240 ||
      state.presentation.surfaceWidth != 640 || state.presentation.surfaceHeight != 400) {
    std::cerr << "canvas-only resize reconfigured physical surface or lost canvas extent\\n"; return 1;
  }
  if (!requiresPresentationBridge(&state)) return 7;
  state.presentation.requiresSrgbPresentationBridge = true;
  state.presentation.currentTexture = reinterpret_cast<void*>(3);
  state.presentation.currentSurfaceTextureId = 9;
  state.presentation.framePresentPending = true;
  state.registries.textureRegistry[9] = 1;
  if (!syncSurfaceSizeToCanvas(&state, {640, 400}) ||
      calls != std::vector<std::string>{"flush", "views", "texture"} ||
      state.presentation.currentTexture || state.presentation.currentSurfaceTextureId ||
      state.presentation.framePresentPending || !state.registries.textureRegistry.empty()) {
    std::cerr << "offscreen resize retained stale texture/view aliases\\n"; return 2;
  }
  if (!requiresPresentationBridge(&state)) return 8;
  state.presentation.requiresSrgbPresentationBridge = false;
  if (requiresPresentationBridge(&state)) return 9;
  calls.clear();
  drawableWidth = 800; drawableHeight = 600;
  if (!syncSurfaceSizeToCanvas(&state, {640, 400}) || calls != std::vector<std::string>{"configure"} ||
      lastConfig.width != 800 || lastConfig.height != 600 || lastConfig.presentMode != 7 ||
      state.presentation.canvasWidth != 640 || state.presentation.surfaceWidth != 800) {
    std::cerr << "physical resize was missed with unchanged canvas dimensions\\n"; return 3;
  }
  calls.clear(); canFlush = false;
  state.presentation.currentTexture = reinterpret_cast<void*>(4);
  if (syncSurfaceSizeToCanvas(&state, {320, 240}) || calls != std::vector<std::string>{"flush"} ||
      !state.presentation.currentTexture || state.presentation.canvasWidth != 640) {
    std::cerr << "failed flush mutated acquired frame ownership\\n"; return 4;
  }
  calls.clear();
  if (syncSurfaceSizeToCanvas(&state, {0, 240}) || !calls.empty()) return 5;
  drawableWidth = 0;
  if (syncSurfaceSizeToCanvas(&state, {320, 240}) || !calls.empty() ||
      state.engineValue.error != "Native drawable dimensions are unavailable" ||
      !state.presentation.currentTexture || state.presentation.canvasWidth != 640) return 10;
  calls.clear(); releasedTextures.clear(); canFlush = true;
  state.presentation.canvasWidth = 320; state.presentation.canvasHeight = 240;
  state.presentation.surfaceWidth = 640; state.presentation.surfaceHeight = 400;
  state.presentation.currentSurfaceTextureId = 12;
  state.presentation.framePresentPending = true;
  state.registries.textureRegistry[12] = 1;
  WGPUSurfaceTexture acquired;
  acquireSurfaceImage(&state, &acquired);
  if (calls != std::vector<std::string>{"acquire", "texture", "configure", "acquire"} ||
      acquired.status != success || !acquired.texture || acquireCalls != 2 ||
      releasedTextures != std::vector<WGPUTexture>{reinterpret_cast<void*>(101)} ||
      state.presentation.currentTexture != reinterpret_cast<void*>(4) ||
      state.presentation.currentSurfaceTextureId != 12 || !state.presentation.framePresentPending ||
      state.registries.textureRegistry.count(12) != 1 ||
      lastConfig.width != 640 || lastConfig.height != 400) {
    std::cerr << "Outdated recovery invalidated bridge source or configured canvas extent\\n"; return 11;
  }
  // Persistent Outdated is returned after exactly one retry, never accepted as success.
  calls.clear(); releasedTextures.clear(); acquireCalls = 0; secondStatus = outdated;
  acquireSurfaceImage(&state, &acquired);
  if (acquireCalls != 2 || acquired.status != outdated || !acquired.texture ||
      releasedTextures.size() != 1) return 12;
  // Timeout is not a reconfigure signal; ownership stays with the caller.
  calls.clear(); releasedTextures.clear(); acquireCalls = 0; firstStatus = timeout;
  acquireSurfaceImage(&state, &acquired);
  if (calls != std::vector<std::string>{"acquire"} || acquired.status != timeout ||
      !acquired.texture || !releasedTextures.empty()) return 13;
  // A held direct SurfaceOutput may not be discarded from the recovery helper.
  calls.clear(); releasedTextures.clear(); acquireCalls = 0; firstStatus = outdated;
  state.presentation.canvasWidth = 640; state.presentation.canvasHeight = 400;
  acquireSurfaceImage(&state, &acquired);
  if (calls != std::vector<std::string>{"acquire", "texture"} || acquired.status != outdated ||
      acquired.texture || state.presentation.currentTexture != reinterpret_cast<void*>(4)) return 14;
  std::cout << "native canvas and drawable extent contract passed\\n";
}
`);
    const built = spawnSync(compiler, ["-std=c++17", "-Wall", "-Wextra", "-Werror", source, "-o", executable], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(built.status, 0, built.error?.message ?? built.stderr);
    const result = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /native canvas and drawable extent contract passed/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
