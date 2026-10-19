import { PerspectiveCamera, Scene } from "three";
import TRAANode from "three/addons/tsl/display/TRAANode.js";
import { mrt, normalView, output, pass, velocity } from "three/tsl";
import type { Node, NodeBuilder, TextureNode } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { RenderChain } from "../src/render/chain.js";

describe("the pinned TRAANode render-chain contract", () => {
  it.each([false, true])(
    "restores physical attachments after three temporal toggles (MRT: %s)",
    (hasMrt) => {
      const scenePass = pass(new Scene(), new PerspectiveCamera());
      const originalMrt = hasMrt ? mrt({ output, normal: normalView }) : null;
      scenePass.setMRT(originalMrt);
      if (hasMrt) scenePass.getTextureNode("normal");
      const target = scenePass.renderTarget;
      const originalTextures = [...target.textures];
      const originalDepth = target.depthTexture;
      const outputNode = scenePass.getTextureNode("output");
      const disposedAttachments: string[][] = [];
      target.addEventListener("dispose", () => {
        disposedAttachments.push(target.textures.map((texture) => texture.name));
      });
      try {
        for (let cycle = 0; cycle < 3; cycle += 1) {
          const chain = new RenderChain({
            renderer: { kind: "webgpu", raw: {}, setOutputNode() {} },
            input: outputNode,
            request: { stages: ["motionBlur"], velocity: { pass: scenePass } },
            stages: [{ name: "motionBlur", build: (input) => input }],
            report: () => {},
          });
          expect(chain.applied.stages).toEqual(["motionBlur"]);
          expect(target.textures.map((texture) => texture.name)).toEqual([
            ...originalTextures.map((texture) => texture.name),
            "velocity",
          ]);
          chain.dispose();
          chain.dispose();
          expect(scenePass.getMRT()).toBe(originalMrt);
          expect(target.textures).toEqual(originalTextures);
          expect(target.depthTexture).toBe(originalDepth);
          expect(scenePass.getTextureNode("output")).toBe(outputNode);
          // Target disposal must happen before detaching velocity so Three can release its GPU data.
          expect(disposedAttachments).toHaveLength(cycle + 1);
          expect(disposedAttachments[cycle]).toContain("velocity");
        }
      } finally {
        scenePass.dispose();
      }
    },
  );

  it("preserves a caller-owned velocity attachment and MRT", () => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    const originalMrt = mrt({ output, velocity });
    scenePass.setMRT(originalMrt);
    const velocityNode = scenePass.getTextureNode("velocity");
    const originalTextures = [...scenePass.renderTarget.textures];
    const dispose = vi.spyOn(scenePass.renderTarget, "dispose");
    const chain = new RenderChain({
      renderer: { kind: "webgpu", raw: {}, setOutputNode() {} },
      input: scenePass.getTextureNode("output"),
      request: { stages: ["motionBlur"], velocity: { pass: scenePass } },
      stages: [{ name: "motionBlur", build: (input) => input }],
      report: () => {},
    });
    chain.dispose();
    expect(scenePass.getMRT()).toBe(originalMrt);
    expect(scenePass.renderTarget.textures).toEqual(originalTextures);
    expect(scenePass.getTextureNode("velocity")).toBe(velocityNode);
    expect(dispose).not.toHaveBeenCalled();
    scenePass.dispose();
  });

  it.each(["build", "install"])("releases the added attachment after %s fails", (failure) => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    const originalTextures = [...scenePass.renderTarget.textures];
    const chain = new RenderChain({
      renderer: {
        kind: "webgpu",
        raw: {},
        setOutputNode() {
          if (failure === "install") throw new Error("install failure");
        },
      },
      input: scenePass.getTextureNode("output"),
      request: { stages: ["motionBlur"], velocity: { pass: scenePass } },
      stages: [
        {
          name: "motionBlur",
          build: (input) => {
            if (failure === "build") throw new Error("build failure");
            return input;
          },
        },
      ],
      report: () => {},
    });
    expect(chain.applied.stages).toEqual([]);
    expect(chain.applied.dropped[0]?.reason).toContain(failure);
    expect(scenePass.getMRT()).toBeNull();
    expect(scenePass.renderTarget.textures).toEqual(originalTextures);
    chain.dispose();
    scenePass.dispose();
  });

  it("rebuilds active tiers without accumulating attachments and releases them at tier off", () => {
    const scenePass = pass(new Scene(), new PerspectiveCamera());
    const originalTextures = [...scenePass.renderTarget.textures];
    const chain = new RenderChain({
      renderer: { kind: "webgpu", raw: {}, setOutputNode() {} },
      input: scenePass.getTextureNode("output"),
      request: { stages: ["motionBlur"], tier: "auto", velocity: { pass: scenePass } },
      stages: [{ name: "motionBlur", build: (input) => input }],
      dwellWindows: 1,
      report: () => {},
    });
    const velocityNode = scenePass.getTextureNode("velocity");
    for (const tier of ["medium", "low", "off"]) {
      expect(chain.observeFrameBudget({ phases: { render: { p95: 30 } } })).toBe(tier);
      expect(scenePass.renderTarget.textures.map((texture) => texture.name)).toEqual(
        tier === "off" ? ["output"] : ["output", "velocity"],
      );
      if (tier !== "off") expect(scenePass.getTextureNode("velocity")).toBe(velocityNode);
    }
    expect(scenePass.getMRT()).toBeNull();
    expect(scenePass.renderTarget.textures).toEqual(originalTextures);
    chain.dispose();
    scenePass.dispose();
  });

  it("keeps the sampled velocity texture separate from the jitter accessor", () => {
    const camera = new PerspectiveCamera(50, 1280 / 720);
    const scenePass = pass(new Scene(), camera);
    let graph: unknown;
    let temporal: TRAANode | undefined;
    let sampledVelocity: Node | undefined;
    const chain = new RenderChain({
      renderer: {
        kind: "webgpu",
        raw: {},
        setOutputNode: (node) => {
          graph = node;
        },
      },
      input: scenePass.getTextureNode(),
      request: { stages: ["traa"], velocity: { pass: scenePass } },
      report: () => {},
      stages: [
        {
          name: "traa",
          build: (input, context) => {
            sampledVelocity = context.velocityNode;
            temporal = new TRAANode(
              input as TextureNode,
              scenePass.getTextureNode("depth"),
              context.velocityNode as TextureNode,
              camera,
            );
            return temporal;
          },
        },
      ],
    });
    expect(chain.applied.stages).toEqual(["traa"]);
    expect(sampledVelocity).toBe(scenePass.getTextureNode("velocity"));
    const wrapped = graph as { value: { velocity: unknown } };
    temporal?.setup({
      context: { ...wrapped.value, renderPipeline: { context: {} } },
      renderer: {},
    } as unknown as NodeBuilder);
    const jitter = temporal as unknown as {
      setViewOffset(width: number, height: number): void;
      clearViewOffset(): void;
    };
    try {
      expect(() => jitter.setViewOffset(1280, 720)).not.toThrow();
      expect(wrapped.value.velocity).toBe(velocity);
      expect(camera.view?.enabled).toBe(true);
    } finally {
      // A failed assertion must not leave Three's singleton velocity accessor jittered.
      if (wrapped.value.velocity === velocity) jitter.clearViewOffset();
      temporal?.dispose();
      chain.dispose();
      scenePass.dispose();
    }
    expect(camera.view?.enabled).toBe(false);
  });
});
