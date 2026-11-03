import {
  BoxGeometry,
  DirectionalLight,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  Scene,
} from "three";
// @ts-expect-error Three's private renderer module has no public declaration; its cache key is the property under test.
import RenderObject from "three/src/renderers/common/RenderObject.js";
import { lights } from "three/tsl";
import {
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { installRoughDiffuse, useRoughDiffuse } from "../src/render/rough-diffuse.js";

/** The fragment stage three compiles for a mesh drawn with `material` under `light`, with no GPU. */
function fragment(material: Material, light: DirectionalLight | PointLight): string {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65_536,
  );
  // r187 NodeBuilder shares bind groups through renderer._bindings, which is null until the renderer initializes.
  Reflect.set(renderer, "_bindings", { getSharedBindGroup: (group: unknown) => group });
  const builder = new WGSLNodeBuilder(
    new Mesh(new BoxGeometry(), material),
    renderer,
  ) as unknown as {
    build(): void;
    camera: PerspectiveCamera;
    fragmentShader: string;
    lightsNode: Node;
    scene: Scene;
  };
  builder.camera = new PerspectiveCamera();
  builder.scene = new Scene();
  builder.lightsNode = lights([light]);
  builder.build();
  return builder.fragmentShader;
}

/** three's program key for a draw of `material`: what decides whether two materials share a pipeline. */
function programKey(material: Material): string {
  const draw = {
    object: new Mesh(),
    material,
    renderer: { backend: {} },
    // r187 reads the custom program key through the renderer's node manager.
    _nodes: { getCustomProgramCacheKey: (m: Material) => m.customProgramCacheKey() },
    clippingContextCacheKey: "",
    context: { id: 1 },
    getGeometryCacheKey: () => "",
  };
  return (
    RenderObject as { prototype: { getMaterialCacheKey(this: unknown): string } }
  ).prototype.getMaterialCacheKey.call(draw);
}

/** EON's fit constant: only a graph that carries the model prints it. */
const EON_CONSTANT = /0\.1894\d*/;

describe("roughDiffuse", () => {
  it("marks every standard and physical material under a root and counts only the changes", () => {
    const standard = new MeshStandardMaterial();
    const physical = new MeshPhysicalMaterial();
    const basic = new MeshBasicMaterial();
    const node = new MeshStandardNodeMaterial();
    const root = new Group();
    root.add(
      new Mesh(new BoxGeometry(), standard),
      new Mesh(new BoxGeometry(), [physical, basic]),
      new Mesh(new BoxGeometry(), node),
      new Group(),
    );
    const version = standard.version;
    expect(useRoughDiffuse(root)).toBe(3);
    expect([standard, physical, node].map((m) => m.roughDiffuse)).toEqual([true, true, true]);
    expect(basic.roughDiffuse).toBeUndefined();
    expect(standard.version).toBeGreaterThan(version);
    expect(useRoughDiffuse(root)).toBe(0);
    expect(useRoughDiffuse(root, false)).toBe(3);
    expect([standard, physical, node].map((m) => m.roughDiffuse)).toEqual([false, false, false]);
  });

  it("leaves an unmarked material on three's own lighting model and wraps a marked one's", () => {
    installRoughDiffuse();
    installRoughDiffuse();
    for (const make of [
      () => new MeshStandardNodeMaterial(),
      () => new MeshPhysicalNodeMaterial(),
    ]) {
      const plain = make();
      const marked = make();
      marked.roughDiffuse = true;
      expect(Object.hasOwn(plain.setupLightingModel(), "direct")).toBe(false);
      expect(Object.hasOwn(marked.setupLightingModel(), "direct")).toBe(true);
    }
  });

  it("compiles EON into the fragment of a marked material under a sun or a lamp, and nothing into an unmarked one", () => {
    installRoughDiffuse();
    const lamp = new PointLight(0xffffff, 3);
    lamp.sourceRadius = 0.1;
    // The classic classes are what a loaded model brings: the renderer converts each to its node twin, copying the flag.
    const classes = [
      MeshStandardNodeMaterial,
      MeshPhysicalNodeMaterial,
      MeshStandardMaterial,
      MeshPhysicalMaterial,
    ];
    for (const light of [new DirectionalLight(0xffffff, 3), lamp]) {
      for (const Material of classes) {
        const marked = new Material();
        marked.roughDiffuse = true;
        expect(fragment(new Material(), light)).not.toMatch(EON_CONSTANT);
        expect(fragment(marked, light)).toMatch(EON_CONSTANT);
      }
    }
  });

  it("keys a program on the flag, so a marked material never shares a pipeline with a plain one", () => {
    const plain = new MeshStandardNodeMaterial();
    const marked = new MeshStandardNodeMaterial();
    marked.roughDiffuse = true;
    const off = new MeshStandardNodeMaterial();
    off.roughDiffuse = false;
    expect(programKey(marked)).not.toBe(programKey(plain));
    expect(programKey(marked)).not.toBe(programKey(off));
  });
});
