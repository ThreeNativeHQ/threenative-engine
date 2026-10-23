import { ACESFilmicToneMapping, CustomToneMapping, PerspectiveCamera, Scene } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { type OutputRenderer, WorldEnvironment } from "../src/look/world-environment.js";

// Owner 2026-10-22: a scene with no look options gets a fresh Unreal 5.8.3 project's look (PRD-722 Phase 2).
afterEach(() => vi.restoreAllMocks());

function renderer(kind: string, raw: object = {}) {
  const requested: { stages?: readonly string[]; tier?: string }[] = [];
  const target: OutputRenderer = {
    kind,
    raw,
    createRenderChain(options) {
      requested.push(options.request ?? {});
      return { applied: { stages: [], dropped: [] }, dispose() {} };
    },
  };
  return { requested, target };
}

function apply(options: ConstructorParameters<typeof WorldEnvironment>[0], target: OutputRenderer) {
  new WorldEnvironment(options).apply(target, new Scene(), new PerspectiveCamera())?.dispose?.();
}

it("starts a WebGPU renderer on Unreal's filmic curve and the high tier with no options", () => {
  const addToneMapping = vi.fn();
  const raw: { toneMapping?: number; library: object } = { library: { addToneMapping } };
  const { requested, target } = renderer("webgpu", raw);
  apply({}, target);
  expect(raw.toneMapping).toBe(CustomToneMapping);
  expect(addToneMapping).toHaveBeenCalledTimes(1);
  expect(requested[0]?.tier).toBe("high");
  expect(requested[0]?.stages).toEqual(
    expect.arrayContaining(["ambientOcclusion", "bloom", "antialias"]),
  );
});

it('keeps "aces" as the named override and installs no custom curve', () => {
  const addToneMapping = vi.fn();
  const raw: { toneMapping?: number; library: object } = { library: { addToneMapping } };
  apply({ tonemapMode: "aces" }, renderer("webgpu", raw).target);
  expect(raw.toneMapping).toBe(ACESFilmicToneMapping);
  expect(addToneMapping).not.toHaveBeenCalled();
});

function report(options: ConstructorParameters<typeof WorldEnvironment>[0], kind: string) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return new WorldEnvironment(options).apply(
    renderer(kind).target,
    new Scene(),
    new PerspectiveCamera(),
  );
}

it("defaults auto exposure on, so a renderer without WebGPU reports the fixed fallback", () => {
  expect(report({}, "webgl2").dropped).toContainEqual({
    name: "autoExposure",
    reason: "renderer:webgl2",
  });
});

it("keeps autoExposureEnabled: false as the named override for the fixed exposure", () => {
  const dropped = report({ autoExposureEnabled: false }, "webgl2").dropped.map((d) => d.name);
  expect(dropped).not.toContain("autoExposure");
});

it("starts from the tier named by renderChainTier, and an explicit option beats the tier", () => {
  const { requested, target } = renderer("webgpu", { library: { addToneMapping() {} } });
  apply({ renderChainTier: "low" }, target);
  apply({ gtaoEnabled: false, bloomEnabled: false }, target);
  expect(requested[0]?.tier).toBe("low");
  expect(requested[0]?.stages).not.toContain("ambientOcclusion");
  expect(requested[1]?.stages).not.toContain("ambientOcclusion");
  expect(requested[1]?.stages).not.toContain("bloom");
});

it("does not let an undefined option cancel the preset", () => {
  const { requested, target } = renderer("webgpu", { library: { addToneMapping() {} } });
  apply({ gtaoEnabled: undefined }, target);
  expect(requested[0]?.stages).toContain("ambientOcclusion");
});
