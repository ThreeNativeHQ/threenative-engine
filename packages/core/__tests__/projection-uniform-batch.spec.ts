import {
  BoxGeometry,
  Color,
  type InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Scene,
  type Texture,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { uniformSignatureOf, uniformUnchanged } from "../src/projection-uniform.js";
import { type ProjectionMaterialChecks, SceneRenderProjection } from "../src/renderProjection.js";

/**
 * PRD-449 R3, PRD-462. A lattice where every cube owns a material that differs from its neighbours
 * only in base colour — L4, and the shape a real game gets for free from cloning a material per
 * object.
 *
 * Before this, each of those materials keyed its own group, so the projection declined the scene as
 * not worth its own cost and 2,375 cubes were drawn one at a time. The claim these rows hold is
 * narrow and load-bearing: **one draw, one per-instance colour, and pixels identical to drawing
 * every material on its own.** The second half is the half an optimizer can silently lose, so every
 * row after the first mutates a *settled* scene and asks what the renderer was handed this frame.
 *
 * PRD-462 added the third half: a member whose material drifts for any reason *other* than colour
 * must still leave the group, and the default does that by proving a bounded slice of the materials
 * a frame rather than all of them. Rows that can tell spread from everyFrame therefore run under
 * both modes, and the bound the report states is asserted rather than assumed.
 */

const GEOMETRY = new BoxGeometry(1, 1, 1);

function tintOf(index: number): number {
  return 0xff0000 | (index & 0x00ffff);
}

/** `count` cubes on one shared geometry, each with its own colour-only material clone. */
function uniformLattice(count: number): { scene: Scene; meshes: Mesh[] } {
  const scene = new Scene();
  const meshes: Mesh[] = [];
  for (let index = 0; index < count; index += 1) {
    const material = new MeshStandardMaterial({ color: 0xb8c4cc, metalness: 0, roughness: 0.75 });
    material.color.setHex(tintOf(index));
    const mesh = new Mesh(GEOMETRY, material);
    mesh.position.set(index % 8, Math.floor(index / 8), 0);
    scene.add(mesh);
    meshes.push(mesh);
  }
  return { scene, meshes };
}

function sharedLattice(count: number): {
  scene: Scene;
  meshes: Mesh[];
  material: MeshStandardMaterial;
} {
  const scene = new Scene();
  const material = new MeshStandardMaterial({ color: 0x3366aa });
  const meshes: Mesh[] = [];
  for (let index = 0; index < count; index += 1) {
    const mesh = new Mesh(GEOMETRY, material);
    mesh.position.set(index % 8, Math.floor(index / 8), 0);
    scene.add(mesh);
    meshes.push(mesh);
  }
  return { scene, meshes, material };
}

function project(
  scene: Scene,
  frames = 2,
  materialChecks?: ProjectionMaterialChecks,
): SceneRenderProjection {
  const projection = new SceneRenderProjection(scene, {
    minMeshes: 8,
    onReport: () => undefined,
    // The game's own config shape, so a row reads like the `threenative.config.ts` it stands for.
    ...(materialChecks === undefined ? {} : { projection: { materialChecks } }),
  });
  for (let frame = 0; frame < frames; frame += 1) projection.reconcile();
  return projection;
}

function onlyBatch(root: Scene): InstancedMesh {
  const found: InstancedMesh[] = [];
  root.traverse((object) => {
    if ((object as InstancedMesh).isInstancedMesh === true) found.push(object as InstancedMesh);
  });
  if (found.length !== 1) throw new Error(`expected one mirror draw, found ${found.length}`);
  return found[0] as InstancedMesh;
}

/** The instance slot holding this source, found through the matrix the mirror actually wrote. */
function slotOf(batch: InstancedMesh, mesh: Mesh): number {
  const baked = new Matrix4();
  for (let slot = 0; slot < batch.count; slot += 1) {
    batch.getMatrixAt(slot, baked);
    if (baked.equals(mesh.matrixWorld)) return slot;
  }
  throw new Error("the mirror holds no instance for this source");
}

function drawnColor(batch: InstancedMesh, mesh: Mesh): number[] {
  const color = new Color();
  batch.getColorAt(slotOf(batch, mesh), color);
  return [color.r, color.g, color.b];
}

function sourceColor(mesh: Mesh): number[] {
  const color = (mesh.material as MeshStandardMaterial).color;
  return [color.r, color.g, color.b];
}

/**
 * The instance colour is a float32 buffer, so it is the source colour to single precision — the
 * precision every instanced attribute in three is stored at, and the precision the GPU reads.
 */
function expectDrawnColor(batch: InstancedMesh, mesh: Mesh): void {
  const drawn = drawnColor(batch, mesh);
  const source = sourceColor(mesh);
  drawn.forEach((value, index) => {
    expect(value).toBeCloseTo(source[index] as number, 6);
  });
}

describe("uniform-colour instanced batches", () => {
  it("signs a material whose field reads undefined, as an engine material does for an unset slot", () => {
    const material = new MeshStandardMaterial({ color: 0xb8c4cc });
    (material as unknown as Record<string, unknown>).unsetSlot = undefined;
    expect(typeof uniformSignatureOf(material)).toBe("string");
  });

  it("draws materials that differ only in colour as one instanced draw with per-instance colour", () => {
    const { scene, meshes } = uniformLattice(64);

    const projection = project(scene);

    expect(projection.deoptimized).toBe(false);
    expect(projection.report.batches).toBe(1);
    expect(projection.report.projectedObjects).toBe(64);
    expect(projection.report.resultDrawCandidates).toBe(1);

    const batch = onlyBatch(projection.root);
    // The draw carries a material the mirror owns, so nothing the game does to its own instance can
    // reach the draw by accident — and never the game's instance, which 64 cubes still hold.
    expect(meshes.some((mesh) => mesh.material === batch.material)).toBe(false);
    expect((batch.material as MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    // Every instance is coloured from its own source material, to the precision the buffer holds.
    for (const mesh of meshes) {
      expectDrawnColor(batch, mesh);
    }
  });

  it("writes a recoloured material into that one instance and rebuilds no draw", () => {
    const { scene, meshes } = uniformLattice(64);
    const projection = project(scene, 3);
    const batch = onlyBatch(projection.root);
    const before = meshes.map((mesh) => drawnColor(batch, mesh));
    const changed = meshes[5] as Mesh;

    (changed.material as MeshStandardMaterial).color.setHex(0x00ff00);
    projection.reconcile();

    // The same draw object: a colour is a three-float write, never a reclassification.
    expect(onlyBatch(projection.root)).toBe(batch);
    expect(projection.report.batches).toBe(1);
    expect(projection.inspect(changed)?.lane).toBe("batched");
    expectDrawnColor(batch, changed);
    const after = meshes.map((mesh) => drawnColor(batch, mesh));
    after.forEach((color, index) => {
      if (index === 5) return;
      expect(color).toEqual(before[index]);
    });
  });

  it("leaves the shared-material lane exactly as it was", () => {
    const { scene, material } = sharedLattice(64);

    const projection = project(scene);

    const batch = onlyBatch(projection.root);
    // The game's own instance, so recolouring it recolours the draw, and no per-instance colour at
    // all: there is nothing per-instance to carry.
    expect(batch.material).toBe(material);
    expect(batch.instanceColor).toBeNull();
    expect(projection.drawsWith(material)).toBe(true);
    expect(projection.report.projectedObjects).toBe(64);
    // One material and one draw, so there is nothing for the sweep to spread over: the bound the
    // report states is zero rather than a number a game has to reason about.
    expect(projection.report.materialCheckStaleFrames).toBe(0);
  });

  /**
   * The rows that must hold under both modes, since the mode is the only thing that differs between
   * them: what is proved, how a member that fails the proof is treated, and what a steady frame
   * costs. Run under `everyFrame` they are the check exactly as it shipped; run under `spread`
   * (the default) they are the check as it ships now.
   */
  for (const mode of ["spread", "everyFrame"] as const) {
    describe(`materialChecks: "${mode}"`, () => {
      it("reflects a colour edit in the same frame it happens", () => {
        const { scene, meshes } = uniformLattice(64);
        const projection = project(scene, 3, mode);
        const batch = onlyBatch(projection.root);

        (meshes[40] as Mesh & { material: MeshStandardMaterial }).material.color.setHex(0x00ff00);
        projection.reconcile();

        // Colour is never in the sweep: it is O(1) per member and always exact, so the staleness
        // bound is about materials that leave the group, not about the one that cannot.
        expect(projection.inspect(meshes[40] as Mesh)?.lane).toBe("batched");
        expectDrawnColor(batch, meshes[40] as Mesh);
      });

      it.each([
        [
          "roughness",
          (material: MeshStandardMaterial) => {
            material.roughness = 0.05;
          },
        ],
        [
          "a texture",
          (material: MeshStandardMaterial) => {
            material.map = {} as Texture;
          },
        ],
        [
          "opacity",
          (material: MeshStandardMaterial) => {
            material.opacity = 0.5;
          },
        ],
        // A `Color` and a `Vector2` are mutated in place rather than swapped, so they are read
        // field by field instead of by identity. Both are read by name, which is the fast path; a
        // field neither knows falls back to reading whatever names were recorded.
        [
          "an emissive colour in place",
          (material: MeshStandardMaterial) => {
            material.emissive.setHex(0x00ff00);
          },
        ],
        [
          "a normal scale in place",
          (material: MeshStandardMaterial) => {
            material.normalScale.set(0.25, 0.75);
          },
        ],
        [
          "an environment rotation in place",
          (material: MeshStandardMaterial) => {
            material.envMapRotation.z = 0.5;
          },
        ],
        [
          "a numeric field turned into a string",
          (material: MeshStandardMaterial) => {
            (material.normalScale as unknown as { x: unknown }).x = "0.5";
          },
        ],
      ])("ejects a member whose material gained %s after it was batched", (_label, mutate) => {
        const { scene, meshes } = uniformLattice(64);
        const projection = project(scene, 3, mode);
        const changed = meshes[5] as Mesh;
        const other = meshes[6] as Mesh;

        mutate(changed.material as MeshStandardMaterial);
        projection.reconcile();

        // Exactly — never a draw with a stale roughness, a missing map or a stale alpha.
        expect(projection.inspect(changed)?.lane).toBe("exact");
        expect(projection.inspect(other)?.lane).toBe("batched");
        expect(projection.report.projectedObjects).toBe(63);
        // And the classification that put it there is re-derived, so the next frame agrees with it.
        projection.reconcile();
        expect(projection.inspect(changed)?.lane).toBe("exact");
        expect(projection.report.projectedObjects).toBe(63);
      });

      it("ejects a member whose material turned transparent", () => {
        const { scene, meshes } = uniformLattice(64);
        const projection = project(scene, 3, mode);
        const changed = meshes[5] as Mesh;

        (changed.material as MeshStandardMaterial).transparent = true;
        projection.reconcile();

        expect(projection.inspect(changed)?.lane).toBe("exact");
        expect(projection.report.exact.transparent).toBe(1);
        expect(projection.report.projectedObjects).toBe(63);
      });

      it("reclassifies a member whose material was swapped for another", () => {
        const { scene, meshes } = uniformLattice(64);
        const projection = project(scene, 3, mode);
        const changed = meshes[5] as Mesh;
        const batch = onlyBatch(projection.root);
        const replacement = new MeshStandardMaterial({
          color: 0xb8c4cc,
          metalness: 0,
          roughness: 0.75,
        });
        replacement.color.setHex(0x0000ff);

        // Another colour-only material: same group, and the instance takes the new colour. A swap is
        // a changed material *identity*, which the structure proof compares every frame — the sweep
        // bounds drift, never a swap.
        changed.material = replacement;
        projection.reconcile();
        expect(projection.inspect(changed)?.lane).toBe("batched");
        expectDrawnColor(batch, changed);

        // One that is not colour-only: it leaves the group entirely rather than draw with the clone.
        const rough = new MeshStandardMaterial({ color: 0xb8c4cc, metalness: 0, roughness: 0.05 });
        changed.material = rough;
        projection.reconcile();
        projection.reconcile();
        expect(projection.inspect(changed)?.lane).toBe("exact");
        expect(projection.report.projectedObjects).toBe(63);
      });

      it("costs no collection on a steady 4,096-material frame", () => {
        const { scene } = uniformLattice(4096);
        const projection = project(scene, 2, mode);
        expect(projection.report.batches).toBe(1);

        const originalMap = globalThis.Map;
        const originalSet = globalThis.Set;
        let collections = 0;
        class CountingMap<K, V> extends originalMap<K, V> {
          constructor(entries?: Iterable<readonly [K, V]> | null) {
            super(entries);
            collections += 1;
          }
        }
        class CountingSet<T> extends originalSet<T> {
          constructor(values?: Iterable<T> | null) {
            super(values);
            collections += 1;
          }
        }
        globalThis.Map = CountingMap;
        globalThis.Set = CountingSet;
        let elapsed = 0;
        try {
          for (let frame = 0; frame < 30; frame += 1) {
            const startedAt = performance.now();
            projection.reconcile();
            elapsed += performance.now() - startedAt;
          }
        } finally {
          globalThis.Map = originalMap;
          globalThis.Set = originalSet;
        }

        // A steady frame re-compares and re-colours; it never re-derives the classification, which is
        // what would rebuild 4,096 signatures and allocate a string for each. The sweep's own two
        // sets are built once with the mirror, so a frame allocates nothing at all.
        expect(collections).toBe(0);
        expect(projection.report.resultDrawCandidates).toBe(1);
        // ponytail: a per-frame budget assertion would be a machine-specific threshold; the honest
        // number is the measured reconcile time, which this row and the benchmark arm both report.
        process.stdout.write(
          `\nuniform reconcile mean over 30 frames (${mode}): ${(elapsed / 30).toFixed(3)} ms\n`,
        );
      });
    });
  }

  it("times the per-material drift check itself on a settled 4,096-material frame", () => {
    const { scene, meshes } = uniformLattice(4096);
    // Two frames settle the classification; the check only has a record to compare against once
    // one exists, so the first of them is where `uniformSignatureOf` runs.
    const projection = project(scene, 2);
    expect(projection.report.batches).toBe(1);
    const materials = meshes.map((mesh) => mesh.material as Material);

    let unchanged = 0;
    for (let round = 0; round < 5; round += 1) {
      for (const material of materials) if (uniformUnchanged(material)) unchanged += 1;
    }
    const frames = 30;
    const startedAt = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      for (const material of materials) if (uniformUnchanged(material)) unchanged += 1;
    }
    const elapsed = performance.now() - startedAt;

    // A settled frame's whole job is to prove nothing moved, so every material must come back
    // unchanged — the timing above is a report, never a threshold a slower machine can fail.
    expect(unchanged).toBe((frames + 5) * materials.length);
    process.stdout.write(
      `\nuniform drift check: ${((elapsed * 1000) / frames / materials.length).toFixed(
        3,
      )} us per material\n`,
    );
  });

  /**
   * The default, the bound it accepts, and the line that says so.
   *
   * These are the rows a game reads: a default it did not choose, a bound it can compute against,
   * and a marker line that names both — the difference between a bounded check and a hidden one.
   */
  describe("the material check as a shipped convention", () => {
    it("spreads the check by default and states the bound it accepts", () => {
      const { scene } = uniformLattice(4096);
      const projection = project(scene, 3);

      const report = projection.report;
      expect(report.materialChecks).toBe("spread");
      expect(report.materialChecksPerFrame).toBe(512);
      // 4,096 members at 512 a frame is eight frames for one to be proved, and that is the number
      // reported rather than a promise in a comment.
      expect(report.materialCheckStaleFrames).toBe(8);
      expect(report.materialChecksOverridden).toBe(false);
    });

    it("reports the mode, the budget and the bound on the TN_RENDER_PROJECTION line", () => {
      const { scene } = uniformLattice(4096);
      const lines: string[] = [];
      const info = vi
        .spyOn(console, "info")
        .mockImplementation((line?: unknown) => void lines.push(String(line)));
      try {
        // No `onReport`: the engine prints the verdict itself, which is the line a game reads.
        const projection = new SceneRenderProjection(scene, { minMeshes: 8 });
        projection.reconcile();
      } finally {
        info.mockRestore();
      }

      const verdict = lines.find((line) => line.startsWith("TN_RENDER_PROJECTION:"));
      expect(verdict).toBeDefined();
      const payload = JSON.parse((verdict as string).slice("TN_RENDER_PROJECTION:".length)) as {
        materialChecks: string;
        materialChecksPerFrame: number;
        materialCheckStaleFrames: number;
        materialChecksOverridden?: boolean;
      };
      expect(payload.materialChecks).toBe("spread");
      expect(payload.materialChecksPerFrame).toBe(512);
      expect(payload.materialCheckStaleFrames).toBe(8);
      // Absent rather than false: a defaulted convention is not an override, and a key that reads
      // `false` is one a reader has to learn to ignore.
      expect(payload.materialChecksOverridden).toBeUndefined();
    });

    it("says the author overrode it, and reports no bound, under everyFrame", () => {
      const { scene } = uniformLattice(4096);
      const projection = project(scene, 3, "everyFrame");

      expect(projection.report.materialChecks).toBe("everyFrame");
      expect(projection.report.materialChecksPerFrame).toBe(0);
      expect(projection.report.materialChecksOverridden).toBe(true);
    });

    it("ejects a drifted member within the bound it reports, and drops nothing", () => {
      // 1,024 members at a 512-a-frame budget is two frames for one to be proved: the last member
      // is the worst case by construction, and the edit is a roughness a frame cannot draw around.
      const { scene, meshes } = uniformLattice(1024);
      const projection = project(scene, 2);
      const bound = projection.report.materialCheckStaleFrames;
      expect(bound).toBe(2);
      const changed = meshes[1023] as Mesh;

      (changed.material as MeshStandardMaterial).roughness = 0.05;
      projection.reconcile();
      // The first frame's slice does not reach this member yet, and the frame is still honest: it
      // draws with the shared clone, which still holds the roughness this material was classified
      // with. What must never happen is the edit being dropped and never caught.
      expect(projection.inspect(changed)?.lane).toBe("batched");

      projection.reconcile();
      expect(projection.inspect(changed)?.lane).toBe("exact");
      expect(projection.report.exact.materialChanged).toBe(1);
      expect(projection.report.projectedObjects).toBe(1023);
      // And the classification that put it there is re-derived, so the next frame agrees.
      projection.reconcile();
      expect(projection.inspect(changed)?.lane).toBe("exact");
      expect((changed.material as MeshStandardMaterial).roughness).toBe(0.05);
    });

    it("ejects every member sharing a drifted material in the frame it is found", () => {
      // A uniform group is reached only by materials whose own group is under the floor, so a
      // material here can have a few members: three cubes on one material, five on their own, one
      // draw. The sweep proves that material once, and every member holding it must leave — the
      // first one alone would leave two drawing with a roughness that is not their own.
      const scene = new Scene();
      const shared = new MeshStandardMaterial({ color: 0xb8c4cc, metalness: 0, roughness: 0.75 });
      const twins: Mesh[] = [];
      for (let index = 0; index < 3; index += 1) {
        const mesh = new Mesh(GEOMETRY, shared);
        mesh.position.set(index, 0, 0);
        scene.add(mesh);
        twins.push(mesh);
      }
      for (let index = 0; index < 5; index += 1) {
        const material = new MeshStandardMaterial({
          color: 0xb8c4cc,
          metalness: 0,
          roughness: 0.75,
        });
        material.color.setHex(0x00ff00 + index);
        const mesh = new Mesh(GEOMETRY, material);
        mesh.position.set(index, 1, 0);
        scene.add(mesh);
      }
      const projection = project(scene, 2);
      expect(projection.report.batches).toBe(1);
      expect(projection.report.projectedObjects).toBe(8);

      shared.roughness = 0.05;
      projection.reconcile();

      expect(twins.every((mesh) => projection.inspect(mesh)?.lane === "exact")).toBe(true);
      expect(projection.report.projectedObjects).toBe(5);
    });

    it("throws on a material-check mode it does not have", () => {
      const { scene } = uniformLattice(64);
      // Fail closed: a typo in a config value is a named error at startup, not a default the game
      // never asked for and cannot see.
      expect(
        () =>
          new SceneRenderProjection(scene, {
            minMeshes: 8,
            projection: { materialChecks: "everyframe" as ProjectionMaterialChecks },
          }),
      ).toThrow(/materialChecks must be "spread" or "everyFrame", received "everyframe"/u);
    });
  });
});
