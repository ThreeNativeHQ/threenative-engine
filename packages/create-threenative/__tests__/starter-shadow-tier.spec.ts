import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("three/addons/loaders/LUTCubeLoader.js", () => ({
  LUTCubeLoader: class {
    setType(): this {
      return this;
    }
    loadAsync(): Promise<never> {
      return new Promise(() => undefined);
    }
  },
}));
vi.mock("@threenative/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@threenative/core")>()),
  WorldEnvironment: class {
    apply() {
      return { dispose: () => undefined, dropped: [], stages: [] };
    }
  },
}));

const { setupPost } = await import("../templates/starter/src/render/postprocessing.js");

const shadowMapAt = (options: Parameters<typeof setupPost>[3]) => {
  const shadowMap = { enabled: true };
  const post = setupPost(
    { kind: "webgpu", raw: { shadowMap } } as never,
    {} as never,
    {} as never,
    options,
  );
  return { shadowMap, post };
};

describe("starter post chain applies the tier's shadows (PRD-871)", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => dispose?.());

  it("draws no shadow pass at the low tier, which casts none", () => {
    const { shadowMap, post } = shadowMapAt({ tier: "low" });
    dispose = () => post.dispose();
    expect(shadowMap.enabled).toBe(false);
    expect(post.debug()).toMatchObject({ shadows: { enabled: false, source: "tier" } });
  });

  it("keeps shadows at the medium and high tiers", () => {
    for (const tier of ["medium", "high"] as const) {
      const { shadowMap, post } = shadowMapAt({ tier });
      expect(shadowMap.enabled).toBe(true);
      post.dispose();
    }
  });

  it("keeps the game's own shadow choice and reports the override", () => {
    const { shadowMap, post } = shadowMapAt({ tier: "low", shadows: true });
    dispose = () => post.dispose();
    expect(shadowMap.enabled).toBe(true);
    expect(post.debug()).toMatchObject({ shadows: { enabled: true, source: "override" } });
  });
});
