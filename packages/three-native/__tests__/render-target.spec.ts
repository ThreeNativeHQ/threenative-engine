import { describe, expect, it } from "vitest";
import { defineRenderTargets, pixelsOfType, targetTexelBytes } from "../src/render-target.js";

describe("pixelsOfType", () => {
  it("returns a FloatType target's float32 rows as stored, not rounded to half", () => {
    const value = 1 + 2 ** -12;
    const rows = new Uint8Array(new Float32Array([value, 0, 0, 1]).buffer);
    const typed = pixelsOfType(rows, 1015);
    expect(typed).toBeInstanceOf(Float32Array);
    expect(Array.from(typed)).toEqual([value, 0, 0, 1]);
  });

  it("types half rows as half bits or clamped bytes", () => {
    const rows = new Uint8Array(new Uint16Array([0x3800, 0x3c00, 0x0000, 0x3c00]).buffer);
    expect(Array.from(pixelsOfType(rows, 1016))).toEqual([0x3800, 0x3c00, 0, 0x3c00]);
    expect(Array.from(pixelsOfType(rows, 1009))).toEqual([128, 255, 0, 255]);
  });

  it("sizes a pixel by the target format", () => {
    expect(targetTexelBytes(1015)).toBe(16);
    expect(targetTexelBytes(1016)).toBe(8);
    expect(targetTexelBytes(1009)).toBe(8);
  });
});

describe("defineRenderTargets: a layered MRT target", () => {
  const make = () => {
    const draws: { layer: number; attachment: number; output: unknown }[] = [];
    const material = {
      mrtNode: { isMRTNode: true, outputs: { output: "albedo-node", normal: "normal-node" } },
      outputNode: null as unknown,
    };
    const mesh = { material };
    const scene = { traverse: (visit: (object: unknown) => void) => [scene, mesh].forEach(visit) };
    class Renderer {
      render(): void {}
    }
    defineRenderTargets(Renderer.prototype, () => ({
      draw: (_target, _root, _camera, layer = 0, attachment = 0) =>
        draws.push({ layer, attachment, output: material.outputNode }),
      read: async () => new Uint8Array(0),
    }));
    const target = { texture: { type: 1009 }, depth: 16, textures: [{ name: "output" }, { name: "normal" }] };
    return { renderer: new Renderer() as never as IRendererSurface, target, scene, draws, material };
  };

  it("draws each attachment into the layer with the material's mrt slot of that texture's name", () => {
    const { renderer, target, scene, draws, material } = make();
    renderer.setRenderTarget(target, 5, 0);
    expect(renderer.getActiveCubeFace()).toBe(5);
    renderer.render(scene, {});
    expect(draws).toEqual([
      { layer: 5, attachment: 0, output: "albedo-node" },
      { layer: 5, attachment: 1, output: "normal-node" },
    ]);
    expect(material.outputNode).toBeNull();
  });

  it("keeps three's renderer MRT and initRenderTarget seams the impostor bake reads", () => {
    const { renderer, target } = make();
    expect(renderer.getMRT()).toBeNull();
    const mrt = { isMRTNode: true };
    renderer.setMRT(mrt);
    expect(renderer.getMRT()).toBe(mrt);
    renderer.setMRT(null);
    expect(() => renderer.initRenderTarget(target)).not.toThrow();
  });

  it("refuses a layer past the target's depth and a material with no slot for an attachment", () => {
    const { renderer, target, scene, material } = make();
    expect(() => renderer.setRenderTarget(target, 16, 0)).toThrow(/TN_NATIVE_RENDER_TARGET_UNSUPPORTED/);
    expect(() => renderer.setRenderTarget({ texture: { type: 1009 } }, 1, 0)).toThrow(
      /TN_NATIVE_RENDER_TARGET_UNSUPPORTED/,
    );
    material.mrtNode = { isMRTNode: true, outputs: { output: "albedo-node" } } as never;
    renderer.setRenderTarget(target, 0, 0);
    expect(() => renderer.render(scene, {})).toThrow(/TN_NATIVE_MRT_UNSUPPORTED: .*'normal'/);
    expect(material.outputNode).toBeNull();
  });
});

interface IRendererSurface {
  setRenderTarget(target: unknown, face?: number, mip?: number): void;
  getActiveCubeFace(): number;
  render(scene: unknown, camera: unknown): void;
  getMRT(): unknown;
  setMRT(mrt: unknown): void;
  initRenderTarget(target: unknown): void;
}
