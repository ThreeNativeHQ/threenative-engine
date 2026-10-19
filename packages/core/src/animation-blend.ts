/*!
 * Selectively adapted from GGEZ packages/anim-runtime/src/runtime/helpers.ts
 * (findBlend1DChildren, computeTriangleBarycentricWeights, findBlend2DEdgeWeights)
 * at 45ed541cb163ef98694467758f60d5533373ac60. Replaced graph children with
 * validated fixed sample indices, initialization-only sorting and reusable output.
 * MIT License
 * Copyright (c) 2026 @alightinastorm (x.com/alightinastorm)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

interface IBlendThreshold {
  readonly value: number;
  readonly index: number;
}

type Point = readonly [number, number];
type Triangle = readonly [number, number, number];
const EPSILON = 1e-10;

export function animationFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`AnimationComposer: ${name} must be finite.`);
  return value;
}

export class BlendSpace1D {
  readonly weights: Float64Array;
  readonly #samples: readonly IBlendThreshold[];

  constructor(thresholds: readonly number[]) {
    if (thresholds.length === 0) throw new Error("BlendSpace1D requires samples.");
    this.#samples = thresholds
      .map((value, index) => ({ value: animationFinite(value, `threshold[${index}]`), index }))
      .sort((a, b) => a.value - b.value);
    for (let i = 1; i < this.#samples.length; i += 1) {
      const distance =
        (this.#samples[i] as IBlendThreshold).value -
        (this.#samples[i - 1] as IBlendThreshold).value;
      if (distance === 0) throw new Error("BlendSpace1D: duplicate threshold.");
      animationFinite(distance, "threshold interval");
    }
    this.weights = new Float64Array(thresholds.length);
  }

  sample(value: number): Float64Array {
    animationFinite(value, "1D query");
    const weights = this.weights;
    weights.fill(0);
    const first = this.#samples[0] as IBlendThreshold;
    const last = this.#samples[this.#samples.length - 1] as IBlendThreshold;
    if (value <= first.value) weights[first.index] = 1;
    else if (value >= last.value) weights[last.index] = 1;
    else {
      for (let i = 1; i < this.#samples.length; i += 1) {
        const b = this.#samples[i] as IBlendThreshold;
        if (value > b.value) continue;
        const a = this.#samples[i - 1] as IBlendThreshold;
        const t = (value - a.value) / (b.value - a.value);
        weights[a.index] = 1 - t;
        weights[b.index] = t;
        break;
      }
    }
    return weights;
  }
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function hull(points: readonly Point[]): number[] {
  const sorted = points
    .map((_, i) => i)
    .sort(
      (a, b) =>
        (points[a] as Point)[0] - (points[b] as Point)[0] ||
        (points[a] as Point)[1] - (points[b] as Point)[1],
    );
  const half = (indices: number[]) => {
    const result: number[] = [];
    for (const i of indices) {
      while (
        result.length > 1 &&
        cross(
          points[result[result.length - 2] as number] as Point,
          points[result[result.length - 1] as number] as Point,
          points[i] as Point,
        ) <= 0
      )
        result.pop();
      result.push(i);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/** Fixed complete convex-hull triangulation. Collinear triangles and overlapping tiles fail at load. */
export class BlendSpace2D {
  readonly weights: Float64Array;
  readonly #points: readonly Point[];
  readonly #triangles: readonly Triangle[];
  readonly #hull: readonly number[];
  readonly #boundary: readonly (readonly [number, number])[];

  constructor(points: readonly Point[], triangles: readonly Triangle[]) {
    if (points.length < 3 || triangles.length === 0)
      throw new Error("BlendSpace2D requires a triangulation of at least three samples.");
    this.#points = points.map((p, i) => {
      if (p.length !== 2) throw new Error(`BlendSpace2D: sample[${i}] must have two coordinates.`);
      return [animationFinite(p[0], `sample[${i}].x`), animationFinite(p[1], `sample[${i}].y`)];
    });
    for (let a = 0; a < points.length; a += 1)
      for (let b = a + 1; b < points.length; b += 1)
        if (
          (points[a] as Point)[0] === (points[b] as Point)[0] &&
          (points[a] as Point)[1] === (points[b] as Point)[1]
        )
          throw new Error("BlendSpace2D: duplicate sample.");
    this.#hull = hull(this.#points);
    this.weights = new Float64Array(points.length);
    const used = new Set<number>();
    const seen = new Set<string>();
    const edges = new Map<string, { a: number; b: number; count: number }>();
    let area = 0;
    this.#triangles = triangles.map((triangle) => {
      if (
        triangle.length !== 3 ||
        triangle.some((i) => !Number.isInteger(i) || i < 0 || i >= points.length)
      )
        throw new Error("BlendSpace2D: invalid triangle index.");
      const key = [...triangle].sort((a, b) => a - b).join(",");
      if (seen.has(key)) throw new Error("BlendSpace2D: duplicate triangle.");
      seen.add(key);
      let [a, b, c] = triangle;
      const signed = animationFinite(
        cross(points[a] as Point, points[b] as Point, points[c] as Point),
        "triangle area",
      );
      if (signed === 0) throw new Error("BlendSpace2D: collinear triangle.");
      if (signed < 0) [b, c] = [c, b];
      area += Math.abs(signed);
      for (const index of triangle) used.add(index);
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = [u, v].sort((a, b) => (a as number) - (b as number)).join(",");
        const edge = edges.get(key);
        if (edge !== undefined) {
          if (edge.count !== 1 || edge.a !== v)
            throw new Error("BlendSpace2D: overlapping/nonmanifold triangulation.");
          edge.count += 1;
        } else edges.set(key, { a: u as number, b: v as number, count: 1 });
      }
      return [a, b, c];
    });
    if (used.size !== points.length) throw new Error("BlendSpace2D: unused sample.");
    const origin = points[this.#hull[0] as number] as Point;
    let hullArea = 0;
    for (let i = 1; i + 1 < this.#hull.length; i += 1)
      hullArea += cross(
        origin,
        points[this.#hull[i] as number] as Point,
        points[this.#hull[i + 1] as number] as Point,
      );
    if (!Number.isFinite(area) || Math.abs(area - hullArea) > EPSILON * hullArea)
      throw new Error("BlendSpace2D: triangulation must cover the convex hull exactly.");
    for (const edge of edges.values()) {
      if (edge.count !== 1) continue;
      const onHull = this.#hull.some((a, i) => {
        const b = this.#hull[(i + 1) % this.#hull.length] as number;
        return (
          cross(points[a] as Point, points[b] as Point, points[edge.a] as Point) === 0 &&
          cross(points[a] as Point, points[b] as Point, points[edge.b] as Point) === 0
        );
      });
      if (!onHull) throw new Error("BlendSpace2D: triangulation has an interior boundary.");
    }
    this.#boundary = [...edges.values()]
      .filter((edge) => edge.count === 1)
      .map((edge) => [edge.a, edge.b]);
    for (let i = 0; i < this.#triangles.length; i += 1) {
      const a = this.#triangles[i] as Triangle;
      for (let j = i + 1; j < this.#triangles.length; j += 1) {
        const b = this.#triangles[j] as Triangle;
        for (let u = 0; u < 3; u += 1)
          for (let v = 0; v < 3; v += 1) {
            const p = points[a[u] as number] as Point;
            const q = points[a[(u + 1) % 3] as number] as Point;
            const r = points[b[v] as number] as Point;
            const s = points[b[(v + 1) % 3] as number] as Point;
            if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0)
              throw new Error("BlendSpace2D: crossing triangle edges.");
          }
      }
    }
  }

  sample(x: number, y: number): Float64Array {
    animationFinite(x, "2D query.x");
    animationFinite(y, "2D query.y");
    this.weights.fill(0);
    for (const [a, b, c] of this.#triangles) {
      const p = this.#points[a] as Point;
      const q = this.#points[b] as Point;
      const r = this.#points[c] as Point;
      const denominator = cross(p, q, r);
      const wa = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / denominator;
      const wb = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / denominator;
      const wc = 1 - wa - wb;
      if (Math.min(wa, wb, wc) < -EPSILON) continue;
      animationFinite(wa + wb + wc, "barycentric query");
      this.weights[a] = Math.max(0, wa);
      this.weights[b] = Math.max(0, wb);
      this.weights[c] = Math.max(0, wc);
      const sum =
        (this.weights[a] as number) + (this.weights[b] as number) + (this.weights[c] as number);
      this.weights[a] = (this.weights[a] as number) / sum;
      this.weights[b] = (this.weights[b] as number) / sum;
      this.weights[c] = (this.weights[c] as number) / sum;
      return this.weights;
    }
    let best = Number.POSITIVE_INFINITY;
    let bestA = 0;
    let bestB = 0;
    let bestT = 0;
    for (const [a, b] of this.#boundary) {
      const p = this.#points[a] as Point;
      const q = this.#points[b] as Point;
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy)));
      const distance = animationFinite(
        (x - p[0] - dx * t) ** 2 + (y - p[1] - dy * t) ** 2,
        "hull projection",
      );
      if (distance < best) {
        best = distance;
        bestA = a;
        bestB = b;
        bestT = t;
      }
    }
    this.weights[bestA] = 1 - bestT;
    this.weights[bestB] = bestT;
    return this.weights;
  }
}
