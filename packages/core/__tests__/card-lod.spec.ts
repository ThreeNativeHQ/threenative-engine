import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { thinCards } from "../src/card-lod.js";

/** `count` unit quads (two triangles each), each its own island, spread along x. */
function cards(count: number): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < count; i++) {
    const x = i * 3;
    positions.push(x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    const v = i * 4;
    index.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(index);
  return geometry;
}

function area(geometry: BufferGeometry): number {
  const index = geometry.index as BufferAttribute;
  const position = geometry.getAttribute("position");
  const [a, b, c] = [new Vector3(), new Vector3(), new Vector3()];
  let sum = 0;
  for (let t = 0; t < index.count; t += 3) {
    a.fromBufferAttribute(position, index.getX(t));
    b.fromBufferAttribute(position, index.getX(t + 1));
    c.fromBufferAttribute(position, index.getX(t + 2));
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

describe("thinCards", () => {
  it("keeps the share of cards asked and holds the total area", () => {
    const source = cards(100);
    const far = thinCards(source, 0.4);
    expect((far.index as BufferAttribute).count / 3).toBe(80);
    expect(area(far)).toBeCloseTo(area(source), 3);
    // The source is untouched: a nearer level still draws it.
    expect(area(source)).toBeCloseTo(100, 3);
    expect((source.index as BufferAttribute).count / 3).toBe(200);
  });

  it("grows each kept card about its own centre, and keeps the uvs", () => {
    const far = thinCards(cards(16), 0.25);
    const index = far.index as BufferAttribute;
    const position = far.getAttribute("position");
    const v = index.getX(0);
    const first = Math.floor(v / 4) * 4;
    const corners = [0, 1, 2, 3].map((k) => new Vector3().fromBufferAttribute(position, first + k));
    const centre = corners.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(4);
    expect(centre.x).toBeCloseTo((first / 4) * 3 + 0.5, 5);
    expect(centre.y).toBeCloseTo(0.5, 5);
    expect(corners[0]?.distanceTo(corners[1] as Vector3)).toBeCloseTo(2, 5); // sqrt(1 / 0.25)
    expect(far.getAttribute("uv").getX(first + 1)).toBe(1);
  });

  it("is deterministic, and keeps the whole mesh when nothing would go", () => {
    const source = cards(50);
    expect(Array.from(thinCards(source, 0.3).index?.array ?? [])).toEqual(
      Array.from(thinCards(source, 0.3).index?.array ?? []),
    );
    expect(thinCards(source, 1)).toBe(source);
  });

  it("thins only the drawn range of a section cut by setDrawRange, and draws all it keeps", () => {
    const section = cards(100);
    section.setDrawRange(300, 300); // cards 50..99: the second material section of a shared index
    const far = thinCards(section, 0.4);
    const index = far.index as BufferAttribute;
    expect(index.count / 3).toBe(40);
    for (let i = 0; i < index.count; i++) expect(index.getX(i)).toBeGreaterThanOrEqual(200);
    expect(far.drawRange.start).toBe(0);
    expect(far.drawRange.count).toBe(Number.POSITIVE_INFINITY);
    expect(area(far)).toBeCloseTo(50, 3);
  });

  it("fails closed on what it cannot thin", () => {
    expect(() => thinCards(cards(4), 0)).toThrow(/keep/);
    expect(() => thinCards(cards(4), 1.5)).toThrow(/keep/);
    const loose = cards(4).toNonIndexed();
    expect(() => thinCards(loose, 0.5)).toThrow(/indexed/);
    const grouped = cards(4);
    grouped.addGroup(0, 12, 0);
    expect(() => thinCards(grouped, 0.5)).toThrow(/groups/);
  });
});
