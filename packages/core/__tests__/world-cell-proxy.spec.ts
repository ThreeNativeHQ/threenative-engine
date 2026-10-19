import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CompressedTexture,
  DataTexture,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  type RGBAFormat,
  RGBA_BPTC_Format,
  TextureUtils,
  UnsignedByteType,
} from "three";
import { describe, expect, it } from "vitest";
import { markEngineRenderHook } from "../src/engine-render-hook.js";
import {
  CellProxySelection,
  cellProxyMaterialMatches,
  cellProxyMaterialSafe,
  cellProxySourceSafe,
  cellProxyWorldScale,
  measureCellProxy,
  prepareCellProxy,
} from "../src/world-cell-proxy.js";
import type { IWorldCellProxy } from "../src/world-package.js";

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
  it("admits only owned static instances, retaining colored or morphed instance detail", () => {
    const mesh = new InstancedMesh(new BoxGeometry(), new MeshStandardMaterial(), 2);
    try {
      expect(cellProxySourceSafe(mesh)).toBe(false);
      const owned = new Set<Mesh>([mesh]);
      expect(cellProxySourceSafe(mesh, owned)).toBe(true);
      mesh.instanceColor = mesh.instanceMatrix;
      expect(cellProxySourceSafe(mesh, owned)).toBe(false);
      mesh.instanceColor = null;
      mesh.morphTexture = new DataTexture(new Float32Array(4), 1, 1);
      expect(cellProxySourceSafe(mesh, owned)).toBe(false);
      mesh.morphTexture.dispose();
    } finally {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  });
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

describe("cell proxy measured private-copy admission", () => {
  it.each([false, true])(
    "conservatively charges shared backing stores (interleaved:%s)",
    (interleaved) => {
      const backing = new ArrayBuffer(512);
      const values = new Float32Array(backing, 32, 18);
      values.set([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
      const geometry = new BufferGeometry();
      if (interleaved) {
        const data = new InterleavedBuffer(values, 6);
        geometry.setAttribute("position", new InterleavedBufferAttribute(data, 3, 0));
        geometry.setAttribute("normal", new InterleavedBufferAttribute(data, 3, 3));
      } else {
        geometry.setAttribute("position", new BufferAttribute(values.subarray(0, 9), 3));
        geometry.setAttribute("normal", new BufferAttribute(values.subarray(9, 18), 3));
      }
      geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
      const mesh = new Mesh(geometry, new MeshStandardMaterial());
      const metadata = { glb: "proxy.glb", error: 0.1, triangles: 1, materialGroups: 1 };
      const measured = measureCellProxy(mesh, metadata, true);
      const prepared = prepareCellProxy(mesh, metadata, measured);
      const copiedBuffers = new Set<ArrayBufferLike>();
      for (const fixed of prepared.meshes)
        for (const attribute of [
          fixed.geometry.index,
          ...Object.values(fixed.geometry.attributes),
        ]) {
          if (attribute == null) continue;
          const array = Reflect.get(attribute, "array") ?? Reflect.get(attribute, "data").array;
          copiedBuffers.add(array.buffer);
        }
      const allocatedCopies = [...copiedBuffers].reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0,
      );
      expect(allocatedCopies).toBe(78);
      expect(measured).toBe(interleaved ? 668 : 596);
      expect(prepared.bytes).toBeGreaterThanOrEqual(518 + allocatedCopies);
      expect(() => prepareCellProxy(mesh, metadata, measured - 1)).toThrow(
        "reserved decoded budget",
      );
      for (const fixed of prepared.meshes) fixed.geometry.dispose();
      geometry.dispose();
      mesh.material.dispose();
    },
  );
});

describe("cell proxy preserves authored texture storage and static colors", () => {
  it.each([false, true])(
    "charges generated mip levels only when requested (%s)",
    (generateMipmaps) => {
      const map = new DataTexture(new Uint8Array(64), 4, 4);
      map.generateMipmaps = generateMipmaps;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
      );
      const mesh = new Mesh(geometry, new MeshStandardMaterial({ map }));
      const metadata = { glb: "proxy.glb", error: 0.1, triangles: 1, materialGroups: 1 };
      try {
        expect(measureCellProxy(mesh, metadata, true)).toBe(72 + (generateMipmaps ? 84 : 64));
        map.format = -1 as typeof RGBAFormat;
        expect(measureCellProxy(mesh, metadata, true)).toBe(72 + (generateMipmaps ? 336 : 256));
      } finally {
        map.dispose();
        geometry.dispose();
        mesh.material.dispose();
      }
    },
  );
  it("charges two real KTX2-style 1024-square BC7 mip chains instead of float32 RGBA", () => {
    const makeTexture = (size: number) => {
      const mips = [];
      for (let width = size; width >= 1; width /= 2)
        mips.push({
          width,
          height: width,
          data: new Uint8Array(
            TextureUtils.getByteLength(width, width, RGBA_BPTC_Format, UnsignedByteType),
          ),
        });
      return new CompressedTexture(mips, size, size, RGBA_BPTC_Format);
    };
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const map = makeTexture(1024);
    const normalMap = makeTexture(1024);
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ map, normalMap }));
    const metadata = { glb: "proxy.glb", error: 0.1, triangles: 1, materialGroups: 1 };
    try {
      expect(measureCellProxy(mesh, metadata, true)).toBe(2_796_328);
      map.dispose();
      mesh.material.map = makeTexture(2048);
      expect(() => measureCellProxy(mesh, metadata, true)).toThrow("decoded admission unit");
    } finally {
      mesh.material.map?.dispose();
      normalMap.dispose();
      geometry.dispose();
      mesh.material.dispose();
    }
  });
  it("accepts the cook's exact vertex bounds for a rotated mesh and rejects a box that misses it", () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const mesh = new Mesh(geometry, new MeshStandardMaterial());
    mesh.rotation.z = Math.PI / 4;
    const half = Math.SQRT1_2;
    const metadata: IWorldCellProxy = {
      glb: "proxy.glb",
      error: 0.1,
      triangles: 1,
      materialGroups: 1,
      bounds: { min: [-half, 0, 0], max: [half, half, 0] },
    };
    try {
      const prepared = prepareCellProxy(mesh, metadata);
      for (const fixed of prepared.meshes) fixed.geometry.dispose();
      expect(() =>
        prepareCellProxy(mesh, {
          ...metadata,
          bounds: { min: [-half, 0, 0], max: [half, 0.5, 0] },
        }),
      ).toThrow("declared bounds");
    } finally {
      geometry.dispose();
      mesh.material.dispose();
    }
  });
  it.each([3, 4])(
    "copies static color%d attributes and the loaded material unchanged",
    (itemSize) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
      );
      const color = new BufferAttribute(new Uint8Array(3 * itemSize).fill(127), itemSize, true);
      geometry.setAttribute("color", color);
      const mesh = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: true }));
      const metadata = { glb: "proxy.glb", error: 0.1, triangles: 1, materialGroups: 1 };
      try {
        expect(cellProxySourceSafe(mesh)).toBe(true);
        const prepared = prepareCellProxy(mesh, metadata);
        expect(prepared.meshes[0]?.material).toBe(mesh.material);
        const copied = prepared.meshes[0]?.geometry.getAttribute("color");
        expect(copied).not.toBe(color);
        expect(copied?.array).toEqual(color.array);
        expect(copied?.normalized).toBe(true);
        const originalHook = mesh.material.onBeforeCompile;
        mesh.material.onBeforeCompile = () => undefined;
        expect(cellProxySourceSafe(mesh)).toBe(false);
        mesh.material.onBeforeCompile = originalHook;
        geometry.morphAttributes.position = [geometry.getAttribute("position")];
        expect(cellProxySourceSafe(mesh)).toBe(false);
        geometry.morphAttributes = {};
        for (const fixed of prepared.meshes) fixed.geometry.dispose();
        geometry.setAttribute("color", new BufferAttribute(new Float32Array(6), 2));
        expect(cellProxySourceSafe(mesh)).toBe(false);
        geometry.setAttribute("color", new BufferAttribute(new Float32Array(6), 3));
        expect(cellProxySourceSafe(mesh)).toBe(false);
      } finally {
        geometry.dispose();
        mesh.material.dispose();
      }
    },
  );
});
