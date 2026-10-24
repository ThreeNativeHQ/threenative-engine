import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const workspaceRoot = join(runtimeRoot, "../..");
const registryPath = join(runtimeRoot, "conformance/registry.json");
const PROOF_ID = "native-render-chain";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function registeredProof(registry = readJson(registryPath)) {
  const entry = registry.generatedPlaytestProofs?.find((candidate) => candidate.id === PROOF_ID);
  if (entry === undefined) {
    throw new Error(`RED observed: native composed-chain scenario missing (${PROOF_ID} is not registered)`);
  }
  return entry;
}

test("the conformance registry binds the composed render-chain scenario to desktop and Android", () => {
  const entry = registeredProof();
  assert.equal(entry.status, "implemented");
  assert.equal(entry.category, "rendering");
  assert.match(entry.runner ?? "", /--target desktop/u);
  assert.match(entry.runner ?? "", /--target android/u);
  assert.match(entry.reason ?? "", /non-blank/u);

  const scenarioPath = join(runtimeRoot, entry.scenario);
  assert.ok(existsSync(scenarioPath), `scenario must exist: ${entry.scenario}`);
  const scenario = readJson(scenarioPath);
  const finishing = ["bloom", "vignette", "antialias"];
  const excluded = ["grade", "grain"];
  const fullChain = {
    contributions: { graphOutputChanged: ["ambientOcclusion", "motionBlur", ...finishing] },
    stages: {
      includes: ["ambientOcclusion", "motionBlur", ...finishing],
      excludes: excluded,
      order: ["ambientOcclusion", "motionBlur", ...finishing],
    },
    tier: "high",
  };
  const mediumChain = {
    contributions: { graphOutputChanged: ["ambientOcclusion", ...finishing] },
    stages: {
      includes: ["ambientOcclusion", ...finishing],
      excludes: ["motionBlur", ...excluded],
      order: ["ambientOcclusion", ...finishing],
    },
    tier: "medium",
  };
  const lowChain = {
    contributions: { graphOutputChanged: finishing },
    stages: {
      includes: finishing,
      excludes: ["ambientOcclusion", "motionBlur", ...excluded],
      order: finishing,
    },
    tier: "low",
  };
  assert.deepEqual(scenario.assert?.renderChain, {
    ...fullChain,
    perAdapter: {
      integrated: mediumChain,
      "mobile-high": mediumChain,
      "mobile-low": lowChain,
      "mobile-mid": lowChain,
      software: lowChain,
    },
  });
  assert.deepEqual(scenario.artifacts, { screenshots: "after" });
  assert.equal(scenario.target, "desktop");

  const postprocessing = readFileSync(
    join(workspaceRoot, "packages/create-threenative/templates/starter/src/render/postprocessing.ts"),
    "utf8",
  );
  assert.match(postprocessing, /new WorldEnvironment/u);
  assert.match(postprocessing, /world\.apply\(renderer, scene, camera/u);

  const worldEnvironment = readFileSync(
    join(workspaceRoot, "packages/create-threenative/templates/starter/src/render/worldEnvironment.ts"),
    "utf8",
  );
  assert.match(worldEnvironment, /renderer\.createRenderChain/u);
  assert.match(worldEnvironment, /name: "sharpen"/u);
  assert.match(worldEnvironment, /name: "bloom"/u);
});

test("negative control: removing the composed-chain registry proof is rejected", () => {
  const registry = readJson(registryPath);
  const mutated = structuredClone(registry);
  mutated.generatedPlaytestProofs = mutated.generatedPlaytestProofs.filter(
    (entry) => entry.id !== PROOF_ID,
  );
  assert.throws(() => registeredProof(mutated), /native composed-chain scenario missing/u);
});
