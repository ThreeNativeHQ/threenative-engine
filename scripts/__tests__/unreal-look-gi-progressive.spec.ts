import { readFileSync } from "node:fs";
import {
  BoxGeometry,
  Color,
  Group,
  type Intersection,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { giCache, installGi } from "../unreal-look/scaffold/render/giCache.js";

const SUN = {
  color: new Color(1, 1, 1),
  intensity: 3,
  direction: new Vector3(0.3, 0.9, 0.3).normalize(),
};

/** The sunlit-room calibration scene (tools/unreal-reference/gi/sunlit-room): boxes with their base colours. */
function sunlitRoom(): Group {
  const data = JSON.parse(
    readFileSync("tools/unreal-reference/gi/sunlit-room/scene.json", "utf8"),
  ) as {
    meshes: {
      size: [number, number, number];
      position: [number, number, number];
      material: { baseColor: [number, number, number] };
    }[];
  };
  const room = new Group();
  for (const m of data.meshes) {
    const mesh = new Mesh(
      new BoxGeometry(...m.size),
      new MeshStandardMaterial({ color: new Color(...m.material.baseColor) }),
    );
    mesh.position.set(...m.position);
    room.add(mesh);
  }
  room.updateMatrixWorld(true);
  return room;
}

const rayContext = (root: Group) => {
  const caster = new Raycaster();
  return {
    raycast: ({ origin, direction, far }: { origin: Vector3; direction: Vector3; far: number }) => {
      caster.set(origin, direction);
      caster.far = far;
      return caster.intersectObject(root, true)[0] as Intersection | undefined;
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("progressive GI bake", () => {
  it("shows a provisional cache at once and converges, over frames, to the cache a single bake makes", () => {
    const whole = sunlitRoom();
    const reference = installGi(rayContext(whole), whole, { bounces: 5, sun: SUN });
    const wanted = Float32Array.from(giCache.field?.values ?? []);
    expect(reference?.pass).toBe("final");

    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    const room = sunlitRoom();
    let converged: unknown;
    const first = installGi(rayContext(room), room, {
      bounces: 5,
      sun: SUN,
      progressive: {
        previewRays: 16,
        budgetMs: 5,
        onConverged: (r) => {
          converged = r;
        },
      },
    });
    // At once: the preview, cheaper than the full bake, already readable by the materials.
    expect(first?.pass).toBe("preview");
    expect(first?.bounces).toBe(1);
    expect(first?.rays).toBeLessThan((reference?.rays ?? 0) / 3);
    const preview = Float32Array.from(giCache.field?.values ?? []);
    const texture = giCache.texture;
    const before = Uint16Array.from(texture?.image.data as Uint16Array);
    const version = texture?.version ?? 0;
    const material = (room.children[0] as Mesh).material;
    expect(material).not.toBeInstanceOf(MeshStandardMaterial);
    expect(frames.length).toBe(1);

    // The full bake is spread over frames, each doing a slice of the work.
    let steps = 0;
    while (converged === undefined && steps < 100000) {
      frames.shift()?.();
      steps += 1;
    }
    expect(steps).toBeGreaterThan(3);
    expect((converged as { pass: string }).pass).toBe("final");
    expect((converged as { rays: number }).rays).toBe(reference?.rays);
    // The same computation as the single bake, only cut into slices: the same field, to the bit.
    const got = giCache.field?.values ?? new Float32Array(0);
    expect(got.length).toBe(wanted.length);
    expect(got.every((v, i) => v === wanted[i])).toBe(true);
    expect(preview.some((v, i) => v !== wanted[i])).toBe(true);
    // The materials still read the one texture, now holding the full bake.
    expect(giCache.texture).toBe(texture);
    expect(texture?.version).toBeGreaterThan(version);
    expect((texture?.image.data as Uint16Array).some((v, i) => v !== before[i])).toBe(true);
    expect((room.children[0] as Mesh).material).toBe(material);
  });

  it("bakes in one call when the rays are the game's own, because slicing needs the flat ones", () => {
    const room = sunlitRoom();
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    const report = installGi(rayContext(room), room, {
      bounces: 1,
      stockRays: true,
      sun: SUN,
      progressive: { previewRays: 16, budgetMs: 1 },
    });
    expect(report?.pass).toBe("final");
    expect(frames.length).toBe(0);
  });
});
