import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Euler,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Shape,
  SkinnedMesh,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { describe, expect, it, vi } from "vitest";
import { type IMergePart, mergeByMaterial, mergeParts } from "../src/merge-parts.js";

/** The mismatch that actually happens: a lofted profile is non-indexed, a primitive is indexed. */
function extruded(): ExtrudeGeometry {
  const profile = new Shape();
  profile.moveTo(0, 0);
  profile.lineTo(1, 0);
  profile.lineTo(1, 1);
  profile.lineTo(0, 0);
  return new ExtrudeGeometry(profile, { bevelEnabled: false, depth: 0.5 });
}

/**
 * A deliberately authored triangle: non-indexed, one normal, one uv. The normal points along +Y
 * while the triangle lies in the XY plane, so a face-normal recompute would give every vertex +Z —
 * which is what makes "was the authored normal kept?" a visible fact rather than a guess.
 */
function authoredTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3),
  );
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  return geometry;
}

describe("mergeParts", () => {
  function morphedBox(): BoxGeometry {
    const geometry = new BoxGeometry(1, 1, 1);
    const positions = geometry.getAttribute("position");
    const morph = new Float32Array(positions.count * 3);
    for (let vertex = 0; vertex < positions.count; vertex += 1) morph[vertex * 3 + 1] = 0.25;
    geometry.morphAttributes.position = [new BufferAttribute(morph, 3)];
    geometry.morphTargetsRelative = true;
    return geometry;
  }

  it("should merge a cooked (quantized uv) part with a float part at the values three draws", () => {
    const cooked = new BoxGeometry(1, 1, 1);
    const uv = cooked.getAttribute("uv");
    const quantized = new Uint16Array(uv.count * 2);
    for (let index = 0; index < quantized.length; index += 1)
      quantized[index] = Math.round((uv.array[index] as number) * 65535);
    cooked.setAttribute("uv", new BufferAttribute(quantized, 2, true));
    const plain = new BoxGeometry(2, 2, 2);

    // The control: the refusal a cooked chunk hit on the 2 km map.
    expect(mergeGeometries([cooked.toNonIndexed(), plain.toNonIndexed()], false)).toBeNull();

    const merged = mergeParts([{ geometry: cooked }, { geometry: plain }], {
      label: "cooked",
      preserve: ["uv", "normal"],
    });
    const out = merged.getAttribute("uv");
    expect(out.array).toBeInstanceOf(Float32Array);
    // Both parts are indexed, so the merge is too and the first part's vertices are the source's own,
    // in its order — read from the indexed input, not from its de-indexed expansion.
    expect(merged.index).not.toBeNull();
    const first = cooked.getAttribute("uv");
    for (let index = 0; index < first.count; index += 1)
      expect(out.getX(index)).toBeCloseTo(first.getX(index), 4);
  });

  it("should merge a non-indexed extrusion with an indexed box (PRD-277 AC4)", () => {
    const extrusion = extruded();
    const box = new BoxGeometry(1, 1, 1);

    // The control: this is what a game gets today without the helper.
    const raw = mergeGeometries([extrusion, box], false);
    expect(raw).toBeNull();

    const merged = mergeParts([{ geometry: extrusion }, { geometry: box }], { label: "hull" });
    expect(merged.index).toBeNull();
    expect(merged.getAttribute("position").count).toBe(
      extrusion.getAttribute("position").count + box.toNonIndexed().getAttribute("position").count,
    );
    expect(merged.getAttribute("normal")).toBeDefined();
  });

  it("should place each part by its own matrix, and take a Mesh as a part", () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.position.set(0, 10, 0);
    const matrixBefore = mesh.matrix.clone();
    const merged = mergeParts([mesh], { label: "crate" });
    merged.computeBoundingBox();
    expect(merged.boundingBox?.min.y).toBeCloseTo(9.5, 5);
    expect(merged.boundingBox?.max.y).toBeCloseTo(10.5, 5);
    expect(mesh.matrix.elements).toEqual(matrixBefore.elements);
    // The game's own geometry is never mutated.
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox?.max.y).toBeCloseTo(0.5, 5);
  });

  it("should place explicit geometry inputs by their matrix without mutating it", () => {
    const matrix = new Matrix4().makeTranslation(0, -3, 0);
    const matrixBefore = matrix.clone();
    const merged = mergeParts([{ geometry: new BoxGeometry(1, 1, 1), matrix }], {
      label: "explicit-crate",
    });
    merged.computeBoundingBox();
    expect(merged.boundingBox?.min.y).toBeCloseTo(-3.5, 5);
    expect(merged.boundingBox?.max.y).toBeCloseTo(-2.5, 5);
    expect(matrix.elements).toEqual(matrixBefore.elements);
  });

  it("should keep every part's own colour in the merged geometry (PRD-277 AC2)", () => {
    const tones = [0x8b2f1a, 0x2f8b1a, 0x1a2f8b] as const;
    const parts = tones.map((color) => ({ color, geometry: new BoxGeometry(1, 1, 1) }));
    const merged = mergeParts(parts, { label: "banner" });

    const colors = merged.getAttribute("color");
    const perPart = new BoxGeometry(1, 1, 1).getAttribute("position").count;
    expect(colors.itemSize).toBe(3);
    expect(colors.count).toBe(perPart * tones.length);
    tones.forEach((tone, index) => {
      const expected = new Color(tone);
      for (let vertex = 0; vertex < perPart; vertex += 1) {
        const at = index * perPart + vertex;
        expect(colors.getX(at)).toBeCloseTo(expected.r, 6);
        expect(colors.getY(at)).toBeCloseTo(expected.g, 6);
        expect(colors.getZ(at)).toBeCloseTo(expected.b, 6);
      }
    });
  });

  it("should refuse a merge it cannot normalise, naming the label (PRD-277 AC3)", () => {
    const parts = [{ geometry: new BoxGeometry(1, 1, 1) }, { geometry: new BufferGeometry() }];

    // The control: three.js reports to the console and hands back a null that propagates.
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      mergeGeometries(
        parts.map((part) => part.geometry.toNonIndexed()),
        false,
      ),
    ).toBeNull();
    errors.mockRestore();

    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mergeParts(parts, { label: "gatehouse" })).toThrow(/gatehouse/u);
    quiet.mockRestore();
  });

  it("should fail closed on an empty part list and on a partly coloured one", () => {
    expect(() => mergeParts([], { label: "nothing" })).toThrow(/nothing/u);
    expect(() =>
      mergeParts(
        [{ color: 0xffffff, geometry: new BoxGeometry(1, 1, 1) }, { geometry: new BoxGeometry() }],
        { label: "half-painted" },
      ),
    ).toThrow(/half-painted/u);
  });

  it("should strip morph targets from flattened parts in either input order", () => {
    const morphed = morphedBox();
    const plain = new BoxGeometry(1, 1, 1);

    for (const parts of [
      [{ geometry: morphed }, { geometry: plain }],
      [{ geometry: plain }, { geometry: morphed }],
    ]) {
      const merged = mergeParts(parts, { label: "morph-trim" });
      expect(Object.keys(merged.morphAttributes)).toEqual([]);
      expect(merged.morphTargetsRelative).toBe(false);
      expect(merged.getAttribute("position").count).toBe(
        morphed.getAttribute("position").count + plain.getAttribute("position").count,
      );
    }

    expect(Object.keys(morphed.morphAttributes)).toEqual(["position"]);
    expect(morphed.morphTargetsRelative).toBe(true);
  });

  it("should drop attributes that cannot survive a merge and keep only position and colour", () => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.setAttribute(
      "uv2",
      new BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 2), 2),
    );
    const merged = mergeParts([{ geometry }, { geometry: new BoxGeometry(1, 1, 1) }], {
      label: "trim",
    });
    expect(Object.keys(merged.attributes).sort()).toEqual(["normal", "position"]);
  });

  it("should retain uv and transform the authored normal when preserve asks (PRD-392 AC1)", () => {
    const geometry = authoredTriangle();
    const matrix = new Matrix4().makeRotationX(Math.PI / 2).setPosition(5, 0, 0);
    const merged = mergeParts([{ geometry, matrix }], {
      label: "authored",
      preserve: ["uv", "normal"],
    });

    // The placement matrix moves position and normal only: uv keeps its exact authored values.
    expect(Array.from(merged.getAttribute("uv").array)).toEqual([0, 0, 1, 0, 0, 1]);
    // +Y rotated 90 degrees about X is +Z, via the inverse-transpose normal matrix.
    const normal = merged.getAttribute("normal");
    for (let i = 0; i < normal.count; i += 1) {
      expect(normal.getX(i)).toBeCloseTo(0, 6);
      expect(normal.getY(i)).toBeCloseTo(0, 6);
      expect(normal.getZ(i)).toBeCloseTo(1, 6);
    }
  });

  it("should keep a preserved authored normal, not recompute it (PRD-392 AC1)", () => {
    const kept = mergeParts([{ geometry: authoredTriangle() }], {
      label: "kept",
      preserve: ["normal"],
    });
    const keptNormal = kept.getAttribute("normal");
    expect(keptNormal.getY(0)).toBeCloseTo(1, 6);
    expect(keptNormal.getZ(0)).toBeCloseTo(0, 6);

    const recomputed = mergeParts([{ geometry: authoredTriangle() }], { label: "recomputed" });
    expect(recomputed.getAttribute("normal").getZ(0)).toBeCloseTo(1, 6);
  });

  it("should refuse a listed channel a part does not carry, naming label, part and channel (PRD-392)", () => {
    const bare = new BufferGeometry();
    bare.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );

    expect(() =>
      mergeParts([{ geometry: authoredTriangle() }, { geometry: bare }], {
        label: "no-uv",
        preserve: ["uv"],
      }),
    ).toThrow(/no-uv.*part 1.*uv/u);
    expect(() =>
      mergeParts([{ geometry: bare }], { label: "no-normal", preserve: ["normal"] }),
    ).toThrow(/no-normal.*part 0.*normal/u);
  });

  it("should keep the position-only default when preserve is absent or empty (PRD-392 AC1)", () => {
    const absent = mergeParts([{ geometry: authoredTriangle() }], { label: "absent" });
    expect(absent.getAttribute("uv")).toBeUndefined();
    expect(absent.getAttribute("normal")).toBeDefined();

    const empty = mergeParts([{ geometry: authoredTriangle() }], {
      label: "empty",
      preserve: [],
    });
    expect(empty.getAttribute("uv")).toBeUndefined();
  });

  it("should keep per-part colour alongside preserved uv and normal (PRD-392)", () => {
    const tones = [0x8b2f1a, 0x2f8b1a] as const;
    const parts = tones.map((color) => ({ color, geometry: authoredTriangle() }));
    const merged = mergeParts(parts, { label: "coloured", preserve: ["uv", "normal"] });

    expect(merged.getAttribute("color").count).toBe(6);
    expect(merged.getAttribute("uv").count).toBe(6);
    expect(merged.getAttribute("normal").count).toBe(6);
    tones.forEach((tone, index) => {
      expect(merged.getAttribute("color").getX(index * 3)).toBeCloseTo(new Color(tone).r, 6);
    });
    expect(Array.from(merged.getAttribute("uv").array)).toEqual([
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });

  it("should merge an indexed and a non-indexed part while preserving uv and normal (PRD-392)", () => {
    const merged = mergeParts([{ geometry: extruded() }, { geometry: new BoxGeometry(1, 1, 1) }], {
      label: "mixed-preserve",
      preserve: ["uv", "normal"],
    });

    expect(merged.index).toBeNull();
    expect(merged.getAttribute("normal")).toBeDefined();
    expect(merged.getAttribute("uv").count).toBe(merged.getAttribute("position").count);
  });

  it("should never mutate the part geometry when preserving channels (PRD-392)", () => {
    const geometry = authoredTriangle();
    const normalBefore = Array.from(geometry.getAttribute("normal").array);
    const uvBefore = Array.from(geometry.getAttribute("uv").array);

    mergeParts([{ geometry, matrix: new Matrix4().makeRotationX(1) }], {
      label: "no-mutate",
      preserve: ["uv", "normal"],
    });

    expect(Array.from(geometry.getAttribute("normal").array)).toEqual(normalBefore);
    expect(Array.from(geometry.getAttribute("uv").array)).toEqual(uvBefore);
    expect(Object.keys(geometry.attributes).sort()).toEqual(["normal", "position", "uv"]);
  });

  it("should preserve uv and normal from an interleaved part without touching its buffer (PRD-392)", () => {
    const data = new Float32Array([
      0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
    const buffer = new InterleavedBuffer(data, 8);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute("normal", new InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute("uv", new InterleavedBufferAttribute(buffer, 2, 6));

    const merged = mergeParts([{ geometry }], {
      label: "interleaved",
      preserve: ["uv", "normal"],
    });

    expect(Array.from(merged.getAttribute("uv").array)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(merged.getAttribute("normal").getY(0)).toBeCloseTo(1, 6);
    expect(Array.from(data)).toEqual([
      0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]);
  });
});

describe("mergeByMaterial", () => {
  /** A named material, so a refusal names `label:material` and not a group index. */
  function surface(name: string): MeshStandardMaterial {
    const material = new MeshStandardMaterial();
    material.name = name;
    return material;
  }

  it("should return one mesh per material with transforms baked and the game's own surface", () => {
    const hull = surface("hull");
    const deck = surface("deck");
    const mast = surface("mast");
    const root = new Group();
    for (let part = 0; part < 3; part += 1) {
      for (const material of [hull, deck, mast]) {
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
        mesh.position.set((part + 1) * 10, 1, 2);
        root.add(mesh);
      }
    }

    const merged = mergeByMaterial(root, { label: "ship" });

    expect(merged).toHaveLength(3);
    expect(merged.map((mesh) => mesh.material)).toEqual([hull, deck, mast]);
    for (const mesh of merged) {
      // Three boxes merge indexed: 24 vertices each, not the 36 a de-indexed merge would upload.
      expect(mesh.geometry.getAttribute("position").count).toBe(3 * 24);
      expect(mesh.geometry.index).not.toBeNull();
      // Box corners sit at ±0.5 and the first piece is placed at (10, 1, 2), so the first merged
      // vertex reads 10.5 — the placement is in the buffer, not on a node.
      expect(mesh.geometry.getAttribute("position").getX(0)).toBeCloseTo(10.5, 5);
      expect(mesh.geometry.getAttribute("position").getY(0)).toBeCloseTo(1.5, 5);
      expect(mesh.geometry.getAttribute("position").getZ(0)).toBeCloseTo(2.5, 5);
      expect(mesh.geometry.getAttribute("uv")).toBeDefined();
      expect(mesh.geometry.getAttribute("normal")).toBeDefined();
    }
  });

  it("should leave root and its meshes untouched", () => {
    const root = new Group();
    root.position.set(4, 0, 0);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), surface("plate"));
    root.add(mesh);
    mesh.position.set(1, 2, 3);
    const before = Array.from(mesh.geometry.getAttribute("position").array);

    const [merged] = mergeByMaterial(root, { label: "plate" });

    // Merged in the root's own frame, so the bake is 1 + 0.5 rather than 4 + 1 + 0.5.
    expect(merged?.geometry.getAttribute("position").getX(0)).toBeCloseTo(1.5, 5);
    expect(Array.from(mesh.geometry.getAttribute("position").array)).toEqual(before);
    expect(root.children).toEqual([mesh]);
    expect(mesh.position.toArray()).toEqual([1, 2, 3]);
  });

  it("should honour skip", () => {
    const hull = surface("hull");
    const root = new Group();
    const moving = new Mesh(new BoxGeometry(1, 1, 1), hull);
    moving.name = "radar";
    root.add(
      moving,
      new Mesh(new BoxGeometry(1, 1, 1), hull),
      new Mesh(new BoxGeometry(1, 1, 1), hull),
    );

    const [merged] = mergeByMaterial(root, {
      label: "hull",
      skip: (mesh) => mesh.name === "radar",
    });

    expect(merged?.geometry.getAttribute("position").count).toBe(2 * 24);
    expect(merged?.geometry.getAttribute("uv")).toBeDefined();
  });

  it("should refuse a group where only some meshes carry uv, naming the label", () => {
    const hull = surface("hull");
    const root = new Group();
    const bare = new BoxGeometry(1, 1, 1);
    bare.deleteAttribute("uv");
    root.add(new Mesh(new BoxGeometry(1, 1, 1), hull), new Mesh(bare, hull));

    expect(() => mergeByMaterial(root, { label: "ship" })).toThrow(
      /mergeParts\(ship:hull\).*no uv/u,
    );
  });

  it("should throw naming the label when a group cannot be merged", () => {
    const root = new Group();
    const hull = surface("hull");
    root.add(new Mesh(new BoxGeometry(1, 1, 1), hull));
    root.add(new Mesh(new BufferGeometry(), hull));

    expect(() => mergeByMaterial(root, { label: "ship" })).toThrow(/mergeParts\(ship:hull\)/);
  });

  it("should leave a skinned or instanced mesh out of the bake", () => {
    const hull = surface("hull");
    const root = new Group();
    const staticMesh = new Mesh(new BoxGeometry(1, 1, 1), hull);
    const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), hull);
    const instanced = new InstancedMesh(new BoxGeometry(1, 1, 1), hull, 2);
    root.add(staticMesh, skinned, instanced);

    const [merged] = mergeByMaterial(root, { label: "crew" });

    expect(merged?.geometry.getAttribute("position").count).toBe(24);
  });

  /**
   * The 228.8 MB the browser walk measured: 826 buffers created out of `createAttribute`, every one
   * of them a merged chunk's first draw, because the bake de-indexed everything. These are the four
   * facts that cut it.
   */
  describe("upload size", () => {
    /** A grid with `triangles` triangles over `tris / 2 + 1` vertices, so vertex count is tunable. */
    function grid(triangles: number): BufferGeometry {
      const quads = triangles / 2;
      const positions = new Float32Array((quads + 1) * 2 * 3);
      for (let vertex = 0; vertex <= quads; vertex += 1) {
        const at = vertex / quads;
        positions.set([at, 0, at, at, 1, at], vertex * 6);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      geometry.setAttribute(
        "normal",
        new BufferAttribute(new Float32Array((quads + 1) * 2 * 3), 3),
      );
      geometry.setAttribute("uv", new BufferAttribute(new Float32Array((quads + 1) * 4), 2));
      // 16-bit: each part names its own vertices, so the merge crossing 65,535 is the widen's job.
      const indices = new Uint16Array(triangles * 3);
      for (let quad = 0; quad < quads; quad += 1) {
        const at = quad * 6;
        indices[at] = quad * 2;
        indices[at + 1] = quad * 2 + 1;
        indices[at + 2] = quad * 2 + 2;
        indices[at + 3] = quad * 2 + 1;
        indices[at + 4] = quad * 2 + 3;
        indices[at + 5] = quad * 2 + 2;
      }
      geometry.setIndex(new BufferAttribute(indices, 1));
      return geometry;
    }

    it("should merge an all-indexed group indexed, at the parts' own vertex counts", () => {
      const box = new BoxGeometry(1, 1, 1);
      const sphere = new BoxGeometry(2, 2, 2);
      const merged = mergeParts([{ geometry: box }, { geometry: sphere }], {
        label: "indexed",
        preserve: ["uv", "normal"],
      });

      expect(merged.index).not.toBeNull();
      // 24 + 24 vertices, not 36 + 36: the index survives, so the merged buffer is a third smaller.
      expect(merged.getAttribute("position").count).toBe(
        box.getAttribute("position").count + sphere.getAttribute("position").count,
      );
      expect(merged.getAttribute("position").count).toBeLessThan(
        box.toNonIndexed().getAttribute("position").count +
          sphere.toNonIndexed().getAttribute("position").count,
      );
      // Every part's indices still name its own vertices, offset into the merged vertex range.
      const indices = merged.getIndex();
      const first = box.getIndex();
      const offset = box.getAttribute("position").count;
      for (let at = 0; at < (first?.count ?? 0); at += 1)
        expect(indices?.getX((first?.count ?? 0) + at)).toBe((first?.getX(at) ?? 0) + offset);
    });

    it("should still merge a mixed group non-indexed", () => {
      const merged = mergeParts(
        [{ geometry: extruded() }, { geometry: new BoxGeometry(1, 1, 1) }],
        {
          label: "mixed",
        },
      );

      expect(merged.index).toBeNull();
    });

    it("should widen the index past 65,535 vertices", () => {
      // 40,000 triangles over 20,001 vertices each: two of them cross 65,535 and must stay readable.
      const merged = mergeParts([{ geometry: grid(40_000) }, { geometry: grid(40_000) }], {
        label: "wide",
        preserve: ["normal", "uv"],
      });

      expect(merged.getAttribute("position").count).toBe(80_004);
      const wide = merged.getIndex();
      expect(wide?.array).toBeInstanceOf(Uint32Array);
      expect(wide?.getX((wide?.count ?? 1) - 1)).toBeGreaterThan(65_535);
    });

    it("should split a material group that crosses the vertex budget, each part under it", () => {
      const hull = surface("hull");
      const root = new Group();
      // 400 pieces of 204 vertices: one 81,600-vertex group under a 4,000-vertex budget is twenty-two
      // meshes, and every one of them still draws with the game's own material.
      const perPart = grid(200).getAttribute("position").count;
      for (let part = 0; part < 400; part += 1) {
        const mesh = new Mesh(grid(200), hull);
        mesh.position.set(part, 0, 0);
        root.add(mesh);
      }

      const merged = mergeByMaterial(root, { label: "yard", maxGroupVertices: 4_000 });

      expect(merged.length).toBeGreaterThan(1);
      for (const mesh of merged) {
        expect(mesh.material).toBe(hull);
        // Every part lands in a group whole: one over-budget group is not an excuse to drop a part.
        expect(mesh.geometry.getAttribute("position").count).toBeLessThanOrEqual(4_000);
        expect(mesh.geometry.getAttribute("position").count % perPart).toBe(0);
      }
      expect(
        merged.reduce(
          (total, mesh) => total + (mesh.geometry.getAttribute("position").count ?? 0),
          0,
        ),
      ).toBe(400 * perPart);
    });

    it("should not expand an instanced shape past 2,048 triangles, however small the group is", () => {
      const hull = surface("hull");
      const root = new Group();
      const small = new InstancedMesh(new BoxGeometry(1, 1, 1), hull, 2);
      const detailed = new InstancedMesh(grid(2_400), hull, 2);
      small.setMatrixAt(0, new Matrix4());
      small.setMatrixAt(1, new Matrix4().makeTranslation(5, 0, 0));
      detailed.setMatrixAt(0, new Matrix4().makeTranslation(0, 0, 5));
      detailed.setMatrixAt(1, new Matrix4().makeTranslation(5, 0, 5));
      root.add(small, detailed);

      const merged = mergeByMaterial(root, {
        expandInstancedUnderTriangles: 1_000_000,
        label: "props",
      });

      // The 12-triangle box repeats into the merge; the 2,400-triangle prop stays one instanced draw.
      const kept = merged.filter((mesh) => mesh instanceof InstancedMesh);
      expect(kept).toHaveLength(1);
      expect((kept[0] as InstancedMesh).geometry.index?.count).toBe(2_400 * 3);
      const baked = merged.filter((mesh) => !(mesh instanceof InstancedMesh));
      expect(baked).toHaveLength(1);
      expect(baked[0]?.geometry.getAttribute("position").count).toBe(2 * 24);
    });
  });
});

/**
 * The one shape a streamed world chunk is made of, and the arithmetic the fused copy has to match:
 * a quantized interleaved `normal` inside a shared stride, a quantized `uv`, a placement with scale
 * (which its normals must survive as unit normals), one indexed part among a non-indexed one so the
 * group de-indexes, and enough vertices to cross 65,535 so the merged index must widen.
 */
function cookedChunk(vertices = 24_000): IMergePart[] {
  const buffer = new InterleavedBuffer(new Int8Array(vertices * 4), 4);
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    const at = vertex * 4;
    buffer.array[at] = (vertex % 127) - 63;
    buffer.array[at + 1] = ((vertex * 7) % 127) - 63;
    buffer.array[at + 2] = ((vertex * 13) % 127) - 63;
  }
  const positions = new Float32Array(vertices * 3);
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    positions[vertex * 3] = (vertex % 97) * 0.25;
    positions[vertex * 3 + 1] = ((vertex * 3) % 89) * 0.5;
    positions[vertex * 3 + 2] = ((vertex * 11) % 83) * 0.125;
  }
  const indexed = new BufferGeometry();
  indexed.setAttribute("position", new BufferAttribute(positions, 3));
  indexed.setAttribute("normal", new InterleavedBufferAttribute(buffer, 3, 0, true));
  indexed.setAttribute(
    "uv",
    new BufferAttribute(
      new Uint16Array(vertices * 2).map((_, at) => at % 4096),
      2,
      true,
    ),
  );
  const indices = new Uint32Array(vertices);
  for (let vertex = 0; vertex < vertices; vertex += 1) indices[vertex] = vertex;
  indexed.setIndex(new BufferAttribute(indices, 1));

  const flat = new BufferGeometry();
  flat.setAttribute("position", new BufferAttribute(positions.slice(0, 9), 3));
  flat.setAttribute(
    "normal",
    new BufferAttribute(new Int8Array([63, -63, 0, 12, 90, -33, -7, 5, 111]), 3, true),
  );
  flat.setAttribute("uv", new BufferAttribute(new Uint16Array([0, 0, 4096, 0, 0, 4096]), 2, true));

  return [
    {
      color: 0x2f8b1a,
      geometry: indexed,
      matrix: new Matrix4().compose(
        new Vector3(3, -1, 0.5),
        new Quaternion().setFromEuler(new Euler(0.3, 1.1, -0.2)),
        new Vector3(10.27, 10.27, 10.27),
      ),
    },
    {
      color: 0x8b2f1a,
      geometry: flat,
      matrix: new Matrix4().makeTranslation(4, 0, 0),
    },
  ];
}

/**
 * `mergeParts` before PRD-478 AC-1 read every component through three's own accessors: `clone()`,
 * `applyMatrix4`, `toNonIndexed()`, a de-quantizing copy, then `mergeGeometries`. The fused copy
 * reads the same arrays directly, and this is the proof it lands on the same bytes — the fixture
 * above against the three path it replaced, attribute for attribute and element for element.
 */
function throughThree(
  parts: readonly IMergePart[],
  preserve: readonly ("uv" | "normal")[],
): BufferGeometry {
  const deindex = !parts.every((part) => part.geometry.index !== null);
  const keep = new Set<string>(["position", ...preserve]);
  const flattened = parts.map((part) => {
    const placed = part.geometry.clone();
    if (part.matrix !== undefined) placed.applyMatrix4(part.matrix);
    const flat = deindex && placed.index !== null ? placed.toNonIndexed() : placed;
    for (const name of Object.keys(flat.attributes))
      if (!keep.has(name)) flat.deleteAttribute(name);
    flat.morphAttributes = {};
    for (const name of Object.keys(flat.attributes)) {
      const attribute = flat.getAttribute(name);
      if (
        attribute.array instanceof Float32Array &&
        !attribute.normalized &&
        !("isInterleavedBufferAttribute" in attribute)
      )
        continue;
      const values = new Float32Array(attribute.count * attribute.itemSize);
      for (let index = 0; index < attribute.count; index += 1)
        for (let component = 0; component < attribute.itemSize; component += 1)
          values[index * attribute.itemSize + component] = attribute.getComponent(index, component);
      flat.setAttribute(name, new BufferAttribute(values, attribute.itemSize));
    }
    if (part.color === undefined) return flat;
    const tone = new Color(part.color);
    const position = flat.getAttribute("position");
    const painted = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      painted[vertex * 3] = tone.r;
      painted[vertex * 3 + 1] = tone.g;
      painted[vertex * 3 + 2] = tone.b;
    }
    flat.setAttribute("color", new BufferAttribute(painted, 3));
    return flat;
  });
  const merged = mergeGeometries(flattened, false);
  for (const geometry of flattened) geometry.dispose();
  if (merged === null) throw new Error("three refused the fixture merge.");
  if (!preserve.includes("normal")) merged.computeVertexNormals();
  return merged;
}

function sameBytes(merged: BufferGeometry, expected: BufferGeometry): void {
  expect(Object.keys(merged.attributes)).toEqual(Object.keys(expected.attributes));
  for (const name of Object.keys(expected.attributes)) {
    const got = merged.getAttribute(name);
    const want = expected.getAttribute(name);
    expect(got.array.constructor, `${name} array type`).toBe(want.array.constructor);
    expect(got.itemSize, `${name} itemSize`).toBe(want.itemSize);
    expect(got.count, `${name} count`).toBe(want.count);
    expect(Array.from(got.array as Float32Array), `${name} values`).toEqual(
      Array.from(want.array as Float32Array),
    );
  }
  const index = merged.getIndex();
  const expectedIndex = expected.getIndex();
  if (expectedIndex === null) expect(index).toBeNull();
  else {
    expect(index?.array.constructor, "index array type").toBe(expectedIndex.array.constructor);
    expect(Array.from(index?.array ?? []), "index values").toEqual(Array.from(expectedIndex.array));
  }
}

describe("mergeParts — the fused copy against the three path it replaced (PRD-478 AC-1)", () => {
  it("should hold the same bytes for a de-indexing quantized interleaved chunk, colour included", () => {
    const preserve = ["normal", "uv"] as const;
    const expected = throughThree(cookedChunk(), preserve);
    // The three path de-interleaves every channel it clones, loudly; the fused path reads the array.
    // This is the assertion that makes the comparison below a comparison of the two, not of three
    // with itself.
    const log = vi.spyOn(console, "log");
    const merged = mergeParts(cookedChunk(), { label: "chunk", preserve });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    expect(merged.getIndex()).toBeNull();
    sameBytes(merged, expected);
  });

  it("should hold the same bytes with the position-only default, which recomputes the normals", () => {
    sameBytes(mergeParts(cookedChunk(), { label: "chunk" }), throughThree(cookedChunk(), []));
  });

  it("should hold the same bytes for an all-indexed group whose merge crosses 65,535 vertices", () => {
    const wide = cookedChunk(40_000);
    const parts = [wide[0] as IMergePart, { ...(wide[0] as IMergePart), matrix: undefined }];
    const preserve = ["normal", "uv"] as const;
    const merged = mergeParts(parts, { label: "wide", preserve });
    expect(merged.getAttribute("position").count).toBeGreaterThan(65_535);
    expect(merged.getIndex()?.array).toBeInstanceOf(Uint32Array);
    sameBytes(merged, throughThree(parts, preserve));
  });

  it("should read one source geometry once per part, leaving its interleaved buffer untouched", () => {
    const part = cookedChunk()[0];
    const geometry = part?.geometry as BufferGeometry;
    const normal = geometry.getAttribute("normal") as InterleavedBufferAttribute;
    const before = Array.from(normal.data.array);
    mergeParts([part as IMergePart], { label: "untouched", preserve: ["normal", "uv"] });
    expect(Array.from(normal.data.array)).toEqual(before);
  });
});
