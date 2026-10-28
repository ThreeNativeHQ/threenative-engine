import { PerspectiveCamera, Scene, Texture } from "three";
import { texture, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";
import { expect, it } from "vitest";
import {
  type ChainStage,
  type IWorldEnvironmentOptions,
  type OutputRenderer,
  WorldEnvironment,
} from "../../../test-support/isolated-world-environment.js";

type ChainOptions = Parameters<NonNullable<OutputRenderer["createRenderChain"]>>[0];

/** The chain request WorldEnvironment makes, with `info.engine` present (the owned engine) or absent (three.js). */
function request(
  options: IWorldEnvironmentOptions,
  engine: boolean,
): {
  chain: ChainOptions;
  report: { dropped: readonly { name: string; reason: string }[]; stages: readonly string[] };
} {
  let chain: ChainOptions | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: { info: engine ? { engine: {} } : {} },
    createRenderChain(received) {
      chain = received;
      return {
        applied: { stages: received.request?.stages ?? [], dropped: [] },
        dispose() {},
      };
    },
  };
  const report = new WorldEnvironment(options).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  if (chain === undefined) throw new Error("the chain was never created");
  return { chain, report };
}

function stageNamed(chain: ChainOptions, name: string): ChainStage {
  const stage = chain.stages?.find((entry) => entry.name === name);
  if (stage === undefined) throw new Error(`${name} stage missing`);
  return stage;
}

it("resolves temporally ahead of the spatial filter on the owned engine", () => {
  const { chain, report } = request({ temporalAA: true }, true);
  expect(chain.request?.stages).toContain("traa");
  expect(chain.request?.stages).not.toContain("antialias");
  expect(chain.request?.velocity?.provision).toBeDefined();
  expect(report.dropped).toContainEqual({ name: "antialias", reason: "traa resolves the edges" });
});

it("keeps the spatial filter on three.js and says why the temporal pass is refused", () => {
  const { chain, report } = request({ temporalAA: true }, false);
  expect(chain.request?.stages).toContain("antialias");
  expect(chain.request?.stages).not.toContain("traa");
  expect(chain.request?.velocity?.provision).toBeUndefined();
  expect(report.dropped).toContainEqual({ name: "traa", reason: "engine:threejs" });
});

it("is off until a tier asks for it", () => {
  const { chain, report } = request({}, true);
  expect(chain.request?.stages).toContain("antialias");
  expect(chain.request?.stages).not.toContain("traa");
  expect(report.dropped.map((entry) => entry.name)).not.toContain("traa");
});

it("draws the velocity the temporal pass resolves with, and names it when the chain gave none", () => {
  const stage = stageNamed(request({ temporalAA: true }, true).chain, "traa");
  const velocity = texture(new Texture()) as TextureNode;
  const input = vec4(0) as Node;
  expect(stage.build(input, { tier: "high", velocityNode: velocity })).not.toBe(input);
  expect(() => stage.build(input, { tier: "high" })).toThrow(/velocity/u);
});

it("lets a kit's own traa stage replace the built-in one, so the chain sees the name once", () => {
  const kit: ChainStage = { name: "traa", build: (input) => input };
  const { chain } = request(
    { temporalAA: true, authoredStageNames: ["traa"], authoredStages: () => [kit] },
    true,
  );
  expect(chain.stages?.filter((entry) => entry.name === "traa")).toEqual([kit]);
  expect(chain.request?.stages?.filter((name) => name === "traa")).toHaveLength(1);
});

it("leaves a kit's traa stage out until the kit names it", () => {
  const kit: ChainStage = { name: "traa", build: (input) => input };
  const { chain } = request({ temporalAA: true, authoredStages: () => [kit] }, true);
  const found = chain.stages?.filter((entry) => entry.name === "traa") ?? [];
  expect(found).toHaveLength(1);
  expect(found[0]).not.toBe(kit);
});

it("keeps offered authored reconstruction detail dormant when temporal AA is explicitly disabled", () => {
  const detail: ChainStage = {
    name: "sharpen",
    build: () => {
      throw new Error("disabled temporal detail built");
    },
  };
  const { chain } = request(
    { temporalAA: false, authoredStageNames: [], authoredStages: () => [detail] },
    true,
  );
  expect(chain.request?.stages).not.toContain("traa");
  expect(chain.request?.stages).not.toContain("sharpen");
});
