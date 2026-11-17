// The forest kit copies each tree's vertices (cards, radial coverage, LOD rungs), so the PRD-860
// in-place upgrade of a streamed model never reaches its copy. Loaded without `whole: true`, every
// crown kept the coarse companion forever (near 1,298 of 4,988 leaf-card triangles, mid 247 of
// 920): crowns dissolved into stray dark specks.
import { describe, expect, it } from "vitest";
import { loadPack } from "../starter/forest/render/props/pack.js";
import { loadPreparedProps } from "../starter/forest/render/props/prepared.js";

function recordingLoader() {
  const models: { path: string; whole: boolean }[] = [];
  const loader = {
    model: (path: string, options?: { whole?: boolean }) => {
      models.push({ path, whole: options?.whole === true });
      return Promise.reject(new Error("no file"));
    },
    texture: () => Promise.reject(new Error("no file")),
    resolve: () => Promise.resolve([]),
  };
  return { loader: loader as never, models };
}

describe("the forest kit's copied tree models", () => {
  it("should load every pack model whole", async () => {
    const { loader, models } = recordingLoader();
    await loadPack(loader);
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((one) => !one.whole)).toEqual([]);
  });

  it("should load every prepared model whole", async () => {
    const { loader, models } = recordingLoader();
    await loadPreparedProps(loader);
    expect(models.length).toBeGreaterThan(0);
    expect(models.filter((one) => !one.whole)).toEqual([]);
  });
});
