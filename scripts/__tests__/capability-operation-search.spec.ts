import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { searchCapabilities } from "../../packages/engine-mcp/src/index.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { buildCapabilityManifest } from "../build-capability-manifest.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
let directory: string | undefined;
let manifestFile: string;

beforeAll(async () => {
  directory = await makeTempDir("threenative-operation-search-");
  manifestFile = join(directory, "capabilities.json");
  // Rebuild from source: a hand-edited JSON fixture cannot prove a metadata correction.
  await writeFile(manifestFile, JSON.stringify(buildCapabilityManifest(root)));
  // No local cap: the manifest is rebuilt from source, and a 30 s one timed out on a loaded hosted
  // runner (merge-group run 42339946231, 3960 tests passed around it). The suite's `hookTimeout`.
});

afterAll(async () => {
  if (directory !== undefined) await rm(directory, { force: true, recursive: true });
});

test.each([
  [
    "run a browser playtest with Vulkan WebGPU",
    "resolveBrowserArguments",
    "reconcileBrowserPointers",
  ],
  [
    "wait or hold a game for a deterministic number of ticks",
    "playtestStepWaitTicks",
    "invalidScenario",
  ],
  ["load a deterministic tick-based playtest scenario", "loadPlaytestScenario", "invalidScenario"],
])("%s selects the callable shown by its example", (query, expected, wrong) => {
  const response = searchCapabilities(query, manifestFile);
  expect(response.verdict).toBe("matched");
  expect(response.results[0]?.symbol).toBe(expected);
  expect(response.results[0]?.example).toContain(`${expected}(`);
  expect(response.results.map(({ symbol }) => symbol)).not.toContain(wrong);
});
