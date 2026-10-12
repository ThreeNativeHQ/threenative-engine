import { createAssetLoader } from "@threenative/core";
import { WorldCells } from "@threenative/core/world";
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
  createSpawnReadiness,
  spawnReadinessSnapshot,
} from "../../../examples/strata-terrain-preview/src/render/loading.js";
import {
  type IPropPreparationProgress,
  createStreamedProps,
  invalidatePropShadows,
} from "../../../examples/strata-terrain-preview/src/render/propStreaming.js";
import {
  createProps,
  variantFor,
} from "../../../examples/strata-terrain-preview/src/render/props.js";
import type { IPlacement } from "../src/index.js";

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
  await resolving;
  let streamed: Awaited<typeof work>;
  try {
    expect(progress?.phase).toBe("world-load");
    expect(progress?.bucket).toBe("horizon:true");
    expect(progress?.worlds).toHaveLength(0);
    vi.useFakeTimers();
    let receipt: ReturnType<typeof spawnReadinessSnapshot> | undefined;
    const spawn = createSpawnReadiness("Controlled spawn", 100, (reason) => {
      receipt = spawnReadinessSnapshot({
        reason,
        atMs: performance.now(),
        world: "forest",
        sceneUuid: "controlled-scene",
        released: false,
        gate: spawn,
        stage: "streaming",
        propsSettled: false,
        preparation: progress,
        assets: assets.progress,
        startup: { phase: "collapsing", progress: 0.95, compileSettled: true, timeline: {} },
      });
    });
    const rejection = expect(spawn.promise).rejects.toThrow("admission exceeded 100 ms");
    try {
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(receipt?.gate).toEqual({ ready: false, error: "" });
      expect(receipt?.preparation.phase).toBe("world-load");
      expect(receipt?.preparation.worldCount).toBe(0);
      expect(receipt?.released).toBe(false);
    } finally {
      spawn.cancel();
      vi.useRealTimers();
    }
    release();
    streamed = await work;
    expect(progress?.phase).toBe("complete");
    expect(progress?.worlds).toEqual(streamed?.worlds);
    expect(streamed?.worlds[0]?.parent).toBeNull();
    expect(streamed?.worlds[0]?.released).toBe(false);
    expect(progress?.prewarmedWorlds).toBe(0);
    expect(receipt?.preparation.worldCount).toBe(0);
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
  const original = createProps(placements, ground, parts, materials);
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
    for (const placement of placements)
      expect(streamed.byId.get(placement.id)?.pose.elements).toEqual(
        original.byId.get(placement.id)?.pose.elements,
      );
    for (const x of [-480, 480, -480]) {
      follow.position.x = x;
      original.setLevels(follow.position);
      for (let frame = 0; frame < 150; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(
        original.meshes.reduce((n, m) => n + m.count, 0),
      );
    }
    expect(streamed.stats().evictions).toBeGreaterThan(0);
    expect(streamed.stats().failures).toBe(0);
  } finally {
    streamed.dispose();
    original.dispose();
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
  try {
    expect(streamed.ready).toBe(false);
    expect(preparation?.prewarmedWorlds).toBe(0);
    for (let frame = 0; frame < 200; frame++) {
      for (const world of streamed.worlds) world.update();
      await Promise.resolve();
    }
    expect(streamed.meshes.reduce((n, m) => n + m.count, 0)).toBe(placements.length);
    expect(streamed.ready).toBe(false);
    expect(streamed.stats().pendingPrewarm).toBeGreaterThan(0);
    new Group().add(...streamed.worlds);
    for (let frame = 0; frame < 200 && !streamed.ready; frame++) {
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
    expect(streamed.ready).toBe(true);
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
  const original = createProps([placement], () => ({ height: 0, offset: 0 }), parts, materials);
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
    for (const distance of [0, 65, 500, 55, 61, 59, 61, 59, 47, 155, 140, 151, 149, 119, 47]) {
      follow.position.x = distance;
      original.setLevels(follow.position);
      for (let frame = 0; frame < 100; frame++) {
        for (const world of streamed.worlds) world.update();
        await Promise.resolve();
      }
      expect(active(streamed.meshes), `distance ${distance}`).toEqual(active(original.meshes));
    }
  } finally {
    streamed.dispose();
    original.dispose();
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
  const original = createProps(placements, () => ({ height: 0, offset: 0 }), parts, materials);
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
      const before = draws(original.meshes, material);
      const after = draws(streamed.meshes, material);
      expect(after).toHaveLength(placements.length);
      for (let i = 0; i < before.length; i++)
        for (let j = 0; j < 16; j++)
          expect(after.at(i)?.[j]).toBeCloseTo(before.at(i)?.[j] as number, 5);
    }
  } finally {
    streamed.dispose();
    original.dispose();
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
  const original = createProps(placements, () => ({ height: 0, offset: 0 }), parts, {} as never);
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
      original.setLevels(follow.position);
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
      expect(active(streamed.meshes)).toEqual(active(original.meshes));
      for (const layer of [28, 27]) {
        const casters: InstancedMesh[] = [];
        for (const world of streamed.worlds)
          world.traverse((node) => {
            if (node instanceof InstancedMesh && node.layers.isEnabled(layer)) casters.push(node);
          });
        expect(active(casters)).toEqual(active(original.meshes.filter((mesh) => mesh.castShadow)));
      }
    }
  } finally {
    streamed.dispose();
    original.dispose();
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
