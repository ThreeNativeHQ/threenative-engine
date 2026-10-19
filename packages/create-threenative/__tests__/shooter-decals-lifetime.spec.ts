import {
  Group,
  Material,
  Mesh,
  type MeshBasicMaterial,
  PlaneGeometry,
  Texture,
  Vector3,
} from "three";
import { afterEach, expect, it, vi } from "vitest";
import { Registry } from "../../core/src/entities.js";
import { DecalField } from "../templates/shooter/src/render/decals.js";

afterEach(() => vi.restoreAllMocks());

it("releases every owned slot material while retaining the borrowed map", () => {
  const parent = new Group();
  const unrelated = new Group();
  parent.add(unrelated);
  const map = new Texture();
  const mapDisposed = vi.fn();
  map.addEventListener("dispose", mapDisposed);
  const materialDisposed = vi.spyOn(Material.prototype, "dispose");
  const field = new DecalField(parent, {
    countPerVariant: 3,
    map,
    size: 0.13,
    tints: { steel: 0xb6bcc4, wood: 0x8a6a44 },
  });
  const slots = parent.children.filter(
    (child): child is Mesh<PlaneGeometry, MeshBasicMaterial> => child instanceof Mesh,
  );
  expect(slots).toHaveLength(6);
  expect(new Set(slots.map((slot) => slot.material)).size).toBe(6);
  const releases = slots.map((slot) => {
    expect(slot.material.map).toBe(map);
    const released = vi.fn();
    slot.material.addEventListener("dispose", released);
    return released;
  });
  const geometryDisposed = vi.fn();
  slots[0]?.geometry.addEventListener("dispose", geometryDisposed);

  field.place(new Vector3(1, 2, 3), new Vector3(0, 1, 0), "steel");
  field.dispose();

  for (const released of releases) expect(released).toHaveBeenCalledTimes(1);
  // Six cloned slot materials and the two family source materials are owned by the field.
  expect(materialDisposed).toHaveBeenCalledTimes(8);
  expect(geometryDisposed).toHaveBeenCalledTimes(1);
  expect(parent.children).toEqual([unrelated]);
  expect(mapDisposed).not.toHaveBeenCalled();
  map.dispose();
  expect(mapDisposed).toHaveBeenCalledTimes(1);
});

it.each([0, 3])("tears down only once with %i slots per variant", (countPerVariant) => {
  const parent = new Group();
  const map = new Texture();
  const materialDisposed = vi.spyOn(Material.prototype, "dispose");
  const geometryDisposed = vi.spyOn(PlaneGeometry.prototype, "dispose");
  const field = new DecalField(parent, {
    countPerVariant,
    map,
    size: 0.13,
    tints: { steel: 0xb6bcc4 },
  });

  field.dispose();
  field.dispose();

  expect(materialDisposed).toHaveBeenCalledTimes(countPerVariant + 1);
  expect(geometryDisposed).toHaveBeenCalledTimes(1);
  expect(parent.children).toHaveLength(0);
  map.dispose();
});

it("releases resources after repeated pool reuse, clear and registry teardown", () => {
  const map = new Texture();
  const mapDisposed = vi.fn();
  map.addEventListener("dispose", mapDisposed);
  const materialDisposed = vi.spyOn(Material.prototype, "dispose");
  const geometryDisposed = vi.spyOn(PlaneGeometry.prototype, "dispose");
  const point = new Vector3(1, 2, 3);
  const normal = new Vector3(0, 1, 0);

  for (let cycle = 0; cycle < 20; cycle += 1) {
    const parent = new Group();
    const registry = new Registry();
    const field = new DecalField(parent, {
      countPerVariant: 4,
      map,
      size: 0.13,
      tints: { steel: 0xb6bcc4, wood: 0x8a6a44 },
    });
    const slots = [...parent.children];
    registry.add("decals", field);
    field.settle();
    for (let hit = 0; hit < 100; hit += 1) {
      field.place(point, normal, hit % 2 === 0 ? "steel" : "wood");
    }
    field.clear();
    expect(parent.children).toEqual(slots);
    expect(parent.children).toHaveLength(field.capacity);
    expect(materialDisposed).toHaveBeenCalledTimes(cycle * 10);
    expect(geometryDisposed).toHaveBeenCalledTimes(cycle);
    field.place(point, normal, "wood");
    registry.clear();
    field.dispose();
    expect(parent.children).toHaveLength(0);
    expect(materialDisposed).toHaveBeenCalledTimes((cycle + 1) * 10);
    expect(geometryDisposed).toHaveBeenCalledTimes(cycle + 1);
    expect(mapDisposed).not.toHaveBeenCalled();
  }
  map.dispose();
});
