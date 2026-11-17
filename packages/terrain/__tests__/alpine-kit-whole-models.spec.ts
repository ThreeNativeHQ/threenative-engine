// The alpine kit copies each tree's vertices like the forest kit, so it loads every model whole:
// the PRD-860 in-place upgrade of a streamed model never reaches a copy (forest-kit-whole-models).
import { describe, expect, it } from "vitest";
import { loadPack } from "../starter/alpine/render/props/pack.js";
import { loadPreparedProps } from "../starter/alpine/render/props/prepared.js";

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

describe("the alpine kit's copied tree models", () => {
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
