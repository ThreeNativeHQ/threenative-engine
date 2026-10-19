import { PerspectiveCamera, Scene, Vector3 } from "three";
import { expect, it } from "vitest";
import { createStormLightning, makeBolt } from "../templates/rain/src/render/lightning.js";

/** The study's own `rng`, so a seeded bolt is the same bolt twice. */
function seeded(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (v: Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

it("builds a branched bolt that starts in the sky and lands on the requested point", () => {
  const end = new Vector3(12, 0, -300);
  const bolt = makeBolt(end, seeded(4711));
  expect(bolt.origin.y).toBeGreaterThanOrEqual(145);
  expect(bolt.origin.y).toBeLessThanOrEqual(245);
  expect(bolt.end).toEqual(end);
  // The channel's 30 segments are all present, every endpoint is a real finite metre-scale point,
  // and no segment is a zero-length stub that would collapse to a dot on the near plane.
  expect(bolt.segments.length).toBeGreaterThanOrEqual(30);
  const channels = bolt.segments.filter((s) => s.strength === 1);
  expect(channels.length).toBe(30);
  expect(channels[29]?.b).toEqual(end);
  for (const segment of bolt.segments) {
    expect(finite(segment.a)).toBe(true);
    expect(finite(segment.b)).toBe(true);
    expect(segment.a.distanceTo(segment.b)).toBeGreaterThan(0);
    expect(segment.strength).toBeGreaterThan(0);
    expect(segment.strength).toBeLessThanOrEqual(1);
  }
  // Branches are off the channel, weaker than it, and falling away from it.
  const branches = bolt.segments.filter((s) => s.strength < 1);
  expect(branches.length).toBeGreaterThan(0);
  for (const branch of branches) expect(branch.b.y).toBeLessThan(branch.a.y);
  // Two seeds, two different bolts: the shape is the caller's random, not a fixed scribble.
  expect(makeBolt(end, seeded(1)).segments.map((s) => s.b.z)).not.toEqual(
    makeBolt(end, seeded(2)).segments.map((s) => s.b.z),
  );
});

it("drives a real mesh from one strike, rejects non-finite input, and releases everything", () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 400);
  const lightning = createStormLightning(scene, camera);
  const { mesh } = lightning;
  const geometry = mesh.geometry as unknown as {
    drawRange: { count: number };
    getAttribute(name: string): { array: Float32Array; version: number };
    dispose(): void;
  };
  const material = mesh.material as unknown as { dispose(): void };
  let disposed = 0;
  const realDispose = geometry.dispose.bind(geometry);
  geometry.dispose = () => {
    disposed++;
    realDispose();
  };

  expect(scene.children).toContain(mesh);
  expect(geometry.drawRange.count).toBe(0);
  // Nothing has been struck, so a bright flash with no bolt must not issue a draw.
  lightning.update(1.5);
  expect(mesh.visible).toBe(false);

  const origin = lightning.strike(new Vector3(12, 0, -300), seeded(4711));
  expect(finite(origin)).toBe(true);
  const segments = geometry.drawRange.count / 6;
  expect(segments).toBeGreaterThanOrEqual(30);
  // The flash alone decides visibility, so a struck bolt on a dark frame is still hidden.
  expect(mesh.visible).toBe(false);
  lightning.update(1.5);
  expect(mesh.visible).toBe(true);

  // The buffers the draw range covers hold that bolt's own endpoints, and every one is finite.
  const starts = geometry.getAttribute("aStart").array;
  const ends = geometry.getAttribute("aEnd").array;
  const strengths = geometry.getAttribute("aStrength").array;
  // Each attribute's version advanced, so the rewrite is queued for upload rather than lost.
  expect(geometry.getAttribute("aStart").version).toBeGreaterThan(0);
  expect(geometry.getAttribute("aEnd").version).toBeGreaterThan(0);
  expect(geometry.getAttribute("aStrength").version).toBeGreaterThan(0);
  for (let i = 0; i < geometry.drawRange.count; i++) {
    const at = i * 3;
    expect(
      Number.isFinite(starts[at]) &&
        Number.isFinite(starts[at + 1]) &&
        Number.isFinite(starts[at + 2]),
    ).toBe(true);
    expect(
      Number.isFinite(ends[at]) && Number.isFinite(ends[at + 1]) && Number.isFinite(ends[at + 2]),
    ).toBe(true);
    expect(Number.isFinite(strengths[i] as number)).toBe(true);
    expect(strengths[i]).toBeGreaterThan(0);
  }
  // The last channel segment really does land on the point the caller asked for. Branches come after
  // their channel segment, so the channel's own last vertex is the last one at full strength.
  let lastChannel = -1;
  for (let i = 0; i < geometry.drawRange.count; i++) {
    if (strengths[i] === 1) lastChannel = i;
  }
  expect(Array.from(ends.subarray(lastChannel * 3, lastChannel * 3 + 3))).toEqual([12, 0, -300]);

  // The flash is the caller's, already photosafe: a dark frame hides the bolt, a bright one shows it.
  lightning.update(0);
  expect(mesh.visible).toBe(false);
  lightning.update(2.4);
  expect(mesh.visible).toBe(true);
  expect(() => lightning.update(Number.NaN)).toThrow(/finite/);

  expect(() => lightning.strike(new Vector3(Number.NaN, 0, -300), seeded(1))).toThrow(/finite/);
  expect(() => lightning.strike({ x: 0, y: 0, z: 0 } as Vector3, seeded(1))).toThrow(/finite/);
  expect(() =>
    lightning.strike(new Vector3(0, 0, -300), undefined as unknown as () => number),
  ).toThrow(/random/);
  expect(() => lightning.strike(new Vector3(0, 0, -300), () => Number.NaN)).toThrow(/finite/);

  lightning.dispose();
  expect(scene.children).not.toContain(mesh);
  expect(disposed).toBe(1);
});
