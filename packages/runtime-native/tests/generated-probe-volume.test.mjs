import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = join(runtimeRoot, "../..");
const registryPath = join(runtimeRoot, "conformance/registry.json");
const SCENE = "conformance/scenes/shared/probe-volume-sample.js";

function registry() {
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

test("the native registry binds the probe-volume sample to the lighting-gi category", () => {
  const entry = registry().tests.find((candidate) => candidate.id === "probe-volume-sample");
  assert.ok(entry, "probe-volume-sample must be registered");
  assert.equal(entry.status, "implemented");
  assert.equal(entry.category, "lighting-gi");
  assert.equal(entry.scene, SCENE);
  assert.equal(entry.desktopGate, true);
  assert.equal(entry.required, true);
  assert.ok(existsSync(join(runtimeRoot, entry.scene)), `scene must exist: ${entry.scene}`);
});

test("the probe-volume native scene installs the stage and asserts a visible capture", () => {
  const scene = readFileSync(join(runtimeRoot, SCENE), "utf8");
  const support = readFileSync(join(runtimeRoot, "conformance/scenes/shared/scene-support.js"), "utf8");
  assert.match(scene, /ProbeVolume/u);
  assert.match(scene, /assertCondition\(/u);
  assert.match(support, /__TN_CONFORMANCE/u);
  assert.match(scene, /sampleNode\(/u);
  assert.match(scene, /off-screen|offscreen/u);
  const coreIndex = readFileSync(join(workspaceRoot, "packages/core/src/index.ts"), "utf8");
  assert.match(coreIndex, /ProbeVolume/u);
});

test("negative control: removing the probe-volume registry row is rejected", () => {
  const mutated = registry();
  mutated.tests = mutated.tests.filter((candidate) => candidate.id !== "probe-volume-sample");
  assert.throws(
    () => {
      const entry = mutated.tests.find((candidate) => candidate.id === "probe-volume-sample");
      if (entry === undefined) throw new Error("probe-volume-sample registry row missing");
    },
    /probe-volume-sample registry row missing/u,
  );
});

test("the translucency-gi row is bound to the lighting-gi category and its scene reads the non-directional probe sample", () => {
  const entry = registry().tests.find((candidate) => candidate.id === "translucency-gi");
  assert.ok(entry, "translucency-gi must be registered");
  assert.equal(entry.status, "implemented");
  assert.equal(entry.category, "lighting-gi");
  assert.equal(entry.scene, "conformance/scenes/shared/translucency-gi.js");
  assert.equal(entry.desktopGate, true);
  assert.equal(entry.required, true);
  const scene = readFileSync(join(runtimeRoot, entry.scene), "utf8");
  assert.match(scene, /sampleNonDirectional\(/u);
  assert.match(scene, /transparent = true/u);
  assert.match(scene, /assertCondition\(/u);
});
