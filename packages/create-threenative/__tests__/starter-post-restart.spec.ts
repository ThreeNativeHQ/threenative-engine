import { Data3DTexture, FloatType } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applied: number[] = [];
const loads: string[] = [];

vi.mock("three/addons/loaders/LUTCubeLoader.js", () => ({
  LUTCubeLoader: class {
    setType(): this {
      return this;
    }
    loadAsync(url: string): Promise<{ size: number; texture3D: Data3DTexture }> {
      loads.push(url);
      const texture3D = new Data3DTexture(new Float32Array(2 * 2 * 2 * 4), 2, 2, 2);
      texture3D.type = FloatType;
      return Promise.resolve({ size: 2, texture3D });
    }
  },
}));
vi.mock("../templates/starter/src/render/worldEnvironment.js", () => ({
  WorldEnvironment: class {
    apply() {
      applied.push(applied.length);
      return { dispose: () => undefined, dropped: [], stages: [] };
    }
  },
}));

const { setupPost } = await import("../templates/starter/src/render/postprocessing.js");

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const post = (): ReturnType<typeof setupPost> =>
  setupPost({} as never, {} as never, {} as never, { tier: "low" });

describe("starter post chain across a restart (PRD-637)", () => {
  beforeEach(() => {
    applied.length = 0;
    loads.length = 0;
  });

  it("builds the chain once on a restart, because the grade table is already loaded", async () => {
    const first = post();
    await settle();
    // First entry: the chain, then the chain again once grade.cube arrives.
    expect(applied).toHaveLength(2);
    first.dispose();
    applied.length = 0;
    loads.length = 0;
    const second = post();
    await settle();
    // A restart rebuilt the chain a second time and compiled it twice, and the world stayed black
    // for both. The table does not change between entries, so it is neither fetched nor rebuilt.
    expect(loads).toEqual([]);
    expect(applied).toHaveLength(1);
    second.dispose();
  });
});
