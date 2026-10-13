import { PerspectiveCamera, Scene, Texture } from "three";
import BloomNode from "three/addons/tsl/display/BloomNode.js";
import { rtt, texture, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { expect, it, vi } from "vitest";
import { type OutputRenderer, WorldEnvironment } from "../template-assets/worldEnvironment.js";

it.each([undefined, 0, 4])(
  "honours authored world-pass samples %s without removing post AA",
  (samples) => {
    let observed: number | undefined;
    let requested: readonly string[] | undefined;
    const renderer: OutputRenderer = {
      kind: "webgpu",
      raw: {},
      createRenderChain(options) {
        observed = (options.worldPass as { options: { samples?: number } }).options.samples;
        requested = options.request?.stages;
        return { applied: { stages: [], dropped: [] }, dispose() {} };
      },
    };
    const applied = new WorldEnvironment({ gtaoEnabled: true, samples }).apply(
      renderer,
      new Scene(),
      new PerspectiveCamera(),
    );
    expect(observed).toBe(samples);
    expect(requested).toContain("antialias");
    applied.dispose?.();
  },
);

it("releases the bloom effect and its materialized input when its chain is replaced", () => {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain(options) {
      const bloomStage = options.stages?.find((stage) => stage.name === "bloom");
      if (bloomStage === undefined) throw new Error("bloom stage missing");
      const graph = bloomStage.build(options.input, { tier: "low" }) as Node;
      graph.traverse((node) => {
        if (!(node instanceof BloomNode)) return;
        releases.push(vi.spyOn(node, "dispose"));
        const scratch = node.inputNode as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        };
        releases.push(vi.spyOn(scratch.renderTarget, "dispose"));
        releases.push(vi.spyOn(scratch._quadMesh.material, "dispose"));
      });
      return {
        applied: { stages: ["bloom"], dropped: [] },
        dispose: () => bloomStage.dispose?.(),
      };
    },
  };
  const applied = new WorldEnvironment({ bloomEnabled: true }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  expect(releases).toHaveLength(3);
  applied.dispose?.();
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

it("keeps default exposure direct and installs the authored opt-in on its existing world pass", () => {
  const output = vi.fn();
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    setOutputNode: output,
    clearOutputNode: vi.fn(),
  };
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const direct = new WorldEnvironment({ exposure: 0.62, bloomEnabled: false }).apply(
    renderer,
    scene,
    camera,
  );
  expect(output).not.toHaveBeenCalled();
  expect(direct.exposure).toBeUndefined();
  expect(renderer.raw).toMatchObject({ toneMappingExposure: 0.62 });

  const installed = new WorldEnvironment({ autoExposureEnabled: true, bloomEnabled: false }).apply(
    renderer,
    scene,
    camera,
  );
  expect(output).toHaveBeenCalledTimes(1);
  const worldPass = output.mock.calls[0]?.[1] as { dispose(): void };
  expect(worldPass).toBeDefined();
  const exposure = installed.exposure;
  expect(exposure).toBeDefined();
  expect(exposure?.settings.enabled).toBe(false);
  expect(exposure?.getObservation()).toEqual({ measured: false, applied: false });
  if (exposure === undefined) throw new Error("Actual consumer exposure missing.");
  const releaseExposure = vi.spyOn(exposure, "dispose");
  const releasePass = vi.spyOn(worldPass, "dispose");
  installed.dispose?.();
  expect(releaseExposure).toHaveBeenCalledTimes(1);
  expect(releasePass).toHaveBeenCalledTimes(1);
  expect(() => exposure?.reset()).toThrow(/disposed/);
});

it("rejects authored auto-exposure on an unsupported renderer rather than silently omitting it", () => {
  expect(() =>
    new WorldEnvironment({ autoExposureEnabled: true }).apply(
      { kind: "webgl", raw: {}, setOutputNode: vi.fn() },
      new Scene(),
      new PerspectiveCamera(),
    ),
  ).toThrow(/requires WebGPU/);
});

it("requires actual consumer installation evidence, rejecting missing wiring", async () => {
  const { assertExposureConsumer } = await import("./fixtures/auto-exposure/proof.js");
  const report = (text: string) => ({ observations: { console: [{ text }] } });
  expect(() =>
    assertExposureConsumer(report('TN_EXPOSURE_CONSUMER:{"installed":true,"owned":true}')),
  ).not.toThrow();
  expect(() => assertExposureConsumer(report("unrelated"))).toThrow(/one actual installation/);
  expect(() =>
    assertExposureConsumer(report('TN_EXPOSURE_CONSUMER:{"installed":true,"owned":false}')),
  ).toThrow(/actual graph/);
});

it("owns the direct base-colour graph without requiring an unrelated post stage", () => {
  const releases: ReturnType<typeof vi.fn>[] = [];
  const worldPasses: unknown[] = [];
  const outputs: unknown[] = [];
  const clearOutputNode = vi.fn();
  const renderer = {
    kind: "webgpu",
    raw: {},
    clearOutputNode,
    setOutputNode(node: unknown, worldPass?: unknown) {
      outputs.push(node);
      worldPasses.push(worldPass);
      (node as Node).traverse((candidate) => {
        if (Reflect.get(candidate, "isRTTNode") !== true) return;
        const scratch = candidate as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        };
        releases.push(vi.spyOn(scratch.renderTarget, "dispose"));
        releases.push(vi.spyOn(scratch._quadMesh.material, "dispose"));
      });
    },
  };
  let suppliedPass: unknown;
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
    {
      baseColour(scenePass) {
        suppliedPass = scenePass;
        releases.push(vi.spyOn(scenePass, "dispose"));
        return scenePass.getTextureNode("output").mul(0.5);
      },
    },
  );
  expect(applied.stages).toEqual([]);
  expect(applied.dispose).toBeTypeOf("function");
  expect(worldPasses).toEqual([suppliedPass]);
  expect(releases).toHaveLength(3);
  applied.dispose?.();
  applied.dispose?.();
  expect(clearOutputNode).toHaveBeenCalledExactlyOnceWith(outputs[0]);
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

it("refuses a direct graph on an unsupported renderer without invoking its allocation factory", () => {
  const baseColour = vi.fn();
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgl2", raw: {} },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour },
  );
  expect(baseColour).not.toHaveBeenCalled();
  expect(applied.dropped).toEqual([{ name: "baseColour", reason: "renderer:webgl2" }]);
});

it("disposes a base-colour PassNode without mistaking its borrowed texture for an owned RTT", () => {
  let releasePass: ReturnType<typeof vi.fn> | undefined;
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgpu", raw: {}, setOutputNode: () => {}, clearOutputNode: () => {} },
    new Scene(),
    new PerspectiveCamera(),
    {
      baseColour(scenePass) {
        releasePass = vi.spyOn(scenePass, "dispose");
        return scenePass;
      },
    },
  );
  expect(() => applied.dispose?.()).not.toThrow();
  applied.dispose?.();
  expect(releasePass).toHaveBeenCalledTimes(1);
});

it.each(["texture", "rtt"])("leaves caller-owned %s resources alive", (kind) => {
  const supplied = kind === "rtt" ? rtt(vec4(0.2, 0.3, 0.4, 1)) : texture(new Texture());
  const release = vi.spyOn(supplied.value, "dispose");
  const borrowedRtt =
    Reflect.get(supplied, "isRTTNode") === true
      ? (supplied as unknown as {
          renderTarget: { dispose(): void };
          _quadMesh: { material: { dispose(): void } };
        })
      : undefined;
  const targetRelease =
    borrowedRtt === undefined ? undefined : vi.spyOn(borrowedRtt.renderTarget, "dispose");
  const materialRelease =
    borrowedRtt === undefined ? undefined : vi.spyOn(borrowedRtt._quadMesh.material, "dispose");
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    { kind: "webgpu", raw: {}, setOutputNode: () => {}, clearOutputNode: () => {} },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour: () => supplied },
  );
  applied.dispose?.();
  applied.dispose?.();
  expect(release).not.toHaveBeenCalled();
  if (targetRelease !== undefined) expect(targetRelease).not.toHaveBeenCalled();
  if (materialRelease !== undefined) expect(materialRelease).not.toHaveBeenCalled();
  borrowedRtt?.renderTarget.dispose();
  borrowedRtt?._quadMesh.material.dispose();
  supplied.value.dispose();
});

it("releases the unique direct installation receipt rather than the legacy node identity", () => {
  const dispose = vi.fn();
  const clearOutputNode = vi.fn();
  const applied = new WorldEnvironment({ bloomEnabled: false, screenSpaceAA: "disabled" }).apply(
    {
      kind: "webgpu",
      raw: {},
      clearOutputNode,
      setOutputNode: () => ({ isCurrent: () => true, dispose }),
    },
    new Scene(),
    new PerspectiveCamera(),
    { baseColour: (scenePass) => scenePass },
  );
  applied.dispose?.();
  applied.dispose?.();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(clearOutputNode).not.toHaveBeenCalled();
});
