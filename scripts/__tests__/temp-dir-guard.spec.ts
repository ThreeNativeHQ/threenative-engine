import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const tempCreatorPattern = /\bmkdtemp(?:Sync)?\s*\(/u;

const allowedProductionCreators = new Map<string, string>([
  [
    "packages/terrain/src/kit-assets.ts",
    "The starter-asset archive extracts into a sibling scratch directory renamed into the cache and removed in finally.",
  ],
  [
    "packages/assets/src/watch.ts",
    "The dev watcher stages each changed input through a scratch project removed in finally.",
  ],
  ["packages/playtest/src/runner/android.ts", "Android mailbox staging is removed in finally."],
  [
    "packages/runtime-native/scripts/verify-ui-cadence.ts",
    "The visible UI gate removes its owned probe after success and retains failed builds for diagnosis.",
  ],
  [
    "packages/playtest/src/runner/captureLock.ts",
    "The holder staging directory is removed immediately after the atomic rename.",
  ],
  ["packages/playtest/src/runner/ios.ts", "iOS device staging is removed in finally."],
  [
    "scripts/check-capability-examples.ts",
    "Each compile round writes its cases to one staging directory removed in finally.",
  ],
  [
    "packages/playtest/src/runner/videoAnalysis.ts",
    "Video frames are removed by the analysis finally.",
  ],
  [
    "packages/playtest/src/runner/desktopRunner.ts",
    "The production desktop runner removes its owned mailbox root in finally.",
  ],
  [
    "scripts/check-publish-state.ts",
    "The tarball gate packs into a scratch directory removed in finally.",
  ],
  ["scripts/profile-starter.ts", "The production profile removes its root in finally."],
  ["scripts/sweep-proof.ts", "The production proof gate removes roots in finally."],
  [
    "scripts/performance-regression/cpu.ts",
    "CPU capture and comparison artifacts are deliberately retained outputs; the isolated comparison scratch is removed in finally.",
  ],
  [
    "scripts/sync-mcp-configs.ts",
    "The host-config sync round-trips each template through a scratch copy removed in finally.",
  ],
  ["scripts/template-baseline.ts", "The production baseline gate removes its root in finally."],
  ["scripts/verify-forest-playtest.ts", "The forest proof gate removes its root in finally."],
  ["scripts/verify-golden-path.ts", "The production golden-path gate removes roots in finally."],
  ["scripts/verify-one-template.ts", "The production template gate owns its cleanup."],
  [
    "scripts/verify-one-template-desktop.ts",
    "The native half of that gate, for the same reason: the scaffold it builds is the artifact an operator reads after the run.",
  ],
  [
    "scripts/verify-template-playtests.ts",
    "The production template playtest gate owns its cleanup.",
  ],
  ["scripts/release.ts", "The release packer removes its temporary tarball directory in finally."],
  [
    "scripts/release-candidate-gate.ts",
    "The release-candidate gate removes its downloaded report staging directory in finally.",
  ],
  [
    "scripts/__tests__/release-candidate-gate.spec.ts",
    "The release-candidate tests remove their tarball fixture staging directory in finally.",
  ],
  [
    "scripts/verify-registry-install.ts",
    "The production registry probe removes its parent in finally.",
  ],
  ["scripts/visual-gate.ts", "The production visual gate removes its root in finally."],
  [
    "scripts/bake-delete-test.ts",
    "The delete-test gate removes the scaffold it created in finally.",
  ],
  [
    "scripts/realism-effects-visual.ts",
    "The production realism-effects visual gate removes its bundle root in finally.",
  ],
  [
    "scripts/exposure-ab.ts",
    "The production exposure A/B gate removes its bundle root in finally.",
  ],
  [
    "packages/assets/src/passes/blender-import.ts",
    "Blender reads paths, not buffers; the per-input staging directory is removed in finally.",
  ],
  [
    "packages/blender-mcp/src/bridge.ts",
    "The Blender subprocess gets a private TMPDIR so its scratch files cannot outlive it; the directory is removed in finally.",
  ],
  [
    "packages/runtime-native/tests/async-image-decode.test.mjs",
    "The decode contract compiles a standalone probe with the system compiler into a scratch root and removes it in afterAll; the test runs under `node --test` as well as vitest, so it cannot import the workspace temp-dir helper.",
  ],
  [
    "packages/runtime-native/tests/resize-presentation-behavior.test.mjs",
    "The presentation contract compiles a standalone probe with the system compiler into a scratch root and removes it in a finally, for the same reason as the decode contract above.",
  ],
  [
    "scripts/capture-blender-mcp-tools.ts",
    "The tool-snapshot gate packs and installs into scratch roots removed in finally.",
  ],
  [
    "scripts/capture-asset-mcp-tools.ts",
    "The asset-MCP tool snapshot installs the pinned published package into a scratch root it pushes onto `scratch` and removes in finally, for the same reason as the Blender one above.",
  ],
  [
    "packages/runtime-native/tests/native-engine/post-normal-pass.ts",
    "The CTest probe writes its fixture and readback under its caller's build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/flip-reference.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-async-bridge.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-batched-mesh.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-free-run.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-gc.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-geometry-utils.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-imports.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-render-target.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-textures.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-canvas-decal.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-canvas2d.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-compile-reentry.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-frame-per-present.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-real-input.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-thread-placement.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-ui-overlay.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-window-title.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/playtest/src/runner/linuxCpuWindow.ts",
    "The CPU window collector removes its fixture directory in a finally block, and a killed run leaves only its own tagged directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-crossing-budget.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-host-projection.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/__tests__/starter-post-bundle.spec.ts",
    "The bundler resolves packages from the package directory, so the staging directory sits inside it and the spec removes it in afterAll.",
  ],
  [
    "packages/runtime-native/tests/distribution.test.mjs",
    "The packed cohort tarballs outlive the test that asks for them, so the suite removes them in afterAll.",
  ],
  [
    "packages/runtime-native/tests/native-engine/compute-harness.mjs",
    "The harness stages its bundle under the package's untracked build directory and removes it in a finally block.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-read-target-osr.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-tsl-values.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-ui-bridge.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-ui-input.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/template-post-packages.ts",
    "The compiler CLI retains authored graphs, emitted modules and Tint outputs under its caller's build directory for diagnosis.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-frame-rule.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-gpu-stages.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "packages/runtime-native/tests/native-engine/player-temporal-aa.mjs",
    "The CTest probe stages its bundle and fixtures under the package's untracked build directory, not the OS temp directory.",
  ],
  [
    "scripts/unreal-look/giLocks.ts",
    "The offline compare root links a capture folder into a scratch root removed in finally.",
  ],
  [
    "packages/three-native/tests/compatibility/run-native.ts",
    "The conformance CLI retains captured frames because failed pixel-comparison reports name their paths.",
  ],
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolute)));
      continue;
    }
    const isTypeScript = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
    const isRuntimeNativeTest =
      entry.name.endsWith(".mjs") &&
      (absolute.includes(`${path.sep}tests${path.sep}`) || entry.name.includes(".test."));
    if (isTypeScript || isRuntimeNativeTest) files.push(absolute);
  }
  return files;
}

async function unregisteredTempCreators(): Promise<string[]> {
  const files = [
    ...(await sourceFiles(path.join(repositoryRoot, "packages"))),
    ...(await sourceFiles(path.join(repositoryRoot, "scripts"))),
    path.join(repositoryRoot, "playwright.config.ts"),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
    if (relative === "test-support/temp-dir.ts" || allowedProductionCreators.has(relative))
      continue;
    if (tempCreatorPattern.test(await readFile(file, "utf8"))) offenders.push(relative);
  }
  return offenders.sort();
}

describe("temporary directory guard", () => {
  it("requires every test-owned temporary directory to register cleanup", async () => {
    const offenders = await unregisteredTempCreators();
    expect(offenders, "unregistered temporary directory creators").toEqual([]);
  });
});
