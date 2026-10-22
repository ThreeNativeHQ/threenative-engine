import {
  BackSide,
  DepthTexture,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  LessEqualCompare,
  PerspectiveCamera,
  PointLight,
  SpotLight,
} from "three";
import { float, vec3 } from "three/tsl";
import { describe, expect, it } from "vitest";
import {
  LEAF_MIN_SOURCE_TANGENT,
  isLeafReceiver,
  lampPenumbraTangent,
  penumbraUv,
  receiverSourceTangent,
  sourceAngleShadowFilter,
  sourceRadiusShadowFilter,
} from "../src/render/soft-shadow.js";

describe("source-angle soft shadows", () => {
  it("grows linearly with the gap above the texel floor", () => {
    const radius = penumbraUv(10, 0.02, 20, 2048);
    expect(radius).toBeCloseTo((10 * Math.tan(0.02)) / 20, 12);
    expect(penumbraUv(20, 0.02, 20, 2048)).toBeCloseTo(radius * 2, 12);
    expect(penumbraUv(10, 0.02, 40, 2048)).toBeCloseTo(radius / 2, 12);
  });

  it("keeps at least one texel for a zero gap or angle", () => {
    expect(penumbraUv(0, 0.02, 20, 2048)).toBe(1 / 2048);
    expect(penumbraUv(10, 0, 20, 1024)).toBe(1 / 1024);
  });

  it("rejects invalid math inputs", () => {
    for (let index = 0; index < 4; index++) {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        const args: [number, number, number, number] = [10, 0.02, 20, 2048];
        args[index] = bad;
        expect(() => penumbraUv(...args)).toThrow(RangeError);
      }
    }
    expect(() => penumbraUv(1, 0.02, 0, 2048)).toThrow(RangeError);
    expect(() => penumbraUv(1, 0.02, 20, 0)).toThrow(RangeError);
    expect(() => penumbraUv(1, Math.PI / 2, 20, 2048)).toThrow(RangeError);
    expect(() => penumbraUv(1, Math.PI, 20, 2048)).toThrow(RangeError);
  });

  it("carries the pixel floor to the owned engine and refuses a bad one", () => {
    const tag = (filter: unknown) =>
      (filter as Record<symbol, unknown>)[Symbol.for("threenative.sourceAngleShadowFilter")];
    expect(tag(sourceAngleShadowFilter({ sourceAngleRad: 0.02 }))).toEqual({
      sourceAngleRad: 0.02,
      blockerSamples: 16,
      filterSamples: 16,
      minPenumbraPixels: 0,
    });
    expect(
      tag(sourceAngleShadowFilter({ sourceAngleRad: 0.02, minPenumbraPixels: 1 })),
    ).toMatchObject({
      minPenumbraPixels: 1,
    });
    for (const minPenumbraPixels of [-0.5, Number.NaN, Number.POSITIVE_INFINITY, 17])
      expect(() => sourceAngleShadowFilter({ sourceAngleRad: 0.02, minPenumbraPixels })).toThrow(
        RangeError,
      );
  });

  it("creates a filter without a GPU and validates its options", () => {
    const sun = new DirectionalLight();
    const filter = sourceAngleShadowFilter({ sourceAngleRad: 0.02 });
    expect(filter).toBeTypeOf("function");
    const depthTexture = new DepthTexture(512, 512);
    depthTexture.compareFunction = LessEqualCompare;
    expect(filter({ depthTexture, shadowCoord: vec3(0.5), shadow: sun.shadow }).isNode).toBe(true);
    expect(() =>
      filter({
        depthTexture: new DepthTexture(512, 512),
        shadowCoord: vec3(0.5),
        shadow: sun.shadow,
      }),
    ).toThrow(/comparison depth texture/);
    for (const sourceAngleRad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Math.PI / 2]) {
      expect(() => sourceAngleShadowFilter({ sourceAngleRad })).toThrow(RangeError);
    }
    for (const count of [0, -1, 1.5, 65, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sourceAngleShadowFilter({ sourceAngleRad: 0, blockerSamples: count })).toThrow(
        RangeError,
      );
      expect(() => sourceAngleShadowFilter({ sourceAngleRad: 0, filterSamples: count })).toThrow(
        RangeError,
      );
    }
    // Unsupported cameras fail before any texture or renderer is needed.
    expect(() =>
      filter({
        depthTexture,
        shadowCoord: vec3(0),
        shadow: { ...sun.shadow, camera: new PerspectiveCamera() } as never,
      }),
    ).toThrow(/orthographic/i);
  });
});

describe("source-radius lamp shadows (PRD-650)", () => {
  it("widens linearly with the caster gap and the radius, and is 0 at radius 0", () => {
    // The world penumbra at the receiver: tangent times the receiver distance.
    const world = (radius: number, blocker: number, receiver: number) =>
      lampPenumbraTangent(radius, blocker, receiver) * receiver;
    expect(world(0.05, 2, 4)).toBeCloseTo((0.05 * (4 - 2)) / 2, 12);
    expect(world(0.05, 2, 6)).toBeCloseTo(world(0.05, 2, 4) * 2, 12);
    expect(world(0.1, 2, 4)).toBeCloseTo(world(0.05, 2, 4) * 2, 12);
    expect(lampPenumbraTangent(0, 2, 4)).toBe(0);
    expect(lampPenumbraTangent(0.05, 4, 4)).toBe(0);
    for (const args of [
      [-1, 2, 4],
      [Number.NaN, 2, 4],
      [0.05, 0, 4],
      [0.05, 2, Number.POSITIVE_INFINITY],
    ] satisfies Parameters<typeof lampPenumbraTangent>[])
      expect(() => lampPenumbraTangent(...args)).toThrow(RangeError);
  });

  it("builds a spot and a point filter without a GPU and refuses a sun", () => {
    const filter = sourceRadiusShadowFilter({ sourceRadius: 0.05 });
    const depthTexture = new DepthTexture(512, 512);
    depthTexture.compareFunction = LessEqualCompare;
    const spot = new SpotLight();
    const point = new PointLight();
    expect(filter({ depthTexture, shadowCoord: vec3(0.5), shadow: spot.shadow }).isNode).toBe(true);
    expect(
      filter({
        depthTexture,
        shadowCoord: vec3(0.5),
        shadow: point.shadow,
        bd3D: vec3(0, -1, 0),
        dp: float(0.5),
      }).isNode,
    ).toBe(true);
    expect(() =>
      filter({ depthTexture, shadowCoord: vec3(0.5), shadow: new DirectionalLight().shadow }),
    ).toThrow(/perspective camera/);
    expect(() =>
      filter({
        depthTexture: new DepthTexture(512, 512),
        shadowCoord: vec3(0.5),
        shadow: spot.shadow,
      }),
    ).toThrow(/comparison texture/);
    for (const sourceRadius of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => sourceRadiusShadowFilter({ sourceRadius })).toThrow(RangeError);
    for (const count of [0, 65, 1.5])
      expect(() => sourceRadiusShadowFilter({ sourceRadius: 0, filterSamples: count })).toThrow(
        RangeError,
      );
    expect(
      (filter as unknown as Record<symbol, unknown>)[
        Symbol.for("threenative.sourceRadiusShadowFilter")
      ],
    ).toEqual({ sourceRadius: 0.05, blockerSamples: 16, filterSamples: 16 });
  });
});

describe("leaf receivers (PRD-651)", () => {
  it("names a two-sided receiver cut by an alpha test, by number or by node", () => {
    expect(isLeafReceiver({ side: DoubleSide, alphaTest: 0.5 })).toBe(true);
    expect(isLeafReceiver({ side: DoubleSide, alphaTest: 0, alphaTestNode: float(0.4) })).toBe(
      true,
    );
    // One side, no cut, or neither: an ordinary receiver.
    expect(isLeafReceiver({ side: FrontSide, alphaTest: 0.5 })).toBe(false);
    expect(isLeafReceiver({ side: BackSide, alphaTest: 0.5 })).toBe(false);
    expect(isLeafReceiver({ side: DoubleSide, alphaTest: 0 })).toBe(false);
    expect(isLeafReceiver({ side: DoubleSide, alphaTestNode: null })).toBe(false);
    expect(isLeafReceiver(null)).toBe(false);
    expect(isLeafReceiver(undefined)).toBe(false);
  });

  it("widens the sun's source to 5 degrees on a leaf and leaves a wider one alone", () => {
    const sun = Math.tan(0.0047); // Unreal's default sun, 0.27 degrees
    const leaf = { side: DoubleSide, alphaTest: 0.5 };
    expect(LEAF_MIN_SOURCE_TANGENT).toBeCloseTo(Math.tan((5 * Math.PI) / 180), 12);
    expect(receiverSourceTangent(leaf, sun)).toBe(LEAF_MIN_SOURCE_TANGENT);
    expect(receiverSourceTangent({ side: FrontSide, alphaTest: 0.5 }, sun)).toBe(sun);
    expect(receiverSourceTangent(leaf, 0.2)).toBe(0.2);
    expect(receiverSourceTangent(undefined, sun)).toBe(sun);
  });
});
