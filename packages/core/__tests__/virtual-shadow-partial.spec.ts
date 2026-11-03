import { AlwaysDepth, type Mesh, OrthographicCamera, Scene, Vector3, Vector4 } from "three";
import type { MeshBasicNodeMaterial, NodeFrame } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { isPartialRedraw } from "../../../examples/abyss-framework/src/probes/shadowPartial.js";
import {
  type IPartialPass,
  type IPartialShadowNode,
  installPartialRender,
  pixelRect,
} from "../src/render/virtual-shadow-partial.js";

const SIZE = 64;
const EXTENT = 250;

/** A level camera straight above the origin: screen x is world x, screen up is world -z. */
function levelCamera(): OrthographicCamera {
  const camera = new OrthographicCamera(-EXTENT, EXTENT, EXTENT, -EXTENT, 1, 200);
  camera.up.set(0, 0, -1);
  camera.position.set(0, 100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** The texel size of the 64 x 64 map over 500 m. */
const TEXEL = (2 * EXTENT) / SIZE;

describe("partial redraw proof", () => {
  it("should compare pages with pages and reject any whole redraw", () => {
    expect(isPartialRedraw(4, 2, 8)).toBe(true);
    expect(isPartialRedraw(64, 1, 8)).toBe(false);
    expect(isPartialRedraw(65, 2, 8)).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
    "should reject missing or invalid observations (%s)",
    (value) => {
      const invalid = value as number;
      expect(isPartialRedraw(invalid, 1, 8)).toBe(false);
      expect(isPartialRedraw(4, invalid, 8)).toBe(false);
      expect(isPartialRedraw(4, 1, invalid)).toBe(false);
    },
  );
});

describe("pixelRect", () => {
  it("should return the texels a rectangle of pages lands on", () => {
    const camera = levelCamera();
    // Pages 32..35 on x and 0..1 on z: the centre of the map is texel 32.
    const corners = [
      new Vector3(0, 0, 0),
      new Vector3(4 * TEXEL, 0, 0),
      new Vector3(0, 0, 2 * TEXEL),
      new Vector3(4 * TEXEL, 0, 2 * TEXEL),
    ];
    expect(pixelRect(camera, SIZE, corners)).toEqual({ height: 2, width: 4, x: 32, y: 32 });
  });

  it("should not add a texel to a corner a hair past an edge", () => {
    const camera = levelCamera();
    const corners = [new Vector3(1e-9, 0, 1e-9), new Vector3(4 * TEXEL - 1e-9, 0, 2 * TEXEL)];
    expect(pixelRect(camera, SIZE, corners)).toMatchObject({ height: 2, width: 4 });
  });
});

describe("a view-offset camera drawing into its own viewport", () => {
  it("should land every point on the texel and depth the whole-map camera gives it", () => {
    const full = levelCamera();
    const sub = levelCamera();
    const rect = { height: 6, width: 9, x: 20, y: 11 };
    sub.setViewOffset(SIZE, SIZE, rect.x, rect.y, rect.width, rect.height);
    // 200 points across the rectangle, at different heights.
    for (let at = 0; at < 200; at += 1) {
      const point = new Vector3(
        ((rect.x + ((at * 7) % 90) / 10 - SIZE / 2) * 2 * EXTENT) / SIZE,
        (at % 17) * 3,
        ((rect.y + ((at * 3) % 60) / 10 - SIZE / 2) * 2 * EXTENT) / SIZE,
      );
      const a = point
        .clone()
        .applyMatrix4(full.matrixWorldInverse)
        .applyMatrix4(full.projectionMatrix);
      const b = point
        .clone()
        .applyMatrix4(sub.matrixWorldInverse)
        .applyMatrix4(sub.projectionMatrix);
      // The texel in the whole map, and the texel in the viewport offset to the rectangle.
      expect(rect.x + ((b.x + 1) / 2) * rect.width).toBeCloseTo(((a.x + 1) / 2) * SIZE, 9);
      expect(rect.y + ((1 - b.y) / 2) * rect.height).toBeCloseTo(((1 - a.y) / 2) * SIZE, 9);
      expect(b.z).toBe(a.z);
    }
  });

  it("should keep the whole projection once the offset is cleared", () => {
    const camera = levelCamera();
    const before = camera.projectionMatrix.clone();
    camera.setViewOffset(SIZE, SIZE, 3, 4, 5, 6);
    expect(camera.projectionMatrix.equals(before)).toBe(false);
    camera.clearViewOffset();
    expect(camera.projectionMatrix.equals(before)).toBe(true);
  });
});

describe("installPartialRender", () => {
  interface IDraw {
    autoClear: boolean;
    material?: MeshBasicNodeMaterial;
    objectFunction: unknown;
    scene: unknown;
    scissor: number[];
    scissorTest: boolean;
    viewport: number[];
  }

  function harness(pass: IPartialPass | undefined) {
    const draws: IDraw[] = [];
    const camera = levelCamera();
    const viewport = new Vector4(0, 0, SIZE, SIZE);
    const scissor = new Vector4(1, 2, 30, 40);
    let scissorTest = false;
    const shadowMap = {
      scissor,
      depth: 1,
      setSize: vi.fn(() => viewport.set(0, 0, SIZE, SIZE)),
      viewport,
    };
    const shadowFunction = () => undefined;
    let objectFunction: unknown = shadowFunction;
    const renderer = {
      autoClear: true,
      getRenderObjectFunction: () => objectFunction,
      getScissorTest: () => scissorTest,
      setScissorTest: (next: boolean) => {
        scissorTest = next;
      },
      render: vi.fn((scene: Scene, camera: OrthographicCamera) => {
        // Three's NodeManager reuses this frame for every nested render object.
        frame.scene = scene;
        frame.camera = camera;
        frame.object = scene.children[0] ?? null;
        frame.material = ((scene.children[0] as Mesh | undefined)?.material ??
          null) as NodeFrame["material"];
        draws.push({
          autoClear: renderer.autoClear,
          material: ((scene as Scene).children[0] as Mesh | undefined)?.material as
            | MeshBasicNodeMaterial
            | undefined,
          objectFunction,
          scene,
          scissor: scissor.toArray(),
          scissorTest,
          viewport: viewport.toArray(),
        });
      }),
      setRenderObjectFunction: vi.fn((next: unknown) => {
        objectFunction = next;
      }),
    };
    const stock = vi.fn();
    const node = {
      renderShadow: stock,
      shadow: { camera, mapSize: { height: SIZE, width: SIZE } },
      shadowMap,
    } as unknown as IPartialShadowNode;
    const current = vi.fn(() => pass);
    installPartialRender(node, current);
    const scene = new Scene();
    const frame = {
      renderer,
      scene,
      camera: levelCamera(),
      object: new Scene(),
      material: null,
    } as unknown as NodeFrame;
    return {
      current,
      draws,
      frame,
      node,
      renderer,
      scene,
      scissor,
      shadowFunction,
      stock,
      viewport,
    };
  }

  const RECT = { maxX: 35, maxY: 33, minX: 32, minY: 32 };

  it.each([false, true])(
    "should match scissor to both draws and restore state (prior flag: %s)",
    (prior) => {
      const { draws, frame, node, renderer, scissor } = harness({
        pixels: { height: 2, width: 4, x: 32, y: 32 },
        rect: RECT,
        reset: true,
      });
      renderer.setScissorTest(prior);
      node.renderShadow(frame);
      expect(draws).toHaveLength(2);
      for (const draw of draws) {
        expect(draw.scissor).toEqual([32, 32, 4, 2]);
        expect(draw.scissor).toEqual(draw.viewport);
        expect(draw.scissorTest).toBe(true);
      }
      expect(scissor.toArray()).toEqual([1, 2, 30, 40]);
      expect(renderer.getScissorTest()).toBe(prior);
    },
  );

  it("should preserve the caller's frame across a reset followed by an admission draw", () => {
    const pass = { pixels: { height: 2, width: 4, x: 32, y: 32 }, rect: RECT, reset: true };
    const { current, draws, frame, node, scene } = harness(pass);
    const held = {
      scene: frame.scene,
      camera: frame.camera,
      object: frame.object,
      material: frame.material,
    };
    node.renderShadow(frame);
    expect(frame).toMatchObject(held);
    current.mockReturnValue({ ...pass, reset: false });
    node.renderShadow(frame);
    expect(draws).toHaveLength(3);
    expect(draws[2]?.scene).toBe(scene);
    expect(frame).toMatchObject(held);
  });

  it("should leave the stock render alone with no pass", () => {
    const { frame, node, renderer, stock } = harness(undefined);
    node.renderShadow(frame);
    expect(stock).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("should render whole when a pass was never aimed", () => {
    const { frame, node, renderer, stock } = harness({
      pixels: undefined,
      rect: RECT,
      reset: false,
    });
    node.renderShadow(frame);
    expect(stock).toHaveBeenCalledOnce();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it.each([false, true])("should draw without clearing and restore autoClear: %s", (autoClear) => {
    const pixels = { height: 2, width: 4, x: 32, y: 32 };
    const { draws, frame, node, renderer, scene, stock, viewport } = harness({
      pixels,
      rect: RECT,
      reset: false,
    });
    renderer.autoClear = autoClear;
    node.renderShadow(frame);
    expect(stock).not.toHaveBeenCalled();
    expect(draws).toEqual([
      expect.objectContaining({ autoClear: false, scene, viewport: [32, 32, 4, 2] }),
    ]);
    // The map's viewport is whole again for whoever reads it next.
    expect(viewport.toArray()).toEqual([0, 0, SIZE, SIZE]);
    expect(renderer.autoClear).toBe(autoClear);
  });

  it("should put the rectangle's depth back to the far plane before an eviction redraw", () => {
    const pixels = { height: 2, width: 4, x: 32, y: 32 };
    const { draws, frame, node, renderer, scene, shadowFunction } = harness({
      pixels,
      rect: RECT,
      reset: true,
    });
    node.renderShadow(frame);
    expect(draws).toHaveLength(2);
    const [reset, redraw] = draws as [IDraw, IDraw];
    // The far quad is its own scene, in the same viewport, drawn without the shadow pass's
    // render-object function, which would swap its material for the depth material.
    expect(reset.scene).not.toBe(scene);
    expect(reset.viewport).toEqual([32, 32, 4, 2]);
    expect(reset.objectFunction).toBeNull();
    expect(redraw.scene).toBe(scene);
    expect(redraw.objectFunction).toBe(shadowFunction);
    expect(renderer.autoClear).toBe(true);
  });

  it.each([false, true])(
    "should clear eviction color to transparent black with far depth (reversed: %s)",
    (reversed) => {
      const { draws, frame, node } = harness({
        pixels: { height: 2, width: 4, x: 32, y: 32 },
        rect: RECT,
        reset: true,
      });
      Object.defineProperty(node.shadow.camera, "reversedDepth", { value: reversed });
      node.renderShadow(frame);
      const material = draws[0]?.material;
      expect(material?.colorWrite).toBe(true);
      expect(material?.transparent).toBe(false);
      expect(material?.depthWrite).toBe(true);
      expect(material?.depthFunc).toBe(AlwaysDepth);
      // vec4(0) is the exact RGBA the stock shadow pass clears, independent of material color.
      // r187 builds a vec4 constant directly, where r185 wrapped it in a convert node.
      expect(material?.fragmentNode).toMatchObject({
        nodeType: "vec4",
        value: new Vector4(0, 0, 0, 0),
      });
      expect(material?.vertexNode).toMatchObject({
        nodes: [
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ value: reversed ? 0 : 1 }),
          expect.objectContaining({ value: 1 }),
        ],
      });
    },
  );

  it.each([false, true])("should restore state when a render throws (reset: %s)", (reset) => {
    const { frame, node, renderer, scene, scissor, shadowFunction, viewport } = harness({
      pixels: { height: 2, width: 4, x: 32, y: 32 },
      rect: RECT,
      reset,
    });
    scene.name = "original";
    renderer.setScissorTest(reset);
    const held = {
      scene: frame.scene,
      camera: frame.camera,
      object: frame.object,
      material: frame.material,
    };
    renderer.render.mockImplementationOnce((nestedScene, nestedCamera) => {
      frame.scene = nestedScene;
      frame.camera = nestedCamera;
      frame.object = nestedScene.children[0] ?? null;
      frame.material = ((nestedScene.children[0] as Mesh | undefined)?.material ??
        null) as NodeFrame["material"];
      expect(scissor.toArray()).toEqual([32, 32, 4, 2]);
      expect(renderer.getScissorTest()).toBe(true);
      throw new Error("render failed");
    });
    expect(() => node.renderShadow(frame)).toThrow("render failed");
    expect(renderer.autoClear).toBe(true);
    expect(scene.name).toBe("original");
    expect(scissor.toArray()).toEqual([1, 2, 30, 40]);
    expect(renderer.getScissorTest()).toBe(reset);
    expect(viewport.toArray()).toEqual([0, 0, SIZE, SIZE]);
    expect(renderer.getRenderObjectFunction()).toBe(shadowFunction);
    expect(frame).toMatchObject(held);
  });
});
