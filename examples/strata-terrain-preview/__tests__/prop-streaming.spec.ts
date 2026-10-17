import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAssetLoader } from "@threenative/core";
import { WorldCells } from "@threenative/core/world";
import type { IPlacement } from "@threenative/terrain";
import {
  Box3,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from "three";
import { expect, it, vi } from "vitest";
import {
  type IPropPreparationProgress,
  createStreamedProps,
  invalidatePropShadows,
} from "../src/render/propStreaming.js";
import {
  DRAW_REACH,
  LOD_BANDS,
  buildPropVariants,
  preparePose,
  variantFor,
} from "../src/render/props.js";

it("reports an outstanding world load before the factory returns or attaches it", async () => {
  const placement = {
    id: "spruce:pending",
    asset: "spruce",
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  } as IPlacement;
  const material = new MeshBasicMaterial();
  const geometry = new BoxGeometry();
  const assets = createAssetLoader();
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  let entered: () => void = () => undefined;
  const resolving = new Promise<void>((done) => {
    entered = done;
  });
  vi.spyOn(assets, "resolve").mockImplementation(async () => {
    entered();
    await blocked;
    return [];
  });
  let progress: IPropPreparationProgress | undefined;
  const work = createStreamedProps({
    placements: [placement],
    parts: new Map([
      [
        `spruce:${variantFor(placement, "spruce")}`,
        [{ geometry, material, role: "bark", variant: 0 }],
      ],
    ]),
    materials: { bark: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow: { position: new Vector3() },
    size: 512,
    assets,
    whileCurrent: () => true,
    onProgress: (value) => {
      progress = value;
    },
  });
  let settled = false;
  void work.then(() => {
    settled = true;
  });
  await resolving;
  let streamed: Awaited<typeof work>;
  try {
    expect(progress?.phase).toBe("world-load");
    expect(progress?.bucket).toBe("horizon:true");
    expect(progress?.worlds).toHaveLength(0);
    expect(settled).toBe(false);
    release();
    streamed = await work;
    expect(progress?.phase).toBe("complete");
    expect(progress?.worlds).toEqual(streamed?.worlds);
    expect(streamed?.worlds[0]?.parent).toBeNull();
    expect(streamed?.worlds[0]?.released).toBe(false);
    expect(progress?.prewarmedWorlds).toBe(0);
    expect(settled).toBe(true);
  } finally {
    release();
    streamed ??= await work;
    streamed?.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it("streams Strata's exact grounded transforms, seeded cover density and original placement count", async () => {
  const placements = Array.from({ length: 60 }, (_, i) => ({
    id: `grass:${i}`,
    asset: "grass",
    position: [i * 20 - 600, 0, 0],
    rotation: 0.3,
    scale: 2,
    normal: [0.1, 0.99, 0],
    alignToNormal: true,
  })) as IPlacement[];
  const material = new MeshBasicMaterial();
  const parts = new Map(
    placements.map((p) => [
      `grass:${variantFor(p, "grass")}`,
      [{ geometry: new BoxGeometry(1, 2, 1), material, role: "grass" as const, variant: 0 }],
    ]),
  );
  const ground = () => ({ height: 4, offset: 0 });
  const materials = { grass: material } as never;
  const follow = { position: new Vector3(-480, 5, 0) };
  const streamed = await createStreamedProps({
    placements,
    groundAt: ground,
    parts,
    materials,
    follow,
    size: 512,
    whileCurrent: () => true,
  });
  expect(streamed?.worlds[0]).toBeInstanceOf(WorldCells);
  if (!streamed) throw new Error("cancelled");
  try {
    for (const world of streamed.worlds) world.update();
    expect(streamed.stats().loadedCells).toBe(0);
    expect(streamed.stats().residentCells).toBeGreaterThan(0);
    expect(streamed.byId.size).toBe(placements.length);
    for (const placement of placements) {
      const foot = parts.get(`grass:${variantFor(placement, "grass")}`)?.[0];
      assert(foot);
      expect(streamed.byId.get(placement.id)?.pose.elements).toEqual(
        preparePose(foot.geometry, material, placement, placement.transform, ground).matrix
          .elements,
      );
    }
    for (const x of [-480, 480, -480]) {
      follow.position.x = x;
      for (let frame = 0; frame < 150; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(
        placements.filter((placement, index) => {
          const variantIndex = placements
            .slice(0, index)
            .filter(
              (prior) => variantFor(prior, "grass") === variantFor(placement, "grass"),
            ).length;
          const seed = (Math.imul(variantIndex + 1, 2654435761) >>> 0) / 4294967296;
          const reach = 28 + ((DRAW_REACH.grass ?? 0) - 28) * (1 - Math.sqrt(seed));
          const instance = streamed.byId.get(placement.id);
          assert(instance);
          const pose = instance.pose;
          return new Vector3().setFromMatrixPosition(pose).distanceTo(follow.position) <= reach;
        }).length,
      );
    }
    expect(streamed.stats().evictions).toBeGreaterThan(0);
    expect(streamed.stats().failures).toBe(0);
  } finally {
    streamed.dispose();
  }
  expect(streamed.worlds.every((world) => world.released)).toBe(true);
});
it("cancels a stale scene before querying ground or attaching a stream", async () => {
  let calls = 0;
  const result = await createStreamedProps({
    placements: [] as IPlacement[],
    groundAt: () => {
      calls++;
      return { height: 0, offset: 0 };
    },
    parts: new Map(),
    materials: {} as never,
    follow: { position: new Vector3() },
    size: 512,
    whileCurrent: () => false,
  });
  expect(result).toBeUndefined();
  expect(calls).toBe(0);
});
it("stops stale-scene work during post-grounding package compilation", async () => {
  const placements = [0, 1].map((i) => ({
    id: `grass:${i}`,
    asset: "grass",
    position: [i, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  })) as IPlacement[];
  const material = new MeshBasicMaterial();
  const parts = new Map(
    placements.map((p) => [
      `grass:${variantFor(p, "grass")}`,
      [{ geometry: new BoxGeometry(), role: "grass" as const, material, variant: 0 }],
    ]),
  );
  let groundCalls = 0;
  let postChecks = 0;
  const result = await createStreamedProps({
    placements,
    parts,
    materials: { grass: material } as never,
    follow: { position: new Vector3() },
    size: 512,
    groundAt: () => {
      groundCalls++;
      return { height: 0, offset: 0 };
    },
    whileCurrent: () => groundCalls < 2 || ++postChecks < 3,
  });
  result?.dispose();
  expect(groundCalls).toBe(2);
  expect(result).toBeUndefined();
});

it("retains every unlimited canopy placement and keeps prewarm pending until scene attachment", async () => {
  const placements = Array.from({ length: 12 }, (_, i) => ({
    id: `spruce:${i}`,
    asset: "spruce",
    position: [i * 64 - 352, 0, 0],
    rotation: 0.2,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  })) as IPlacement[];
  const material = new MeshBasicMaterial();
  const geometry = new BoxGeometry(1, 3, 1);
  const parts = new Map(
    placements.map((p) => [
      `spruce:${variantFor(p, "spruce")}`,
      [{ geometry, material, role: "bark" as const, variant: 0 }],
    ]),
  );
  const follow = { position: new Vector3(0, 10, 0) };
  let preparation: IPropPreparationProgress | undefined;
  const streamed = await createStreamedProps({
    placements,
    parts,
    materials: { bark: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow,
    size: 1024,
    horizonDistance: 5000,
    whileCurrent: () => true,
    onProgress: (value) => {
      preparation = value;
    },
  });
  if (!streamed) throw new Error("cancelled");
  let ready = false;
  void Promise.all([
    ...streamed.worlds.map((world) => world.whenSpawnReady({ x: 0, z: 0 }, 60)),
    ...streamed.worlds.map((world) => world.prewarmed),
  ]).then(
    () => {
      ready = true;
    },
    () => undefined,
  );
  try {
    expect(ready).toBe(false);
    expect(preparation?.prewarmedWorlds).toBe(0);
    for (let frame = 0; frame < 200; frame++) {
      for (const world of streamed.worlds) world.update();
      await Promise.resolve();
    }
    expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(placements.length);
    expect(ready).toBe(false);
    expect(streamed.stats().pendingPrewarm).toBeGreaterThan(0);
    new Group().add(...streamed.worlds);
    for (let frame = 0; frame < 200 && !ready; frame++) {
      for (const world of streamed.worlds) {
        world.update();
        world.traverse((node) => {
          if (node instanceof InstancedMesh && node.visible)
            (node.onBeforeRender as (...args: unknown[]) => void)(
              node,
              null,
              null,
              null,
              null,
              null,
            );
        });
      }
      await Promise.resolve();
    }
    expect(ready).toBe(true);
    expect(streamed.stats().loadedCells).toBe(streamed.stats().residentCells);
    expect(streamed.stats()).toMatchObject({
      loadsInFlight: 0,
      loadsQueued: 0,
      admissionBacklog: 0,
    });
    expect(preparation?.prewarmedWorlds).toBe(streamed.worlds.length);
    expect(streamed.stats().pendingPrewarm).toBe(0);
    for (const x of [4000, 0]) {
      follow.position.x = x;
      for (let frame = 0; frame < 200; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(placements.length);
    }
    expect(streamed.stats().failures).toBe(0);
  } finally {
    streamed.dispose();
  }
  expect(streamed.byId.size).toBe(0);
  expect(streamed.worlds.every((world) => world.released)).toBe(true);
});

it("preserves authored LOD return hysteresis through an oscillating boundary walk and eviction/revisit", async () => {
  const placement = {
    id: "boulder:boundary",
    asset: "boulder",
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  } as IPlacement;
  const material = new MeshBasicMaterial();
  const levels = [0, 1, 2].map((level) => ({
    geometry: new BoxGeometry(level + 1, 3, 1),
    material,
    role: "bark" as const,
    variant: 0,
    level,
  }));
  const parts = new Map([[`boulder:${variantFor(placement, "boulder")}`, levels]]);
  const materials = { bark: material } as never;
  const follow = { position: new Vector3() };
  const streamed = await createStreamedProps({
    placements: [placement],
    parts,
    materials,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow,
    size: 512,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error("cancelled");
  const active = (meshes: InstancedMesh[]) =>
    meshes
      .filter((mesh) => mesh.count > 0)
      .map((mesh) => Array.from(mesh.geometry.getAttribute("position").array));
  try {
    for (const [distance, level] of [
      [0, 0],
      [65, 1],
      [500, null],
      [55, 1],
      [61, 1],
      [59, 1],
      [61, 1],
      [59, 1],
      [47, 0],
      [155, 2],
      [140, 2],
      [151, 2],
      [149, 2],
      [119, 1],
      [47, 0],
    ] as const) {
      follow.position.x = distance;
      for (let frame = 0; frame < 100; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      const chosen = level === null ? undefined : levels[level];
      if (level !== null) assert(chosen);
      expect(active(streamed.meshes), `distance ${distance}`).toEqual(
        chosen ? [Array.from(chosen.geometry.getAttribute("position").array)] : [],
      );
    }
  } finally {
    streamed.dispose();
  }
});

it("writes the original rendered matrices and materials for multi-part nonuniform and mirrored canopy", async () => {
  const bark = new MeshBasicMaterial({ color: 0x553311 });
  const crown = new MeshBasicMaterial({
    color: 0x337733,
    transparent: true,
    opacity: 0.7,
    alphaTest: 0.2,
  });
  const trunk = new BoxGeometry(1, 3, 1);
  trunk.setDrawRange(3, 12);
  const leaves = new BoxGeometry(3, 2, 3);
  leaves.translate(0, 3, 0);
  leaves.setDrawRange(6, 18);
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4).toArray();
  const placements = [
    [2, 3, 4],
    [-2, 3, 4],
  ].map((scale, i) => ({
    id: `spruce:transform:${i}`,
    layer: "canopy",
    asset: "spruce",
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
    transform: { position: [i * 20, 7, 0], quaternion: rotation, scale, grounding: false },
  })) as IPlacement[];
  const parts = new Map(
    placements.map((p) => [
      `spruce:${variantFor(p, "spruce")}`,
      [
        { geometry: trunk, material: bark, role: "bark" as const, variant: 0 },
        { geometry: leaves, material: crown, role: "crown" as const, variant: 0 },
      ],
    ]),
  );
  const materials = { bark, crown } as never;
  const streamed = await createStreamedProps({
    placements,
    parts,
    materials,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow: { position: new Vector3(0, 7, 0) },
    size: 512,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error("cancelled");
  function draws(meshes: InstancedMesh[], material: MeshBasicMaterial) {
    const matrices: number[][] = [];
    for (const mesh of meshes)
      if (mesh.material === material) {
        expect(mesh.geometry.drawRange).toEqual((material === bark ? trunk : leaves).drawRange);
        for (let i = 0; i < mesh.count; i++) {
          const matrix = new Matrix4();
          mesh.getMatrixAt(i, matrix);
          matrices.push(matrix.elements);
        }
      }
    return matrices.sort((a, b) => (a[12] as number) - (b[12] as number));
  }
  try {
    for (let frame = 0; frame < 200; frame++) {
      for (const world of streamed.worlds) world.update();
      await Promise.resolve();
    }
    for (const material of [bark, crown]) {
      const before = placements.map((placement) => {
        assert(placement.transform);
        return new Matrix4().compose(
          new Vector3().fromArray(placement.transform.position),
          new Quaternion().fromArray(placement.transform.quaternion),
          new Vector3().fromArray(placement.transform.scale),
        ).elements;
      });
      const after = draws(streamed.meshes, material);
      expect(after).toHaveLength(placements.length);
      for (let i = 0; i < before.length; i++)
        for (let j = 0; j < 16; j++)
          expect(after.at(i)?.[j]).toBeCloseTo(before.at(i)?.[j] as number, 5);
    }
  } finally {
    streamed.dispose();
  }
});

it("drains representative multi-part canopy cell admission without thousands of serial jobs", async () => {
  const placements = Array.from({ length: 625 }, (_, i) => ({
    id: `spruce:dense:${i}`,
    layer: "canopy",
    asset: "spruce",
    position: [(i % 25) * 16 - 192, 0, Math.floor(i / 25) * 16 - 192],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  })) as IPlacement[];
  const material = new MeshBasicMaterial();
  const parts = new Map(
    placements.map((p) => [
      `spruce:${variantFor(p, "spruce")}`,
      [0, 1, 2].flatMap((level) =>
        ["bark", "crown"].map((role) => ({
          geometry: new BoxGeometry(1, 3, 1),
          material,
          role: role as "bark" | "crown",
          variant: 0,
          level,
        })),
      ),
    ]),
  );
  const streamed = await createStreamedProps({
    placements,
    parts,
    materials: { bark: material, crown: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow: { position: new Vector3() },
    size: 512,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error("cancelled");
  try {
    for (let frame = 0; frame < 128; frame++) {
      for (const world of streamed.worlds) world.update();
      await Promise.resolve();
    }
    expect(streamed.stats().admissionBacklog).toBe(0);
    expect(streamed.stats().failures).toBe(0);
    expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(placements.length * 2);
  } finally {
    streamed.dispose();
  }
});

it("preserves authored cutout LOD parts and distinct custom shader surfaces", async () => {
  const { MeshPhysicalNodeMaterial } = await import("three/webgpu");
  const { float } = await import("three/tsl");
  const materials = [0.2, 0.8, 0.5].map((opacity) => {
    const material = new MeshPhysicalNodeMaterial({ alphaTest: 0.4 });
    material.opacityNode = float(opacity);
    return material;
  });
  const placements = [
    {
      id: "spruce:authored",
      asset: "spruce",
      position: [0, 0, 0],
      rotation: 0,
      scale: 1,
      normal: [0, 1, 0],
      alignToNormal: false,
    },
  ] as IPlacement[];
  const parts = new Map([
    [
      `spruce:${variantFor(placements[0] as (typeof placements)[number], "spruce")}`,
      [
        {
          geometry: new BoxGeometry(1, 2, 1),
          material: materials[0],
          role: "bark" as const,
          variant: 0,
          level: 0,
        },
        {
          geometry: new BoxGeometry(2, 2, 2),
          material: materials[1],
          role: "crown" as const,
          variant: 0,
          level: 0,
        },
        {
          geometry: new BoxGeometry(3, 2, 3),
          material: materials[2],
          role: "bark" as const,
          variant: 0,
          level: 1,
        },
      ],
    ],
  ]);
  const follow = { position: new Vector3(0, 1, 0) };
  const streamed = await createStreamedProps({
    placements,
    parts,
    materials: {} as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow,
    size: 512,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error("cancelled");
  new Group().add(...streamed.worlds);
  try {
    for (const z of [0, 80, 0]) {
      follow.position.z = z;
      for (let i = 0; i < 200; i++) {
        for (const w of streamed.worlds) {
          w.update();
          w.traverse((node) => {
            if (node instanceof InstancedMesh && node.count > 0)
              (node.onBeforeRender as (...args: unknown[]) => void)(
                node,
                null,
                null,
                null,
                null,
                null,
              );
          });
        }
        await Promise.resolve();
      }
      const active = (meshes: InstancedMesh[]) =>
        meshes
          .filter((m) => m.count > 0)
          .map((m) => ({
            material: (m.material as MeshBasicMaterial).uuid,
            geometry: m.geometry.getAttribute("position").array.toString(),
            count: m.count,
          }));
      const expected = (parts.values().next().value ?? [])
        .filter((part) => part.level === (z > LOD_BANDS.mid ? 1 : 0))
        .map((part) => ({
          material: part.material?.uuid,
          geometry: part.geometry.getAttribute("position").array.toString(),
          count: placements.length,
        }));
      expect(active(streamed.meshes)).toEqual(expected);
      for (const layer of [28, 27]) {
        const casters: InstancedMesh[] = [];
        for (const world of streamed.worlds)
          world.traverse((node) => {
            if (node instanceof InstancedMesh && node.layers.isEnabled(layer)) casters.push(node);
          });
        expect(active(casters)).toEqual(expected);
      }
    }
  } finally {
    streamed.dispose();
  }
});

it("keeps streamed caster changes regional and reserves global invalidation for an absent region", async () => {
  let clock = 0;
  const timer = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const shadow = { invalidateRegion: vi.fn(), invalidateAll: vi.fn() };
  const placement = {
    id: "spruce:regional",
    asset: "spruce",
    position: [0, 0, 0],
    rotation: Math.PI / 2,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  } as IPlacement;
  const material = new MeshBasicMaterial();
  const parts = new Map([
    [
      `spruce:${variantFor(placement, "spruce")}`,
      [0, 1].map((level) => ({
        geometry: new BoxGeometry(20, 3, 1).translate(4, 0, 2),
        material,
        role: "bark" as const,
        variant: 0,
        level,
      })),
    ],
  ]);
  const follow = { position: new Vector3(0, 1, 0) };
  const streamed = await createStreamedProps({
    placements: [placement],
    parts,
    materials: { bark: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow,
    size: 512,
    whileCurrent: () => true,
    invalidateShadows: (region) => invalidatePropShadows(shadow, region),
  });
  if (!streamed) throw new Error("cancelled");
  try {
    for (const z of [0, 80, 0]) {
      clock += 1100;
      follow.position.z = z;
      for (let i = 0; i < 200; i++) {
        for (const w of streamed.worlds) w.update();
        await Promise.resolve();
      }
      if (z === 0 && clock === 1100) {
        shadow.invalidateAll.mockClear();
        shadow.invalidateRegion.mockClear();
      }
    }
    expect(shadow.invalidateRegion.mock.calls.length).toBeGreaterThan(0);
    const part = parts.values().next().value?.[0];
    if (part === undefined) throw new Error("Expected placement geometry");
    const geometry = part.geometry;
    geometry.computeBoundingBox();
    const instance = streamed.byId.get(placement.id);
    if (geometry.boundingBox === null || instance === undefined)
      throw new Error("Expected instance bounds");
    const actual = geometry.boundingBox.clone().applyMatrix4(instance.pose);
    for (const [bounds] of shadow.invalidateRegion.mock.calls) {
      const reported = new Box3(
        new Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
        new Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
      );
      // The public package encodes pose/quaternion in Float32; compare at that encoding precision.
      for (const axis of ["x", "y", "z"] as const) {
        expect(reported.min[axis]).toBeLessThanOrEqual(actual.min[axis] + 1e-5);
        expect(reported.max[axis]).toBeGreaterThanOrEqual(actual.max[axis] - 1e-5);
      }
      expect(bounds.max.y - bounds.min.y).toBeGreaterThan(0);
    }
    expect(shadow.invalidateAll).not.toHaveBeenCalled();
    invalidatePropShadows(shadow);
    expect(shadow.invalidateAll).toHaveBeenCalledTimes(1);
  } finally {
    streamed.dispose();
    timer.mockRestore();
  }
});

it("settles an editor stream without caster layers when no shadow renderer exists", async () => {
  const placement = {
    id: "spruce:editor",
    asset: "spruce",
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  } as IPlacement;
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  const streamed = await createStreamedProps({
    placements: [placement],
    parts: new Map([
      [
        `spruce:${variantFor(placement, "spruce")}`,
        [{ geometry, material, role: "bark", variant: 0 }],
      ],
    ]),
    materials: { bark: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow: { position: new Vector3() },
    size: 512,
    whileCurrent: () => true,
    castShadows: false,
    bundles: false,
  });
  assert(streamed);
  let ready = false;
  void Promise.all([
    ...streamed.worlds.map((world) => world.whenSpawnReady({ x: 0, z: 0 }, 60)),
    ...streamed.worlds.map((world) => world.prewarmed),
  ]).then(
    () => {
      ready = true;
    },
    () => undefined,
  );
  new Group().add(...streamed.worlds);
  try {
    for (let frame = 0; frame < 100 && !ready; frame++) {
      for (const world of streamed.worlds) {
        world.update();
        world.traverse((node) => {
          if (!(node instanceof InstancedMesh)) return;
          expect(node.layers.isEnabled(27) || node.layers.isEnabled(28)).toBe(false);
          (node.onBeforeRender as (...args: unknown[]) => void)(node, null, null, null, null, null);
        });
      }
      await Promise.resolve();
    }
    expect(ready).toBe(true);
    expect(streamed.stats().loadedCells).toBe(streamed.stats().residentCells);
    expect(streamed.stats()).toMatchObject({
      loadsInFlight: 0,
      loadsQueued: 0,
      admissionBacklog: 0,
    });
    expect(streamed.meshes.reduce((count, mesh) => count + mesh.count, 0)).toBe(1);
    expect(streamed.stats().failures).toBe(0);
  } finally {
    streamed.dispose();
    geometry.dispose();
    material.dispose();
  }
});

// Captured from the pre-LOD fallback producer, including every seeded variant and attribute.
function fallbackDigest(parts: ReturnType<typeof buildPropVariants>, species: string, level = 0) {
  const hash = createHash("sha256");
  for (const [key, entries] of parts) {
    if (!key.startsWith(`${species}:`)) continue;
    hash.update(key);
    for (const part of entries.filter((entry) => (entry.level ?? 0) === level)) {
      hash.update(part.role);
      for (const name of Object.keys(part.geometry.attributes).sort()) {
        hash.update(name);
        hash.update(Buffer.from(part.geometry.getAttribute(name).array.buffer));
      }
      if (part.geometry.index) hash.update(Buffer.from(part.geometry.index.array.buffer));
    }
  }
  return hash.digest("hex");
}

it("keeps all original fallback near buffers and seeded variant sequence", () => {
  const parts = buildPropVariants();
  expect(fallbackDigest(parts, "spruce")).toBe(
    "3f82f5b822c63e279fda87b1a375ec62d8bf370c443fe5202e39a7de996ced87",
  );
  expect(fallbackDigest(parts, "sapling")).toBe(
    "e80064530b5b247433945b04337c621fbc6d9e415478a3b2b64566328801697c",
  );
});

it("provides deterministic reduced fallback crowns with unchanged trunks and scaled sapling levels", () => {
  const parts = buildPropVariants();
  const scaled = buildPropVariants(undefined, 2);
  for (const [key, entries] of parts) {
    if (!/^(spruce|sapling):/.test(key)) continue;
    for (const role of ["bark", "crown"]) {
      const near = entries.find((part) => (part.level ?? 0) === 0 && part.role === role);
      const far = entries.find((part) => part.level === 1 && part.role === role);
      assert(near);
      expect(far, `${key} ${role} needs authored far level`).toBeDefined();
      assert(far);
      expect(far.geometry.index?.count).toBe(
        (near.geometry.index?.count ?? 0) * (role === "crown" ? 2 / 3 : 1),
      );
      expect(Object.keys(far.geometry.attributes).sort()).toEqual(
        Object.keys(near.geometry.attributes).sort(),
      );
      expect(far.geometry).not.toBe(near.geometry);
      for (const name of Object.keys(near.geometry.attributes)) {
        expect(far.geometry.getAttribute(name)).not.toBe(near.geometry.getAttribute(name));
        expect(far.geometry.getAttribute(name).array).toEqual(
          near.geometry.getAttribute(name).array,
        );
      }
      if (role === "bark")
        expect(far.geometry.getAttribute("position").array).toEqual(
          near.geometry.getAttribute("position").array,
        );
      if (key.startsWith("sapling:")) {
        const resized = scaled.get(key)?.find((part) => part.level === 1 && part.role === role);
        assert(resized);
        const nearHeight = Math.max(
          ...entries
            .filter((part) => (part.level ?? 0) === 0)
            .map((part) => {
              part.geometry.computeBoundingBox();
              return part.geometry.boundingBox?.max.y ?? 0;
            }),
        );
        const positions = far.geometry.getAttribute("position");
        const actual = resized.geometry.getAttribute("position");
        expect(actual.count).toBe(positions.count);
        for (let index = 0; index < positions.array.length; index++)
          expect(actual.array[index]).toBeCloseTo(
            ((positions.array[index] ?? 0) * 2) / nearHeight,
            5,
          );
      }
    }
  }
  const repeated = buildPropVariants();
  for (const species of ["spruce", "sapling"])
    expect(fallbackDigest(repeated, species, 1)).toBe(fallbackDigest(parts, species, 1));
});

it("switches real fallback spruce and sapling batches into authored far levels at the existing gate", async () => {
  const parts = buildPropVariants();
  const material = new MeshBasicMaterial();
  const placements = ["spruce", "sapling"].map((asset) => ({
    id: `${asset}:fallback-lod`,
    asset,
    position: [0, 0, 0],
    rotation: 0,
    scale: 1,
    normal: [0, 1, 0],
    alignToNormal: false,
  })) as IPlacement[];
  const follow = { position: new Vector3() };
  const streamed = await createStreamedProps({
    placements,
    parts,
    materials: { bark: material, crown: material } as never,
    groundAt: () => ({ height: 0, offset: 0 }),
    follow,
    size: 512,
    whileCurrent: () => true,
  });
  assert(streamed);
  try {
    for (const [distance, level] of [
      [0, 0],
      [LOD_BANDS.mid + 5, 1],
      [LOD_BANDS.mid * 0.7, 0],
    ]) {
      follow.position.x = distance ?? 0;
      for (let frame = 0; frame < 100; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      const meshes = streamed.meshes.filter((mesh) => mesh.count > 0);
      expect(meshes.length).toBe(4);
      expect(
        meshes.every((mesh) => new RegExp(`:${level}:[0-9]+$`).test(mesh.name)),
        `distance ${distance}: ${meshes.map((mesh) => mesh.name).join(", ")}`,
      ).toBe(true);
      expect(meshes.every((mesh) => mesh.material === material)).toBe(true);
    }
  } finally {
    streamed.dispose();
    material.dispose();
  }
});
