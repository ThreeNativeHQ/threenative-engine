import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const STARTER = join(import.meta.dirname, "../../../packages/terrain/starter-assets");
/** The licensed rows' triangle counts, the ceiling the cards replace them under. */
const LICENSED_TRIANGLES: Record<string, number> = {
  "grass_medium/field.glb": 765,
  "grass_medium/tuft.glb": 621,
  "grass_medium/reed.glb": 304,
  "grass_medium/mat.glb": 602,
};

function glb(path: string): { triangles: number; imageBytes: number } {
  const bytes = readFileSync(path);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  const primitives = json.meshes.flatMap((mesh: { primitives: unknown[] }) => mesh.primitives);
  const triangles = primitives.reduce(
    (sum: number, prim: { indices: number }) => sum + json.accessors[prim.indices].count / 3,
    0,
  );
  const imageBytes = json.images.reduce(
    (sum: number, image: { bufferView: number }) =>
      sum + json.bufferViews[image.bufferView].byteLength,
    0,
  );
  return { triangles, imageBytes };
}

async function grassRows(search: string) {
  vi.stubGlobal("location", { search });
  vi.resetModules();
  const { speciesFor } = await import("../src/render/props/pack.js");
  return speciesFor("forest").filter((one) => one.asset === "grass" || one.asset === "meadow");
}

afterEach(() => vi.unstubAllGlobals());

describe("the forest grass is Poly Haven art the starter ships", () => {
  it("draws every grass and meadow row from the grass_medium cards, under the licensed triangle count", async () => {
    const rows = await grassRows("");
    expect(rows.length).toBeGreaterThan(0);
    for (const one of rows) {
      expect(one.path, `${one.asset}:${one.variant}`).toMatch(
        /^grass_medium\/(field|tuft|reed|mat)\.glb$/u,
      );
      const file = join(STARTER, one.path);
      expect(existsSync(file), one.path).toBe(true);
      const { triangles, imageBytes } = glb(file);
      expect(triangles, one.path).toBeLessThanOrEqual(LICENSED_TRIANGLES[one.path] ?? 0);
      expect(imageBytes, one.path).toBeLessThanOrEqual(1024 * 1024);
    }
  });
  it("keeps the licensed set behind ?grass=fab", async () => {
    const rows = await grassRows("?grass=fab");
    expect(rows.length).toBeGreaterThan(0);
    for (const one of rows)
      expect(one.path, `${one.asset}:${one.variant}`).not.toMatch(/^grass_medium\//u);
  });
});
