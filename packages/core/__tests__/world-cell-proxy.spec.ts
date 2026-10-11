import {
  BoxGeometry,
  DataTexture,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
} from "three";
import { describe, expect, it } from "vitest";
import { markEngineRenderHook } from "../src/engine-render-hook.js";
import {
  CellProxySelection,
  cellProxyMaterialMatches,
  cellProxyMaterialSafe,
  cellProxySourceSafe,
  cellProxyWorldScale,
} from "../src/world-cell-proxy.js";

const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
const proxy = { glb: "proxy.glb", error: 1, triangles: 20, materialGroups: 2 };
function input(depth = 400) {
  return {
    sourceReady: true,
    proxyReady: true,
    sourceCompatible: true,
    sourceTriangles: 100,
    replaceableSourceDraws: 2,
    views: [{ camera, depth, viewportHeight: 1080, degenerate: false }] as const,
  };
}

describe("cell proxy selection within the existing admission owner", () => {
  it("retains detail until the proxy is ready, and the last proxy until returning detail is ready", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select({ ...input(), proxyReady: false })).toBe("detail");
    expect(state.select(input())).toBe("proxy");
    expect(state.select({ ...input(5), sourceReady: false })).toBe("proxy");
    expect(state.select(input(5))).toBe("detail");
    expect(state.select({ ...input(), sourceReady: false, proxyReady: false })).toBe("pending");
  });
  it("uses the existing projected-error hysteresis and respects full-quality views", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select(input(260))).toBe("detail");
    expect(state.select(input(300))).toBe("proxy");
    expect(state.select(input(260))).toBe("proxy");
    expect(state.select(input(220))).toBe("detail");
    expect(
      state.select({
        ...input(),
        views: [
          {
            ...input().views[0],
            camera,
            depth: 400,
            viewportHeight: 1080,
            degenerate: false,
            finest: true,
          },
        ],
      }),
    ).toBe("detail");
    state.reset();
    expect(state.select(input(260))).toBe("detail");
  });
  it("rejects a proxy heavier than the active far LOD or adding draws to retained shared batches", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select({ ...input(), sourceTriangles: 10 })).toBe("detail");
    expect(state.select({ ...input(), replaceableSourceDraws: 0 })).toBe("detail");
    expect(state.select({ ...input(), sourceCompatible: false })).toBe("detail");
    expect(state.select({ ...input(), sourceCompatible: false, sourceReady: false })).toBe(
      "pending",
    );
  });
  it("does not activate a fresh proxy while full-quality detail is pending", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select({ ...input(), sourceReady: false, views: [] })).toBe("pending");
    expect(state.select({ ...input(5), sourceReady: false })).toBe("pending");
    expect(state.select({ ...input(), sourceReady: false, replaceableSourceDraws: 0 })).toBe(
      "pending",
    );
    expect(
      state.select({
        ...input(),
        sourceReady: false,
        views: [{ ...input().views[0], finest: true }],
      }),
    ).toBe("pending");
    expect(state.select({ ...input(), sourceReady: false })).toBe("proxy");
  });
  it("scales cooked errors with the current world transform", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select(input())).toBe("proxy");
    expect(state.select({ ...input(), errorScale: 10 })).toBe("detail");
    expect(() => state.select({ ...input(), errorScale: 0 })).toThrow("scale");
  });
  it("fails closed on missing views and invalid costs", () => {
    const state = new CellProxySelection(proxy);
    expect(state.select({ ...input(), views: [] })).toBe("detail");
    expect(() => state.select({ ...input(), sourceTriangles: Number.NaN })).toThrow();
    expect(() => new CellProxySelection({ ...proxy, error: -1 })).toThrow();
  });
});

describe("fixed cell proxy material and transform qualification", () => {
  it("accepts default standard material while preserving exact HDR color and later source changes", () => {
    const a = new MeshStandardMaterial();
    const b = a.clone();
    expect(cellProxyMaterialSafe(a)).toBe(true);
    expect(cellProxyMaterialMatches(a, b)).toBe(true);
    a.color.setRGB(2, 1, 1);
    b.color.setRGB(1, 1, 1);
    expect(cellProxyMaterialMatches(a, b)).toBe(false);
    b.color.copy(a.color);
    expect(cellProxyMaterialMatches(a, b)).toBe(true);
    a.envMapRotation.y = 0.5;
    expect(cellProxyMaterialMatches(a, b)).toBe(false);
    b.envMapRotation.copy(a.envMapRotation);
    a.roughness = 0.25;
    expect(cellProxyMaterialMatches(a, b)).toBe(false);
    a.dispose();
    b.dispose();
  });
  it("compares mapped material identity without serializing textures or allocating image arrays", () => {
    const map = new DataTexture(new Uint8Array(16), 2, 2);
    const a = new MeshStandardMaterial({ map });
    const b = a.clone();
    map.toJSON = () => {
      throw new Error("texture serialization forbidden");
    };
    map.source.toJSON = () => {
      throw new Error("image serialization forbidden");
    };
    expect(cellProxyMaterialMatches(a, b)).toBe(true);
    b.map = map.clone();
    b.map.premultiplyAlpha = !map.premultiplyAlpha;
    expect(cellProxyMaterialMatches(a, b)).toBe(false);
    b.map.dispose();
    b.map = new DataTexture(new Uint8Array(16), 2, 2);
    expect(cellProxyMaterialMatches(a, b)).toBe(false);
    b.map.dispose();
    map.dispose();
    a.dispose();
    b.dispose();
  });
  it("bounds composed nonuniform scale and rotation without understating shear", () => {
    const matrix = new Matrix4()
      .makeScale(2, 1, 1)
      .multiply(new Matrix4().makeRotationY(Math.PI / 4));
    expect(matrix.getMaxScaleOnAxis()).toBeLessThan(2);
    expect(cellProxyWorldScale(matrix)).toBeGreaterThanOrEqual(2);
    expect(cellProxyWorldScale(new Matrix4())).toBe(1);
  });
});

describe("cell proxy static source hooks", () => {
  it("retains recognized engine observation hooks and refuses game draw hooks", () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    try {
      expect(cellProxySourceSafe(mesh)).toBe(true);
      mesh.onBeforeRender = () => undefined;
      mesh.onAfterRender = () => undefined;
      markEngineRenderHook(mesh.onBeforeRender);
      markEngineRenderHook(mesh.onAfterRender);
      expect(cellProxySourceSafe(mesh)).toBe(true);
      mesh.onBeforeRender = () => undefined;
      expect(cellProxySourceSafe(mesh)).toBe(false);
    } finally {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
});
