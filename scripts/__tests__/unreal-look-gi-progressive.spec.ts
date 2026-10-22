import { readFileSync } from "node:fs";
import {
  BoxGeometry,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  type Intersection,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { giCache, installGi, skyRadiance } from "../unreal-look/scaffold/render/giCache.js";

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
    // The bake is paced by the clock: a page that presents one frame a second must not stretch it.
    vi.stubGlobal("requestAnimationFrame", () => {
      throw new Error("the bake waited for a frame");
    });
    const room = sunlitRoom();
    const staleField = giCache.field;
    let converged: unknown;
    const first = installGi(rayContext(room), room, {
      bounces: 5,
      sun: SUN,
      progressive: {
        previewRays: 16,
        budgetMs: 5,
        defer: (run) => void frames.push(run),
        onConverged: (r) => {
          converged = r;
        },
      },
    });
    // At once: the materials read a black cache of the final size and nothing is baked yet.
    expect(first?.pass).toBe("pending");
    expect(giCache.field).toBe(staleField);
    const texture = giCache.texture;
    expect(texture).toBeDefined();
    const blank = Uint16Array.from(texture?.image.data as Uint16Array);
    expect(blank.every((v) => v === 0)).toBe(true);
    const material = (room.children[0] as Mesh).material;
    expect(material).not.toBeInstanceOf(MeshStandardMaterial);
    expect(frames.length).toBe(1);

    // The provisional bake lands after some frames, cheaper than the full one, in the same texture.
    let steps = 0;
    /** The longest a slice held the thread: the page is never frozen for more than this by the bake. */
    let longest = 0;
    const runSlice = (): void => {
      const at = performance.now();
      frames.shift()?.();
      longest = Math.max(longest, performance.now() - at);
    };
    while (giCache.field === staleField && steps < 100000) {
      runSlice();
      steps += 1;
    }
    expect(giCache.field).not.toBe(staleField);
    expect(giCache.texture).toBe(texture);
    const preview = Float32Array.from(giCache.field?.values ?? []);
    const before = Uint16Array.from(texture?.image.data as Uint16Array);
    expect(before.some((v) => v !== 0)).toBe(true);
    const version = texture?.version ?? 0;

    // The full bake is spread over frames, each doing a slice of the work.
    steps = 0;
    while (converged === undefined && steps < 100000) {
      runSlice();
      steps += 1;
    }
    expect(steps).toBeGreaterThan(3);
    // One call takes seconds on this scene; a slice that yields at its loop boundaries stays far under that (Node: 41 ms
    // at a 5 ms budget, the page's own long-task log: 56 ms). The bound is loose so a loaded host does not flake it.
    expect(longest).toBeLessThan(250);
    // The bake's own account says the same, so the browser log carries it without a timer outside the page.
    const slices = (
      converged as { slices?: { count: number; longestMs: number; publishMs: number } }
    ).slices;
    expect(slices?.count).toBeGreaterThan(3);
    expect(slices?.longestMs).toBeLessThan(250);
    expect(slices?.publishMs).toBeLessThan(250);
    expect(frames.length).toBe(0);
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

  it("bakes the surfaces the scene authored, whatever the node twins it swapped in say", () => {
    // A progressive bake runs after the cache swapped every material for its node twin. A twin that lost a field (the
    // native engine keeps them as prototype accessors a plain copy misses) must not change the light: before the fix the
    // bake read the twin's colour and sides, and a room of white twins came out 4 times too bright.
    const whole = sunlitRoom();
    installGi(rayContext(whole), whole, { bounces: 3, sun: SUN });
    const wanted = Float32Array.from(giCache.field?.values ?? []);

    const room = sunlitRoom();
    const frames: (() => void)[] = [];
    installGi(rayContext(room), room, {
      bounces: 3,
      sun: SUN,
      progressive: { previewRays: 16, budgetMs: 5, defer: (run) => void frames.push(run) },
    });
    room.traverse((object) => {
      const twin = (object as Mesh).material as MeshStandardMaterial | undefined;
      if (twin === undefined) return;
      twin.color = new Color(1, 1, 1);
      twin.side = DoubleSide;
    });
    let steps = 0;
    while (frames.length > 0 && steps < 100000) {
      frames.shift()?.();
      steps += 1;
    }
    const got = giCache.field?.values ?? new Float32Array(0);
    expect(got.length).toBe(wanted.length);
    expect(got.every((v, i) => v === wanted[i])).toBe(true);
  });

  it("paces itself on the host's tasks by default, and converges to the cache a single bake makes", async () => {
    const whole = sunlitRoom();
    installGi(rayContext(whole), whole, { bounces: 1, sun: SUN });
    const wanted = Float32Array.from(giCache.field?.values ?? []);

    const room = sunlitRoom();
    let converged = false;
    const first = installGi(rayContext(room), room, {
      bounces: 1,
      sun: SUN,
      progressive: {
        previewRays: 16,
        budgetMs: 5,
        onConverged: () => {
          converged = true;
        },
      },
    });
    // Nothing runs inside the call: the first slice waits for a task of the host.
    expect(first?.pass).toBe("pending");
    expect(converged).toBe(false);
    await vi.waitFor(() => expect(converged).toBe(true), { timeout: 120_000, interval: 10 });
    const got = giCache.field?.values ?? new Float32Array(0);
    expect(got.length).toBe(wanted.length);
    expect(got.every((v, i) => v === wanted[i])).toBe(true);
  }, 180_000);

  it("a mapped wall bakes its texel in the progressive bake too, though the cache swapped its material before the rays ran", () => {
    // The Surface Cache (PRD-639) finds a hit's map through the material the scene authored. A progressive bake runs after
    // the cache swapped that material for its node twin, so a lookup by the object's current material finds nothing and
    // the wall bakes its white colour factor: the closed furnace of the one-shot test, three times too bright.
    const furnace = (progressive: boolean) => {
      const material = new MeshStandardMaterial({
        color: new Color(1, 1, 1),
        map: new DataTexture(new Uint8Array([77, 77, 77, 255]), 1, 1),
        emissive: new Color(2, 2, 2),
        side: DoubleSide,
      });
      const room = new Group().add(new Mesh(new BoxGeometry(6, 6, 6).scale(-1, -1, -1), material));
      skyRadiance.current = { data: new Float32Array(6), width: 2, height: 1, scale: [1, 1, 1] };
      const frames: (() => void)[] = [];
      installGi(rayContext(room), room, {
        bounces: 3,
        sun: { color: new Color(0, 0, 0), intensity: 0, direction: new Vector3(0, 1, 0) },
        surfaceCache: true,
        ...(progressive
          ? { progressive: { previewRays: 16, budgetMs: 5, defer: (run) => void frames.push(run) } }
          : {}),
      });
      for (let steps = 0; frames.length > 0 && steps < 100000; steps += 1) frames.shift()?.();
      return Float32Array.from(giCache.field?.values ?? []);
    };
    const wanted = furnace(false);
    // The wall's map is 77 / 255: three passes read 2 (1 - t^3) / (1 - t) = 2.8 where the flat white factor reads 6.
    const brightest = wanted.reduce((most, v) => Math.max(most, v), 0);
    expect(brightest).toBeGreaterThan(2.5);
    expect(brightest).toBeLessThan(3.5);
    const got = furnace(true);
    expect(got.length).toBe(wanted.length);
    expect(got.every((v, i) => v === wanted[i])).toBe(true);
  });

  it("bakes in one call when the rays are the game's own, because slicing needs the flat ones", () => {
    const flatRoom = sunlitRoom();
    installGi(rayContext(flatRoom), flatRoom, { bounces: 1, sun: SUN });
    const flat = Float32Array.from(giCache.field?.values ?? []);

    const room = sunlitRoom();
    const frames: (() => void)[] = [];
    const report = installGi(rayContext(room), room, {
      bounces: 1,
      stockRays: true,
      sun: SUN,
      progressive: { previewRays: 16, budgetMs: 1, defer: (run) => void frames.push(run) },
    });
    expect(report?.pass).toBe("final");
    expect(frames.length).toBe(0);
    // The trace reads the game's answers as vectors and the flat rays' as numbers: the cache is the same, but for a
    // ray that grazes a face, where three's raycaster and the flat test round differently (0.015% of the values).
    const stock = giCache.field?.values ?? new Float32Array(0);
    expect(stock.length).toBe(flat.length);
    let differing = 0;
    let largest = 0;
    for (let i = 0; i < flat.length; i += 1) {
      const gap = Math.abs((stock[i] ?? 0) - (flat[i] ?? 0));
      if (gap > 0) differing += 1;
      largest = Math.max(largest, gap);
    }
    expect(differing).toBeLessThan(flat.length * 0.001);
    expect(largest).toBeLessThan(0.01);
  });

  it("takes two bounces for the provisional bake, which lands nearer the full cache than one bounce does", () => {
    // One bounce leaves out the warm light a lit floor throws on the walls, so the first frame reads dark and cool.
    // Measured on this room at 5 bounces and 32 rays: relative L1 error 0.151 with one bounce, 0.077 with two, 0.070 with five.
    const whole = sunlitRoom();
    installGi(rayContext(whole), whole, { bounces: 5, sun: SUN });
    const wanted = Float32Array.from(giCache.field?.values ?? []);
    const errorOfPreview = (previewBounces?: number): number => {
      const room = sunlitRoom();
      const stale = giCache.field;
      const queue: (() => void)[] = [];
      installGi(rayContext(room), room, {
        bounces: 5,
        sun: SUN,
        progressive: {
          previewRays: 32,
          ...(previewBounces === undefined ? {} : { previewBounces }),
          budgetMs: 8,
          defer: (run) => void queue.push(run),
        },
      });
      for (let steps = 0; giCache.field === stale && steps < 100000; steps += 1) queue.shift()?.();
      expect(giCache.field).not.toBe(stale);
      const got = giCache.field?.values ?? new Float32Array(0);
      let gap = 0;
      let total = 0;
      for (let i = 0; i < wanted.length; i += 1) {
        gap += Math.abs((got[i] ?? 0) - (wanted[i] ?? 0));
        total += Math.abs(wanted[i] ?? 0);
      }
      return gap / total;
    };
    const oneBounce = errorOfPreview(1);
    const byDefault = errorOfPreview();
    expect(byDefault).toBeLessThan(oneBounce * 0.7);
    expect(byDefault).toBeLessThan(0.1);
  }, 120_000);
});
