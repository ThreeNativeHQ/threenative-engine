/**
 * PRD-892: a streamed kit grows its Arbor plants in the bake (`world.arbor`), so no kit carries a
 * hand-run flora script or baked GLBs in the starter assets.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { growKitArborArt } from "../src/population/arbor-species.js";

const root = path.resolve(import.meta.dirname, "..");
const outs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "terrain-kit-arbor-"));
  outs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of outs) rmSync(dir, { recursive: true, force: true });
});
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("world.arbor in a streamed kit bake", () => {
  it("writes each level as <stem><suffix>.glb, the same bytes every bake", async () => {
    const rows = { "kit_flora/twig": { preset: "twig", seed: 1, lods: { "0": "" } } };
    const [first] = await growKitArborArt(rows, root, scratch());
    const [again] = await growKitArborArt(rows, root, scratch());
    expect(first?.endsWith(path.join("kit_flora", "twig.glb"))).toBe(true);
    expect(sha(first as string)).toBe(sha(again as string));
  }, 120_000);

  it("fails closed on a preset Arbor does not have", async () => {
    await expect(
      growKitArborArt(
        { x: { preset: "no-such-plant", seed: 1, lods: { "0": "" } } },
        root,
        scratch(),
      ),
    ).rejects.toThrow(/names no Arbor preset 'no-such-plant'/u);
  });
});
