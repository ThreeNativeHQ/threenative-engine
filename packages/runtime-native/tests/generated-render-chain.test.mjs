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
  // Sharp AA on every tier (owner, 2026-10-28): 4x MSAA plus the SMAA antialias stage, no temporal AA and no
  // camera motion blur. High adds SSGI over medium; low drops the contact occlusion and SSR.
  const finishing = ["bloom", "vignette", "antialias"];
  const excluded = ["traa", "motionBlur", "grade", "grain"];
  const chain = (stages, dropped, tier) => ({
    contributions: { graphOutputChanged: [...stages, ...finishing] },
    stages: {
      includes: [...stages, ...finishing],
      excludes: [...dropped, ...excluded],
      order: [...stages, ...finishing],
    },
    tier,
  });
  const fullChain = chain(["ambientOcclusion", "ssgi", "ssr"], [], "high");
  const mediumChain = chain(["ambientOcclusion", "ssr"], ["ssgi"], "medium");
  // PRD-871 turned SSR off on the low tier (core `look/quality.ts`).
  const lowChain = chain([], ["ambientOcclusion", "ssgi"], "low");
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
  assert.match(postprocessing, /import \{[^}]*WorldEnvironment[^}]*\} from "@threenative\/core"/u);
  assert.match(postprocessing, /world\.apply\(renderer, scene, camera/u);

  const worldEnvironment = readFileSync(
    join(workspaceRoot, "packages/core/src/look/world-environment.ts"),
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
