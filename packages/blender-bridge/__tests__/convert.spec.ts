import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  BLENDER_SOURCE_EXTENSIONS,
  blenderScriptsDirectory,
  convertModel,
  inspectModel,
  parseBlenderResult,
} from "../src/bridge.js";
import { resolveBlender } from "../src/detect.js";

/**
 * The bridge against a real Blender. These are the only tests in this repository that spawn one, so
 * they say out loud when they cannot: a skipped gate reported as a pass is the failure mode the
 * whole verification section of PRD-346 exists to prevent.
 */

const blender = resolveBlender();
const available = blender.available;
if (!available) {
  process.stderr.write(
    `TN_BLENDER_TESTS_SKIPPED: ${blender.detail} Install Blender to run packages/blender-bridge/__tests__/convert.spec.ts.\n`,
  );
}
const withBlender = available ? describe : describe.skip;

const character = path.resolve("packages/assets/__tests__/fixtures/blender/character.fbx");

describe("bridge contract", () => {
  it("should ship the Blender script it says it runs", () => {
    const script = path.join(blenderScriptsDirectory(), "convert.py");
    const source = readFileSync(script, "utf8");
    expect(source).toContain("SPDX-License-Identifier: GPL-2.0-or-later");
    expect(source).toContain("TN_BLENDER_RESULT ");
  });

  it("should throw on malformed input rather than returning a failure result", async () => {
    await expect(inspectModel("")).rejects.toThrow(/'source' must be a non-empty path/u);
    await expect(convertModel(character, "")).rejects.toThrow(/'out' must be a non-empty path/u);
  });

  it("should read only a well-formed result line", () => {
    expect(parseBlenderResult('noise\nTN_BLENDER_RESULT {"meshes":2}\n')).toEqual({ meshes: 2 });
    expect(parseBlenderResult("noise only")).toBeUndefined();
    expect(parseBlenderResult("TN_BLENDER_RESULT {not json")).toBeUndefined();
  });

  it("should list the extensions the asset pass classifies as models", () => {
    expect([...BLENDER_SOURCE_EXTENSIONS].sort()).toEqual(["blend", "dae", "fbx", "obj"]);
  });
});

withBlender("blender_convert against a real Blender", () => {
  it("should report the same counts blender_inspect reported", async () => {
    const root = await makeTempDir("tn-blender-convert-");
    try {
      const inspected = await inspectModel(character);
      const converted = await convertModel(character, path.join(root, "out.glb"));
      expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
      expect(converted.ok, JSON.stringify(converted)).toBe(true);
      if (!inspected.ok || !converted.ok) return;
      // Both readings come from the same source through the same importer, so a difference is the
      // convert path having changed the scene before measuring it.
      for (const key of ["bones", "meshes", "triangles", "vertices"] as const) {
        expect(converted.summary[key], key).toBe(inspected.summary[key]);
      }
      expect(converted.summary.materials).toEqual(inspected.summary.materials);
      expect(converted.summary.clips).toEqual(inspected.summary.clips);
      expect(converted.summary.outBytes).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 180_000);

  it("should refuse a scene with no meshes instead of writing an empty glb", async () => {
    const root = await makeTempDir("tn-blender-empty-");
    try {
      const empty = path.join(root, "empty.obj");
      await writeFile(empty, "# no geometry\n");
      const result = await convertModel(empty, path.join(root, "out.glb"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.cause).toBe("no-meshes");
      expect(result.stderr ?? "").toContain("produced no meshes");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 180_000);
});
