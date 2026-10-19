import {
  BatchedMesh,
  BoxGeometry,
  type BufferGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SkinnedMesh,
  Texture,
  Vector3,
} from "three";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../core/src/entities.js";
import { baseGeometryOf } from "../../core/src/model-lod.js";
import { DecalField } from "../templates/shooter/src/render/decals.js";

function fixture(count = 2) {
  const root = new Group();
  const map = new Texture();
  const receiver = new Mesh<BufferGeometry, MeshBasicMaterial>(
    new PlaneGeometry(8, 8),
    new MeshBasicMaterial(),
  );
  root.add(receiver);
  const field = new DecalField(root, {
    countPerVariant: count,
    map,
    offset: 0.01,
    size: 1,
    tints: { stone: 0xffffff },
  });
  const slots = root.children.filter(
    (child): child is Mesh<BufferGeometry, MeshBasicMaterial> =>
      child instanceof Mesh && child !== receiver,
  );
  return { root, map, receiver, field, slots };
}

const normal = new Vector3(0, 0, 1);

describe("game-owned receiver decal projection", () => {
  it("releases fading projected buffers exactly once across 20 registry lifecycles", () => {
    let created = 0;
    let disposed = 0;
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const { receiver, field, slots, map } = fixture(4);
      const registry = new Registry();
      registry.add("decals", field);
      registry.add("map", map);
      const borrowedDisposed = vi.fn();
      receiver.geometry.addEventListener("dispose", borrowedDisposed);
      for (let shot = 0; shot < 12; shot += 1) {
        field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", {
          depth: 0.2,
          fade: { duration: 1, opacity: (p) => 1 - p },
        });
        created += 1;
        slots[shot % 4]?.geometry.addEventListener("dispose", () => {
          disposed += 1;
        });
        field.update(0.1);
      }
      field.update(0.5);
      receiver.removeFromParent();
      field.update(1);
      registry.clear();
      registry.clear();
      expect(receiver.children).toHaveLength(0);
      expect(borrowedDisposed).not.toHaveBeenCalled();
      expect(disposed).toBe(created);
    }
    expect(created).toBe(240);
  });
  it("maps only owned projected UVs into an authored atlas rectangle", () => {
    const a = fixture(1);
    const b = fixture(1);
    const borrowedUvs = Array.from(a.receiver.geometry.getAttribute("uv").array);
    a.field.project(a.receiver, a.receiver.geometry, new Vector3(), normal, "stone", {
      depth: 0.2,
      uvRect: [0.5, 0.25, 1, 0.75],
    });
    b.field.project(b.receiver, b.receiver.geometry, new Vector3(), normal, "stone", {
      depth: 0.2,
    });
    const atlas = a.slots[0]?.geometry.getAttribute("uv");
    const full = b.slots[0]?.geometry.getAttribute("uv");
    if (atlas === undefined || full === undefined) throw new Error("Missing atlas UVs");
    for (let i = 0; i < full.count; i += 1) {
      expect(atlas.getX(i)).toBeCloseTo(0.5 + full.getX(i) * 0.5, 6);
      expect(atlas.getY(i)).toBeCloseTo(0.25 + full.getY(i) * 0.5, 6);
    }
    expect(Array.from(a.receiver.geometry.getAttribute("uv").array)).toEqual(borrowedUvs);
    expect(a.slots[0]?.material.map).toBe(a.map);
    expect(a.map.offset.toArray()).toEqual([0, 0]);
    expect(a.map.repeat.toArray()).toEqual([1, 1]);
    a.field.dispose();
    b.field.dispose();
  });

  it("uses the authored opacity curve and expires owned geometry once without retiring the slot", () => {
    const { root, receiver, field, slots, map } = fixture(1);
    const slot = slots[0];
    if (slot === undefined) throw new Error("Missing slot");
    const plane = slot.geometry;
    const materialDisposed = vi.fn();
    const mapDisposed = vi.fn();
    slot.material.addEventListener("dispose", materialDisposed);
    map.addEventListener("dispose", mapDisposed);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", {
      depth: 0.2,
      fade: { duration: 2, opacity: (progress: number) => (1 - progress) ** 2 },
    });
    const geometryDisposed = vi.fn();
    slot.geometry.addEventListener("dispose", geometryDisposed);
    field.update(0.5);
    expect(slot.material.opacity).toBe(0.5625);
    field.update(0.5);
    expect(slot.material.opacity).toBe(0.25);
    field.update(1);
    field.update(10);
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(receiver.children).toHaveLength(0);
    expect(slot.parent).toBe(root);
    expect(slot.geometry).toBe(plane);
    expect(slot.visible).toBe(false);
    expect(slot.material.opacity).toBe(1);
    expect(materialDisposed).not.toHaveBeenCalled();
    expect(mapDisposed).not.toHaveBeenCalled();
    field.dispose();
    field.dispose();
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(mapDisposed).not.toHaveBeenCalled();
  });

  it("resets fade on projected or legacy reuse and keeps unconfigured marks persistent", () => {
    const { receiver, field, slots } = fixture(1);
    const fading = { depth: 0.2, fade: { duration: 2, opacity: (p: number) => 1 - p } };
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", fading);
    field.update(1);
    expect(slots[0]?.material.opacity).toBe(0.5);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    field.update(1000);
    expect(receiver.children).toHaveLength(1);
    expect(slots[0]?.material.opacity).toBe(1);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", fading);
    field.update(1);
    field.place(new Vector3(), normal, "stone");
    field.update(1000);
    expect(slots[0]?.material.opacity).toBe(1);
    expect(slots[0]?.visible).toBe(true);
    field.dispose();
  });

  it.each([
    { uvRect: [-0.1, 0, 1, 1] },
    { uvRect: [0.5, 0, 0.5, 1] },
    { uvRect: [0, 0, 1.1, 1] },
    { uvRect: [0, 0, 1, Number.NaN] },
    { fade: { duration: 0, opacity: () => 1 } },
    { fade: { duration: Number.POSITIVE_INFINITY, opacity: () => 1 } },
    { fade: { duration: 1, opacity: () => Number.NaN } },
    { fade: { duration: 1, opacity: () => 1.1 } },
  ])("refuses malformed authored controls without evicting a live mark: %j", (controls) => {
    const { receiver, field, slots } = fixture(1);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const geometry = slots[0]?.geometry;
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", {
        depth: 0.2,
        ...controls,
      } as Parameters<typeof field.project>[5]),
    ).toThrow(/decal/i);
    expect(slots[0]?.geometry).toBe(geometry);
    expect(field.placed).toBe(1);
    field.dispose();
  });

  it("rejects invalid time or curve values without advancing a live fade", () => {
    const { receiver, field, slots } = fixture(1);
    let invalid = false;
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", {
      depth: 0.2,
      fade: { duration: 2, opacity: (p: number) => (invalid ? Number.NaN : 1 - p) },
    });
    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => field.update(dt)).toThrow(/decal/i);
    field.update(0.5);
    expect(slots[0]?.material.opacity).toBe(0.75);
    invalid = true;
    expect(() => field.update(0.5)).toThrow(/decal/i);
    expect(slots[0]?.material.opacity).toBe(0.75);
    invalid = false;
    field.update(0.5);
    expect(slots[0]?.material.opacity).toBe(0.5);
    field.dispose();
  });

  it("refuses projection bias beyond the projector half-depth before recycling", () => {
    const { receiver, field, slots } = fixture(1);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const geometry = slots[0]?.geometry;
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.01 }),
    ).toThrow(/bias/i);
    expect(slots[0]?.geometry).toBe(geometry);
    field.dispose();
  });
  it("uses upstream projection on only the selected receiver with authored UVs and bias", () => {
    const { root, receiver, field, slots } = fixture();
    const other = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
    other.position.z = 0.02;
    root.add(other);
    expect(
      field.project(receiver, baseGeometryOf(receiver), new Vector3(), normal, "stone", {
        depth: 0.2,
      }),
    ).toBe(true);
    const slot = slots[0];
    expect(slot?.parent).toBe(receiver);
    expect(slot?.geometry).toBeInstanceOf(DecalGeometry);
    expect(other.children).toHaveLength(0);
    const positions = slot?.geometry.getAttribute("position");
    const uvs = slot?.geometry.getAttribute("uv");
    expect(positions?.count).toBeGreaterThan(0);
    for (let index = 0; index < (positions?.count ?? 0); index += 1) {
      expect(positions?.getZ(index)).toBeCloseTo(0.01, 6);
      expect(uvs?.getX(index)).toBeGreaterThanOrEqual(-1e-6);
      expect(uvs?.getX(index)).toBeLessThanOrEqual(1 + 1e-6);
      expect(uvs?.getY(index)).toBeGreaterThanOrEqual(-1e-6);
      expect(uvs?.getY(index)).toBeLessThanOrEqual(1 + 1e-6);
    }
    field.dispose();
  });

  it("retains local geometry through rigid receiver and ancestor motion", () => {
    const { root, receiver, field, slots } = fixture();
    const parent = new Group();
    root.add(parent);
    parent.add(receiver);
    receiver.position.set(2, 1, 3);
    receiver.rotation.y = 0.7;
    receiver.scale.setScalar(2);
    receiver.updateWorldMatrix(true, false);
    const point = receiver.localToWorld(new Vector3());
    const worldNormal = normal.clone().transformDirection(receiver.matrixWorld);
    field.project(receiver, receiver.geometry, point, worldNormal, "stone", { depth: 0.2 });
    const slot = slots[0];
    if (slot === undefined) throw new Error("Missing slot");
    const local = new Vector3().fromBufferAttribute(slot.geometry.getAttribute("position"), 0);
    parent.position.set(-3, 4, 1);
    parent.rotation.z = 0.4;
    receiver.position.x += 1;
    receiver.rotation.y += 0.5;
    root.updateMatrixWorld(true);
    const expected = receiver.localToWorld(local.clone());
    const actual = slot.localToWorld(local.clone());
    expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
    expect(
      new Vector3().fromBufferAttribute(slot.geometry.getAttribute("position"), 0).equals(local),
    ).toBe(true);
    field.dispose();
  });

  it("does not project the back face of a thin receiver", () => {
    const { receiver, field, slots } = fixture();
    receiver.geometry = new BoxGeometry(2, 2, 0.01);
    field.project(receiver, receiver.geometry, new Vector3(0, 0, 0.005), normal, "stone", {
      depth: 0.2,
    });
    const geometry = slots[0]?.geometry;
    const positions = geometry?.getAttribute("position");
    const indices = geometry?.getIndex();
    expect(indices?.count).toBeGreaterThan(0);
    for (let index = 0; index < (indices?.count ?? 0); index += 1) {
      expect(positions?.getZ(indices?.getX(index) ?? -1)).toBeCloseTo(0.015, 6);
    }
    field.dispose();
  });

  it("bounds 1,024 impacts to 256 slots and disposes evicted projected geometry", () => {
    const { receiver, field, slots, map } = fixture(256);
    const borrowed = receiver.geometry;
    const borrowedDisposed = vi.fn();
    borrowed.addEventListener("dispose", borrowedDisposed);
    const mapDisposed = vi.fn();
    map.addEventListener("dispose", mapDisposed);
    let disposed = 0;
    for (let hit = 0; hit < 1024; hit += 1) {
      expect(
        field.project(receiver, borrowed, new Vector3(), normal, "stone", { depth: 0.2 }),
      ).toBe(true);
      slots[hit % 256]?.geometry.addEventListener("dispose", () => {
        disposed += 1;
      });
      expect(receiver.children).toHaveLength(Math.min(hit + 1, 256));
    }
    expect(disposed).toBe(768);
    expect(field.capacity).toBe(256);
    expect(field.placed).toBe(1024);
    field.dispose();
    field.dispose();
    expect(disposed).toBe(1024);
    expect(receiver.children).toHaveLength(0);
    expect(borrowedDisposed).not.toHaveBeenCalled();
    expect(mapDisposed).not.toHaveBeenCalled();
  });

  it("releases a removed receiver immediately and a detached ancestor on update", () => {
    const { root, receiver, field, slots } = fixture();
    const parent = new Group();
    root.add(parent);
    parent.add(receiver);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const firstDisposed = vi.fn();
    slots[0]?.geometry.addEventListener("dispose", firstDisposed);
    receiver.removeFromParent();
    expect(firstDisposed).toHaveBeenCalledTimes(1);
    expect(receiver.children).toHaveLength(0);
    parent.add(receiver);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const secondDisposed = vi.fn();
    slots[1]?.geometry.addEventListener("dispose", secondDisposed);
    parent.removeFromParent();
    field.update();
    field.update();
    expect(secondDisposed).toHaveBeenCalledTimes(1);
    expect(receiver.children).toHaveLength(0);
    field.dispose();
  });

  it("restores the legacy plane on reuse and clears only owned projected geometry", () => {
    const { root, receiver, field, slots } = fixture(1);
    const plane = slots[0]?.geometry;
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const projectedDisposed = vi.fn();
    slots[0]?.geometry.addEventListener("dispose", projectedDisposed);
    field.place(new Vector3(1, 2, 3), normal, "stone", 2);
    expect(projectedDisposed).toHaveBeenCalledTimes(1);
    expect(slots[0]?.parent).toBe(root);
    expect(slots[0]?.geometry).toBe(plane);
    expect(slots[0]?.position.toArray()).toEqual([1, 2, 3.01]);
    expect(slots[0]?.scale.x).toBe(2);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const clearedDisposed = vi.fn();
    slots[0]?.geometry.addEventListener("dispose", clearedDisposed);
    field.clear();
    field.clear();
    expect(clearedDisposed).toHaveBeenCalledTimes(1);
    expect(slots[0]?.geometry).toBe(plane);
    expect(receiver.children).toHaveLength(0);
    field.dispose();
  });

  it("uses a supplied base geometry across render LOD swaps without mutating or owning it", () => {
    const { receiver, field, slots } = fixture();
    const base = baseGeometryOf(receiver);
    const coarse = new PlaneGeometry(0.1, 0.1);
    receiver.geometry = coarse;
    field.project(receiver, base, new Vector3(2, 0, 0), normal, "stone", { depth: 0.2 });
    expect(slots[0]?.geometry.getAttribute("position").count).toBeGreaterThan(0);
    expect(receiver.geometry).toBe(coarse);
    const localPositions = Array.from(slots[0]?.geometry.getAttribute("position").array ?? []);
    coarse.dispose();
    receiver.geometry = base;
    expect(Array.from(slots[0]?.geometry.getAttribute("position").array ?? [])).toEqual(
      localPositions,
    );
    field.dispose();
  });

  it.each([
    ["skinned", () => new SkinnedMesh(new PlaneGeometry(8, 8), new MeshBasicMaterial())],
    ["instanced", () => new InstancedMesh(new PlaneGeometry(8, 8), new MeshBasicMaterial(), 1)],
    ["batched", () => new BatchedMesh(2, 20, 30, new MeshBasicMaterial())],
    [
      "transparent",
      () => new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial({ transparent: true })),
    ],
    ["cutout", () => new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial({ alphaTest: 0.5 }))],
    [
      "morphed",
      () => {
        const mesh = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
        mesh.geometry.morphAttributes.position = [
          new Float32BufferAttribute(new Float32Array(12), 3),
        ];
        return mesh;
      },
    ],
    [
      "nonuniform",
      () => {
        const mesh = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
        mesh.scale.set(1, 2, 1);
        return mesh;
      },
    ],
    [
      "mirrored",
      () => {
        const mesh = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
        mesh.scale.x = -1;
        return mesh;
      },
    ],
    [
      "singular",
      () => {
        const mesh = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
        mesh.scale.x = 0;
        return mesh;
      },
    ],
  ])("refuses %s receivers before recycling a live slot", (_name, makeReceiver) => {
    const { root, receiver, field, slots } = fixture(1);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const existing = slots[0]?.geometry;
    const unsupported = makeReceiver();
    root.add(unsupported);
    expect(() =>
      field.project(unsupported, unsupported.geometry, new Vector3(), normal, "stone", {
        depth: 0.2,
      }),
    ).toThrow(/unsupported receiver/i);
    expect(slots[0]?.geometry).toBe(existing);
    expect(field.placed).toBe(1);
    field.dispose();
  });

  it("does not consume a slot on a miss, after disposal, or with an invalid projector", () => {
    const { receiver, field, slots } = fixture(1);
    const original = slots[0]?.geometry;
    expect(
      field.project(receiver, receiver.geometry, new Vector3(20, 0, 0), normal, "stone", {
        depth: 0.2,
      }),
    ).toBe(false);
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0 }),
    ).toThrow(/projector/i);
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), new Vector3(), "stone", {
        depth: 0.2,
      }),
    ).toThrow(/projector/i);
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), new Vector3(1e308, 0, 0), "stone", {
        depth: 0.2,
      }),
    ).toThrow(/projector/i);
    expect(field.placed).toBe(0);
    expect(slots[0]?.geometry).toBe(original);
    field.dispose();
    expect(
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 }),
    ).toBe(false);
  });

  it("refuses nonuniform ancestor scale and shear", () => {
    const { root, receiver, field } = fixture();
    const parent = new Group();
    root.add(parent);
    parent.add(receiver);
    parent.scale.set(1, 2, 1);
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 }),
    ).toThrow(/unsupported receiver/i);
    parent.scale.setScalar(1);
    receiver.matrixAutoUpdate = false;
    receiver.matrix.makeShear(0.5, 0, 0, 0, 0, 0);
    expect(() =>
      field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 }),
    ).toThrow(/unsupported receiver/i);
    field.dispose();
  });

  it("explicit receiver cleanup does not retire another receiver's marks", () => {
    const { root, receiver, field, slots } = fixture();
    const other = new Mesh(new PlaneGeometry(8, 8), new MeshBasicMaterial());
    root.add(other);
    field.project(receiver, receiver.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    field.project(other, other.geometry, new Vector3(), normal, "stone", { depth: 0.2 });
    const retained = slots[1]?.geometry;
    field.removeReceiver(receiver);
    field.removeReceiver(receiver);
    expect(receiver.children).toHaveLength(0);
    expect(other.children).toHaveLength(1);
    expect(slots[1]?.geometry).toBe(retained);
    field.dispose();
  });
});
