import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const profile = await import(
  new URL("../../packages/runtime-native/scripts/desktop-build-profile.mjs", import.meta.url).href
);
const qualification = await import(new URL("../ci-native-qualification.mjs", import.meta.url).href);
const coverage = await import(
  new URL("../../packages/runtime-native/scripts/native-test-lane.mjs", import.meta.url).href
);
describe("shipping desktop identity preserves measured coverage defaults", () => {
  it("keeps the coverage lane default preset equivalent without importing the shipping helper", () => {
    expect(profile.desktopPreset()).toBe(coverage.desktopPreset());
    expect(profile.desktopBuildOverrides()).toEqual(
      profile.desktopBuildOverrides(process.platform, process.arch),
    );
    const coverageSource = readFileSync(
      new URL("../../packages/runtime-native/scripts/native-test-lane.mjs", import.meta.url),
      "utf8",
    );
    expect(coverageSource).not.toContain("desktop-build-profile");
    const build = readFileSync(
      new URL("../../packages/runtime-native/scripts/native-build.mjs", import.meta.url),
      "utf8",
    );
    expect(build).toContain("import { desktopBuildOverrides } from './desktop-build-profile.mjs'");
    expect(build).toContain("Object.entries(desktopBuildOverrides())");
  });
  it.each([
    ["darwin", "tn-macos"],
    ["win32", "tn-windows"],
    ["linux", "tn-linux"],
  ])("matches supported %s preset", (platform, expected) => {
    expect(profile.desktopPreset(platform)).toBe(expected);
  });
  it("reports V8/wgpu in the arm64 CI envelope", () => {
    expect(
      qualification.nativeBuildProfile({ job: "starter-linux", platform: "linux-arm64" }),
    ).toEqual({
      buildVariant: "Release",
      backend: "wgpu",
      engine: "V8",
    });
  });
  it("selects V8/wgpu explicitly on Linux ARM64", () => {
    expect(profile.desktopBuildOverrides("linux", "arm64")).toEqual({
      MYSTRAL_USE_V8: "ON",
      MYSTRAL_USE_QUICKJS: "OFF",
      MYSTRAL_USE_DAWN: "OFF",
      MYSTRAL_USE_WGPU: "ON",
    });
    expect(
      Object.entries(profile.desktopBuildOverrides("linux", "arm64")).map(
        ([key, value]) => `-D${key}=${value}`,
      ),
    ).toEqual([
      "-DMYSTRAL_USE_V8=ON",
      "-DMYSTRAL_USE_QUICKJS=OFF",
      "-DMYSTRAL_USE_DAWN=OFF",
      "-DMYSTRAL_USE_WGPU=ON",
    ]);
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["darwin", "arm64"],
      ["win32", "x64"],
    ])
      expect(profile.desktopBuildOverrides(platform, arch)).toEqual({});
  });
});
