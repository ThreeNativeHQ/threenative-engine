import { OrthographicCamera, PerspectiveCamera, Vector2, Vector3 } from "three";
import { float, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { CURRENT_SAMPLE_POSITIONS } from "../templates/starter/src/render/temporalCurrentFootprintMath.js";
import {
  temporalDepthHasDisocclusion,
  temporalDepthHistoryUV,
} from "../templates/starter/src/render/temporalDepthSamples.js";

// Evaluate the constant arithmetic graph used by the real TSL helper. This interprets pinned
// Three nodes, not a second copy of the authored coordinate formula; the oracle below instead
// projects world points through independently jittered cameras.
function evaluate(node: Node): number[] {
  const n = node as unknown as {
    isConstNode?: boolean;
    isConvertNode?: boolean;
    isOperatorNode?: boolean;
    isMathNode?: boolean;
    node?: Node;
    value?: number | Vector2;
    convertTo?: string;
    nodeType?: string;
    aNode?: Node;
    bNode?: Node;
    op?: string;
    method?: string;
  };
  if (n.isConstNode) {
    const value = typeof n.value === "number" ? [n.value] : (n.value as Vector2).toArray();
    return n.nodeType === "ivec2" ? value.map(Math.trunc) : value;
  }
  if (n.convertTo !== undefined) {
    const value = evaluate(n.node as Node);
    return n.convertTo === "ivec2" ? value.map(Math.trunc) : value;
  }
  if (n.isMathNode && n.method === "max")
    return [Math.max(...evaluate(n.aNode as Node), ...evaluate(n.bNode as Node))];
  if (n.isOperatorNode) {
    const a = evaluate(n.aNode as Node);
    const b = evaluate(n.bNode as Node);
    return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
      const x = a[i % a.length];
      const y = b[i % b.length];
      if (x === undefined || y === undefined) throw new Error("Empty arithmetic operand");
      switch (n.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "/":
          return x / y;
        case ">":
          return Number(x > y);
        default:
          throw new Error(`Unexpected arithmetic ${n.op}`);
      }
    });
  }
  if (n.node) return evaluate(n.node);
  throw new Error(`Unexpected pinned node ${node.constructor.name}`);
}

function project(point: Vector3, camera: PerspectiveCamera | OrthographicCamera): Vector2 {
  const ndc = point.clone().project(camera);
  return new Vector2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

describe("depth history follows the actual input sample", () => {
  for (const width of [640, 426])
    for (const orthographic of [false, true]) {
      it(`matches world-point reprojection at ${width} input pixels, ortho=${orthographic}`, () => {
        const height = width === 640 ? 360 : 240;
        const camera = orthographic
          ? new OrthographicCamera(-2, 2, 1.125, -1.125, 0.1, 100)
          : new PerspectiveCamera(50, 16 / 9, 0.1, 100);
        camera.updateMatrixWorld();
        const currentJitter = new Vector2(0.25, -0.375);
        const previousJitter = new Vector2(-0.4375, 0.1875);
        const jitterCamera = (offset: Vector2) => {
          camera.setViewOffset(width, height, offset.x, offset.y, width, height);
          // The provider preserves the caller's display aspect when the floored input differs.
          if (camera instanceof PerspectiveCamera) {
            camera.aspect = 16 / 9;
            camera.updateProjectionMatrix();
          }
        };
        jitterCamera(currentJitter);
        const texel = new Vector2(121, 73);
        const current = new Vector3(
          ((texel.x + 0.5) / width) * 2 - 1,
          1 - ((texel.y + 0.5) / height) * 2,
          0.7,
        ).unproject(camera);
        const previous = current.clone().add(new Vector3(0.003, -0.002, 0));
        camera.clearViewOffset();
        const velocity = project(current, camera).sub(project(previous, camera));
        jitterCamera(previousJitter);
        const expected = project(previous, camera);
        // textureLoad casts float coordinates to ivec2. Its selected index, not the display UV or
        // the unrounded gather coordinate, names the surface whose velocity was read.
        const actual = evaluate(
          temporalDepthHistoryUV(
            vec2(texel.x + 0.75, texel.y + 0.25),
            vec2(width, height),
            vec2(velocity),
            vec2(currentJitter.clone().divide(new Vector2(width, height))),
            vec2(previousJitter.clone().divide(new Vector2(width, height))),
          ),
        );
        expect(actual[0]).toBeCloseTo(expected.x, 12);
        expect(actual[1]).toBeCloseTo(expected.y, 12);
        const displayCentre = new Vector2((texel.x + 1.5) / width, (texel.y + 0.5) / height);
        expect(displayCentre.sub(velocity).distanceTo(expected)).toBeGreaterThan(0.0005);
      });
    }
  it("uses the same truncating integer conversion as textureLoad at a negative boundary", () => {
    const actual = evaluate(
      temporalDepthHistoryUV(vec2(-0.75, 0.25), vec2(4, 4), vec2(0), vec2(0), vec2(0)),
    );
    expect(actual).toEqual([0.125, 0.125]);
  });
});

describe("both colour support and chosen surface retain their rejection authority", () => {
  const rejected = (current: number, centre: number, point: number) =>
    evaluate(
      temporalDepthHasDisocclusion(float(current), float(centre), float(point), float(0.0005)),
    )[0] === 1;
  it("rejects a removed centre occluder even when the selected foreground neighbor still matches", () => {
    expect(rejected(0.98, 0.97, 0.98)).toBe(true);
  });
  it("proves a four-site packet alone cannot retain the original centre veto", () => {
    // Two prior states are identical at all raw4 sites. Only the centre sees the tiny occluder.
    // This is an information counterexample, independent of any benchmark recovery witness.
    const depthAt = (x: number, y: number) => (Math.hypot(x - 0.5, y - 0.5) < 0.05 ? 0.2 : 1);
    expect(CURRENT_SAMPLE_POSITIONS.map(([x, y]) => depthAt(x, y))).toEqual([1, 1, 1, 1]);
    expect(rejected(0.9, 1, 1)).toBe(false);
    expect(rejected(0.9, depthAt(0.5, 0.5), 1)).toBe(true);
    // The other original veto also keeps independent authority with the same threshold.
    expect(rejected(0.9, 1, 0.2)).toBe(true);
  });
  it("rejects the chosen sample's revealed surface even when the colour centre previously saw background", () => {
    expect(rejected(0.98, 1, 0.97)).toBe(true);
  });
  it("keeps valid stable and approaching surfaces under the existing one-sided depth threshold", () => {
    expect(rejected(0.98, 0.98, 0.98)).toBe(false);
    expect(rejected(0.97, 0.98, 0.98)).toBe(false);
    expect(rejected(0.98, 0.97975, 0.97975)).toBe(false);
    expect(rejected(0.98, 0.979, 0.98)).toBe(true);
  });
});
