/**
 * The plain-JS addons both engine back ends share, against the pinned upstream three as the oracle:
 * `DataUtils` bit for bit, `parseHDR` texel for texel with three's `HDRLoader.parse`, and the
 * `MeshBVH` query contract core's picking relies on.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { DataUtils, fromHalfFloat, toHalfFloat } from "../src/addons/data-utils.js";
import { FLOAT_TYPE, HALF_FLOAT_TYPE, parseHDR } from "../src/addons/hdr.js";
import { AVERAGE, CENTER, MeshBVH, SAH } from "../src/addons/mesh-bvh.js";

const threeRoot = path.join(
  path.dirname(
    createRequire(path.join(process.cwd(), "packages", "core", "package.json")).resolve("three"),
  ),
  "..",
);

// three-mesh-bvh resolves from core, which depends on it.
const bvhRoot = path.join(
  path.dirname(
    createRequire(path.join(process.cwd(), "packages", "core", "package.json")).resolve(
      "three-mesh-bvh",
    ),
  ),
  "..",
);

interface IUpstreamDataUtils {
  toHalfFloat(value: number): number;
  fromHalfFloat(bits: number): number;
}
interface IUpstreamHDR {
  setDataType(type: number): IUpstreamHDR;
  parse(buffer: ArrayBuffer): {
    width: number;
    height: number;
    data: Uint16Array | Float32Array;
    type: number;
  };
}

async function upstream() {
  const three = (await import(
    pathToFileURL(path.join(threeRoot, "build", "three.module.js")).href
  )) as {
    DataUtils: IUpstreamDataUtils;
  };
  const { HDRLoader } = (await import(
    pathToFileURL(path.join(threeRoot, "examples", "jsm", "loaders", "HDRLoader.js")).href
  )) as { HDRLoader: new () => IUpstreamHDR };
  return { DataUtils: three.DataUtils, HDRLoader };
}

/** A deterministic byte stream (xorshift), so a failure reproduces. */
function bytes(count: number, seed: number): Uint8Array {
  const out = new Uint8Array(count);
  let x = seed;
  for (let i = 0; i < count; ++i) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

/** A Radiance file: header, then RGBE pixels flat (width < 8) or run-length encoded per channel. */
function radiance(width: number, height: number, rgbe: Uint8Array): ArrayBuffer {
  const header = `#?RADIANCE\n# synthetic\nGAMMA=1.0\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const body: number[] = [];
  if (width < 8) body.push(...rgbe);
  else {
    for (let y = 0; y < height; ++y) {
      body.push(2, 2, width >> 8, width & 0xff);
      for (let c = 0; c < 4; ++c) {
        const channel = Array.from({ length: width }, (_, x) => rgbe[(y * width + x) * 4 + c] ?? 0);
        // A run for the first half (both encodings are exercised), literals for the rest.
        const half = width >> 1;
        body.push(128 + half, channel[0] ?? 0);
        body.push(width - half, ...channel.slice(half));
        for (let x = 0; x < half; ++x) rgbe[(y * width + x) * 4 + c] = channel[0] ?? 0;
      }
    }
  }
  const out = new Uint8Array(header.length + body.length);
  for (let i = 0; i < header.length; ++i) out[i] = header.charCodeAt(i);
  out.set(body, header.length);
  return out.buffer;
}

describe("DataUtils", () => {
  it("matches upstream three bit for bit across normals, subnormals, overflow and specials", async () => {
    const reference = (await upstream()).DataUtils;
    const values = [
      0,
      -0,
      1,
      -2,
      0.5,
      1 / 3,
      65504,
      65520,
      1e9,
      -1e9,
      6.1e-5,
      5.96e-8,
      1e-10,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const raw of bytes(4096, 7)) values.push((raw - 128) * 3.7, raw / 255, raw * 1e-6);
    const quiet = console.warn;
    console.warn = () => {};
    try {
      for (const value of values) expect(toHalfFloat(value)).toBe(reference.toHalfFloat(value));
    } finally {
      console.warn = quiet;
    }
    for (let bits = 0; bits < 0x10000; ++bits)
      expect(Object.is(fromHalfFloat(bits), reference.fromHalfFloat(bits))).toBe(true);
    expect(DataUtils.toHalfFloat(1)).toBe(0x3c00);
    expect(DataUtils.fromHalfFloat(0xc000)).toBe(-2);
  });
});

describe("parseHDR", () => {
  it("decodes run-length and flat files exactly as three's HDRLoader, for both data types", async () => {
    const { HDRLoader } = await upstream();
    for (const [width, height] of [
      [16, 3],
      [5, 2],
    ] as const) {
      const rgbe = bytes(width * height * 4, width);
      for (let i = 3; i < rgbe.length; i += 4) rgbe[i] = 120 + ((rgbe[i] ?? 0) % 30);
      rgbe[3] = 150; // overflows binary16: three clamps to 65504 before converting
      const file = radiance(width, height, rgbe);
      for (const type of [HALF_FLOAT_TYPE, FLOAT_TYPE]) {
        const ours = parseHDR(file, type);
        const theirs = new HDRLoader().setDataType(type).parse(file);
        expect([ours.width, ours.height, ours.type]).toEqual([
          theirs.width,
          theirs.height,
          theirs.type,
        ]);
        expect(ours.data.constructor).toBe(theirs.data.constructor);
        expect(Array.from(ours.data)).toEqual(Array.from(theirs.data));
      }
    }
  });

  it("fails closed on a damaged file", () => {
    const encode = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
    expect(() => parseHDR(encode("P6\n"))).toThrow(/TN_HDR_INVALID: bad initial token/);
    expect(() => parseHDR(encode("#?RADIANCE\n-Y 1 +X 1\n"))).toThrow(/missing format specifier/);
    expect(() =>
      parseHDR(encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n-Y 1 +X 2\n\u0001\u0002")),
    ).toThrow(/pixel data does not match the image size/);
    expect(() => parseHDR(new ArrayBuffer(0), 1009)).toThrow(/unsupported type 1009/);
  });
});

describe("MeshBVH", () => {
  const hits = [{ distance: 1 }, { distance: 2 }];
  const raycaster = (firstHitOnly?: boolean) => ({
    firstHitOnly,
    calls: [] as unknown[][],
    intersectObject(object: object, recursive: boolean) {
      this.calls.push([object, recursive]);
      return hits;
    },
  });

  it("answers raycastObject3D from the engine raycast, nearest only under firstHitOnly", () => {
    const geometry = {};
    const tree = new MeshBVH(geometry);
    expect(tree.geometry).toBe(geometry);
    const mesh = {};
    const all = raycaster(false);
    const into: object[] = [{ distance: 0 }];
    expect(tree.raycastObject3D(mesh, all, into)).toBe(into);
    expect(into).toEqual([{ distance: 0 }, ...hits]);
    expect(all.calls).toEqual([[mesh, false]]);
    expect(tree.raycastObject3D(mesh, raycaster(true))).toEqual([hits[0]]);
  });

  it("exports three-mesh-bvh's split strategies with its values, and takes one as strategy", async () => {
    const constants = (await import(
      pathToFileURL(path.join(bvhRoot, "src/core/Constants.js")).href
    )) as { CENTER: number; AVERAGE: number; SAH: number };
    expect({ CENTER, AVERAGE, SAH }).toEqual({
      CENTER: constants.CENTER,
      AVERAGE: constants.AVERAGE,
      SAH: constants.SAH,
    });
    for (const strategy of [CENTER, AVERAGE, SAH])
      expect(new MeshBVH({}, { strategy })).toBeDefined();
    expect(() => new MeshBVH({}, { strategy: 7 })).toThrow(/TN_NATIVE_MESH_BVH_STRATEGY/);
  });

  it("refuses build options it cannot honour", () => {
    expect(() => new MeshBVH({}, { strategy: SAH, indirect: true })).toThrow(
      /TN_NATIVE_MESH_BVH_OPTIONS_UNSUPPORTED: indirect/,
    );
  });
});
