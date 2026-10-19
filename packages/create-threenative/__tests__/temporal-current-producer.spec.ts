import {
  Color,
  Layers,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from "three";
// @ts-expect-error Use the actual pinned render-list ordering without a GPU device.
import RenderList from "three/src/renderers/common/RenderList.js";
import { context, mrt, output, pass, uniform, vec2, velocity } from "three/tsl";
import type { NodeFrame } from "three/webgpu";
import { RenderTarget, WGSLNodeBuilder, WebGPURenderer } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { VelocityTracker } from "../../core/src/render/velocity.js";
import { createTemporalCurrentProducer } from "../templates/starter/src/render/temporalCurrentProducer.js";

describe("raw4 producer on the existing pass paths", () => {
  it("replays mixed alpha and coplanar ties in identical order, releases scale1 resources and restores ownership", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const r = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    const meshes = [0, 0.5].map(
      (alphaTest) => new Mesh(new PlaneGeometry(), new MeshStandardMaterial({ alphaTest })),
    );
    scene.add(...meshes);
    const tracker = new VelocityTracker();
    tracker.update(scene);
    const beauty = pass(scene, camera);
    beauty.setResolutionScale(2 / 3);
    beauty.setMRT(mrt({ output, velocity }));
    const originalDraw = beauty.updateBefore;
    const originalContext = beauty.contextNode;
    const draws: { samples: number; ids: number[]; alpha: number[]; motion: unknown[] }[] = [];
    vi.spyOn(r, "getDrawingBufferSize").mockImplementation((into) => into.set(640, 360));
    vi.spyOn(r, "initRenderTarget").mockImplementation(() => {});
    Reflect.set(r.backend, "renderer", r);
    vi.spyOn(Reflect.get(r.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
      65536,
    );
    vi.spyOn(r, "hasFeature").mockReturnValue(false);
    let packetShader = "";
    const rendered: number[] = [];
    const alpha: number[] = [];
    const motions: unknown[] = [];
    vi.spyOn(r, "renderObject").mockImplementation(
      (object, _scene, _camera, _geometry, material) => {
        rendered.push(object.id);
        alpha.push(material.alphaTest);
        const outputNode = Reflect.get(material, "outputNode");
        motions.push((outputNode?.node ?? outputNode)?.nodes?.[0]);
      },
    );
    vi.spyOn(r, "render").mockImplementation((drawScene, drawCamera) => {
      if (drawScene instanceof Scene)
        drawScene.onBeforeRender(
          r as never,
          drawScene,
          drawCamera,
          {} as never,
          {} as never,
          {} as never,
        );
      if (drawScene instanceof Scene && drawScene !== scene) {
        draws.push({ samples: r.getRenderTarget()?.samples ?? 0, ids: [], alpha: [], motion: [] });
        return;
      }
      if (drawScene !== scene) {
        const builder = new WGSLNodeBuilder(drawScene as Mesh, r) as WGSLNodeBuilder & {
          build(): void;
          fragmentShader: string;
        };
        Reflect.set(builder, "camera", drawCamera);
        Reflect.set(builder, "scene", scene);
        builder.build();
        packetShader = builder.fragmentShader;
        return;
      }
      const list = new RenderList({ getNode: () => ({}) }, drawScene, drawCamera);
      list.begin();
      for (const mesh of meshes)
        if (r.opaque && drawCamera.layers.test(mesh.layers))
          list.push(mesh, mesh.geometry, mesh.material, 0, 0, null, null);
      list.sort();
      rendered.length = 0;
      alpha.length = 0;
      motions.length = 0;
      for (const item of list.opaque) {
        const draw = r.getRenderObjectFunction() ?? r.renderObject.bind(r);
        draw(
          item.object,
          scene,
          camera,
          item.geometry,
          item.material,
          null,
          {} as never,
          null as never,
        );
      }
      draws.push({
        samples: r.getRenderTarget()?.samples ?? 0,
        ids: [...rendered],
        alpha: [...alpha],
        motion: [...motions],
      });
    });
    const producer = createTemporalCurrentProducer(beauty);
    const frame = { renderer: r } as unknown as NodeFrame;
    const modes: boolean[] = [];
    producer.onModeChange((_r, active) => modes.push(active));
    try {
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      expect(draws.map((d) => d.samples)).toEqual([4, 4, 0]);
      beauty.setup({ renderer: r } as never);
      expect(beauty.renderTarget.samples).toBe(4);
      expect(draws[1]?.ids).toEqual(draws[0]?.ids);
      expect(draws[2]?.ids).toEqual(draws[0]?.ids);
      expect(draws.map((d) => d.alpha)).toEqual([
        [0, 0.5],
        [0, 0.5],
        [0, 0.5],
      ]);
      // Equal-depth LessEqual ties choose the final entry in every list, not an unowned neighbour.
      expect(draws.map((d) => d.ids.at(-1))).toEqual(Array(3).fill(meshes[1]?.id));
      expect(producer.storageBytes()).toBe(426 * 240 * 184);
      expect(producer.depth.value.renderTarget).toMatchObject({ width: 426, height: 240 });
      expect(r.getRenderObjectFunction()).toBeNull();
      producer.publishDepth(r);
      expect(packetShader.match(/textureLoad\(/g)).toHaveLength(4);
      // All four packet channels are depths: an opaque material must not overwrite channel3.
      expect(packetShader).not.toContain("DiffuseColor.w = 1.0");
      // The original matched zero control replaces this MRT after provider construction.
      const zero = vec2(0);
      beauty.setMRT(defined(beauty.getMRT()).merge(mrt({ velocity: zero })));
      draws.length = 0;
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      expect(draws.map((d) => d.samples)).toEqual([4, 4, 0]);
      expect(draws[1]?.motion).toEqual(Array(2).fill(zero));
      expect(draws[2]?.motion).toEqual(Array(2).fill(zero));
      beauty.opaque = false;
      draws.length = 0;
      beauty.updateBefore(frame);
      expect(draws.map((d) => d.ids)).toEqual([[], [], []]);
      beauty.opaque = true;
      camera.layers.enable(1);
      defined(meshes[1]).layers.set(1);
      beauty.setLayers(new Layers());
      draws.length = 0;
      beauty.updateBefore(frame);
      expect(draws.map((d) => d.ids)).toEqual(Array(3).fill([defined(meshes[0]).id]));
      beauty.setLayers(null as unknown as Layers);
      draws.length = 0;
      beauty.updateBefore(frame);
      expect(draws.map((d) => d.ids)).toEqual(Array(3).fill(meshes.map((mesh) => mesh.id)));
      beauty.setMRT(defined(beauty.getMRT()).merge(mrt({ velocity: uniform(0).mul(vec2(1)) })));
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(false);
      beauty.setMRT(defined(beauty.getMRT()).merge(mrt({ velocity })));
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      // Private replay cannot inherit an unknown pass-local alpha/position context.
      const custom = context({ temporalUnknownVertexPolicy: true });
      beauty.contextNode = custom;
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(false);
      expect(beauty.contextNode).toBe(custom);
      beauty.contextNode = originalContext;
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      beauty.setResolutionScale(1);
      draws.length = 0;
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(false);
      expect(producer.storageBytes()).toBe(0);
      expect(draws.map((d) => d.samples)).toEqual([0]);
      expect(producer.depth.value).toBe(beauty.getTextureNode("depth").value);
      expect(modes).toEqual([true, false, true, false, true, false]);
      beauty.setResolutionScale(0.75);
      beauty.updateBefore(frame);
      expect(beauty.renderTarget.width).toBe(480);
      expect(producer.storageBytes()).toBe(480 * 270 * 184);
      const originalMRT = defined(beauty.getMRT());
      const rendererContext = r.contextNode;
      for (const [change, restore] of [
        [
          () => {
            beauty.scene = new Scene();
          },
          () => {
            beauty.scene = scene;
          },
        ],
        [
          () => {
            beauty.camera = new PerspectiveCamera();
          },
          () => {
            beauty.camera = camera;
          },
        ],
        [
          () => {
            beauty.overrideMaterial = new MeshStandardMaterial();
          },
          () => {
            beauty.overrideMaterial = null;
          },
        ],
        [
          () => {
            beauty.setMRT(originalMRT.merge(mrt({ depth: uniform(0.5) })));
          },
          () => {
            beauty.setMRT(originalMRT);
          },
        ],
        [
          () => {
            r.contextNode = context({ getOutput: (node: unknown) => node });
          },
          () => {
            r.contextNode = rendererContext;
          },
        ],
      ]) {
        defined(change)();
        draws.length = 0;
        beauty.updateBefore(frame);
        expect(producer.active()).toBe(false);
        expect(draws).toHaveLength(1);
        defined(restore)();
        beauty.updateBefore(frame);
        expect(producer.active()).toBe(true);
      }
      const nextBackground = new Color(0x123456);
      scene.onBeforeRender = () => {
        scene.background = nextBackground;
      };
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(false);
      expect(scene.background).toBe(nextBackground);
      scene.onBeforeRender = Object3D.prototype.onBeforeRender;
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      const failed = vi.fn();
      producer.onFailure(failed);
      const renderMock = vi.mocked(r.render);
      const ordinaryRender = defined(renderMock.getMockImplementation());
      renderMock.mockImplementationOnce(ordinaryRender).mockImplementationOnce(() => {
        throw new Error("private replay failed");
      });
      expect(() => beauty.updateBefore(frame)).toThrow("private replay failed");
      expect(failed).toHaveBeenCalledOnce();
      expect(r.getRenderObjectFunction()).toBeNull();
      expect(scene.background).toBe(nextBackground);
      beauty.updateBefore(frame);
      expect(producer.active()).toBe(true);
      producer.dispose();
      producer.dispose();
      expect(beauty.updateBefore).toBe(originalDraw);
      expect(beauty.contextNode).toBe(originalContext);
      expect(beauty.renderTarget.samples).toBe(0);
      // Replacing public ownership slots must never destroy a later owner's target or policy.
      const another = createTemporalCurrentProducer(beauty);
      beauty.updateBefore(frame);
      const target = beauty.renderTarget;
      const options = Reflect.get(beauty, "options");
      const foreign = new RenderTarget(7, 9, { samples: 4 });
      const foreignOptions = { samples: 4 };
      const foreignContext = context({ other: true });
      const laterDraw = () => undefined;
      const releaseForeign = vi.spyOn(foreign, "dispose");
      Reflect.set(beauty, "renderTarget", foreign);
      Reflect.set(beauty, "options", foreignOptions);
      beauty.contextNode = foreignContext;
      beauty.updateBefore = laterDraw;
      another.dispose();
      expect(releaseForeign).not.toHaveBeenCalled();
      expect(foreign.samples).toBe(4);
      expect(foreignOptions.samples).toBe(4);
      expect(beauty.contextNode).toBe(foreignContext);
      expect(beauty.updateBefore).toBe(laterDraw);
      Reflect.set(beauty, "renderTarget", target);
      Reflect.set(beauty, "options", options);
      beauty.contextNode = originalContext;
      beauty.updateBefore = originalDraw;
      foreign.dispose();
    } finally {
      producer.dispose();
      tracker.clear();
      beauty.dispose();
      vi.restoreAllMocks();
    }
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
