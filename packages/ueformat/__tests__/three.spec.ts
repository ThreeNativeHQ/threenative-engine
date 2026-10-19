import { BufferGeometry, Group, LOD, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";

import {
  type IUEModelLOD,
  UEFormatError,
  UEFormatLoader,
  createThreeGeometry,
  createThreeObject,
  parseUEModel,
} from "../src/index.js";
import { modelFile, richModelBody, staticModelBody, triangleLod } from "./fixture-builder.js";

function requiredLod(model: ReturnType<typeof parseUEModel>): IUEModelLOD {
  const lod = model.lods[0];
  if (!lod) throw new Error("fixture model has no LOD");
  return lod;
}

function assertArrayClose(
  actual: ArrayLike<number>,
  expected: readonly number[],
  epsilon = 1e-6,
): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, index) => {
    // An out-of-range index must fail the comparison, not silently compare a default.
    expect(Math.abs((actual[index] ?? Number.NaN) - value)).toBeLessThanOrEqual(epsilon);
  });
}

describe("createThreeGeometry", () => {
  it("converts Unreal coordinates, scale, winding, normals, tangents, and UVs", () => {
    const lod = requiredLod(parseUEModel(modelFile({ body: richModelBody() })));
    const geometry = createThreeGeometry(lod);

    assertArrayClose(geometry.getAttribute("position").array, [0, 0, 0, 0, 0, -1, 1, 0, 0]);
    expect(Array.from(geometry.index?.array ?? [])).toEqual([0, 2, 1]);
    expect(Array.from(geometry.getAttribute("normal").array.slice(0, 3))).toEqual([0, 1, 0]);
    expect(Array.from(geometry.getAttribute("tangent").array.slice(0, 4))).toEqual([0, 0, -1, -1]);
    expect(Array.from(geometry.getAttribute("uv").array)).toEqual([0, 1, 1, 1, 0, 0]);
  });

  it("creates vertex colors, material groups, morph attributes, and skin attributes", () => {
    const lod = requiredLod(parseUEModel(modelFile({ body: richModelBody() })));
    const geometry = createThreeGeometry(lod);

    expect(Array.from(geometry.getAttribute("color").array.slice(0, 6))).toEqual([
      1, 0, 0, 0, 1, 0,
    ]);
    expect(geometry.groups).toEqual([{ start: 0, count: 3, materialIndex: 0 }]);
    assertArrayClose(
      geometry.morphAttributes.position?.[0]?.array ?? [],
      [0, 0, 0, 0, 0, 0, 0, 0.05, 0],
    );
    expect(Array.from(geometry.getAttribute("skinIndex").array.slice(0, 8))).toEqual([
      0, 0, 0, 0, 1, 0, 0, 0,
    ]);
    expect(Array.from(geometry.getAttribute("skinWeight").array.slice(0, 8))).toEqual([
      1, 0, 0, 0, 0.75, 0.25, 0, 0,
    ]);
  });

  it("can preserve Unreal coordinates and original winding", () => {
    const lod = requiredLod(parseUEModel(modelFile({ body: staticModelBody() })));
    const geometry = createThreeGeometry(lod, {
      coordinateSystem: "unreal-z-up",
      unitScale: 1,
      flipV: false,
    });

    expect(Array.from(geometry.getAttribute("position").array)).toEqual([
      0, 0, 0, 100, 0, 0, 0, 100, 0,
    ]);
    expect(Array.from(geometry.index?.array ?? [])).toEqual([0, 1, 2]);
    expect(Array.from(geometry.getAttribute("uv").array)).toEqual([0, 0, 1, 0, 0, 1]);
  });

  it("rejects out-of-range mesh indices before Three.js construction", () => {
    const lod = requiredLod(parseUEModel(modelFile({ body: staticModelBody() })));
    lod.indices[2] = 999;
    expect(() => createThreeGeometry(lod)).toThrow(UEFormatError);
  });

  it("rejects malformed material sections", () => {
    const lod = requiredLod(parseUEModel(modelFile({ body: staticModelBody() })));
    const section = lod.materials[0];
    if (!section) throw new Error("fixture LOD has no material section");
    section.numFaces = 2;
    expect(() => createThreeGeometry(lod)).toThrow(UEFormatError);
  });
});

describe("createThreeObject", () => {
  it("creates a named Group and calls the material factory for a single LOD", () => {
    const model = parseUEModel(modelFile({ body: staticModelBody(), objectName: "SM_Table" }));
    const seen: string[] = [];
    const object = createThreeObject(model, {
      materialFactory(slot) {
        seen.push(slot.materialName);
        return new MeshBasicMaterial({ name: slot.materialName });
      },
    });

    expect(object).toBeInstanceOf(Group);
    expect(object.name).toBe("SM_Table");
    expect(object.children[0]).toBeInstanceOf(Mesh);
    expect(seen).toEqual(["M_Table"]);
    expect(object.userData.ue.header.objectPath).toBe("/Game/Test/SM_Test.SM_Test");
  });

  it("falls back to three.js's GLTFLoader-default material when no factory is passed", () => {
    const model = parseUEModel(modelFile({ body: staticModelBody() }));
    const object = createThreeObject(model);
    const mesh = object.children[0] as Mesh;

    expect(mesh.material).toBeInstanceOf(MeshStandardMaterial);
    expect((mesh.material as MeshStandardMaterial).name).toBe("M_Table");
  });

  it("creates THREE.LOD with caller-selected distances", () => {
    const body = staticModelBody([triangleLod("LOD0"), triangleLod("LOD1")]);
    const object = createThreeObject(parseUEModel(modelFile({ body })), { lodDistances: [0, 25] });

    expect(object).toBeInstanceOf(LOD);
    const lodObject = object as LOD;
    expect(lodObject.levels.map((level) => level.distance)).toEqual([0, 25]);
    expect(lodObject.levels.map((level) => level.object.name)).toEqual(["LOD0", "LOD1"]);
  });

  it("extracts transformed collision BufferGeometry for Rapier-style consumers", () => {
    const object = createThreeObject(parseUEModel(modelFile({ body: richModelBody() })));
    const collision = object.userData.ue.collisionGeometries[0] as BufferGeometry;

    expect(collision).toBeInstanceOf(BufferGeometry);
    expect(collision.name).toBe("Box");
    assertArrayClose(collision.getAttribute("position").array, [0, 0, 0, 0, 0, -0.1, 0.1, 0, 0]);
    expect(Array.from(collision.index?.array ?? [])).toEqual([0, 2, 1]);
  });
});

describe("INVALID_GEOMETRY", () => {
  /** A fresh parsed LOD per case, so one case's edit cannot leak into the next. */
  const freshLod = () =>
    structuredClone(requiredLod(parseUEModel(modelFile({ body: staticModelBody() }))));
  const freshRichLod = () =>
    structuredClone(requiredLod(parseUEModel(modelFile({ body: richModelBody() }))));
  const first = <T>(items: readonly T[]): T => {
    const [item] = items;
    if (item === undefined) throw new Error("fixture has no entry to corrupt");
    return item;
  };
  const codeOf = (build: () => unknown): string | undefined => {
    try {
      build();
      return undefined;
    } catch (error) {
      return error instanceof UEFormatError ? error.code : String(error);
    }
  };

  // One case per rejection in three-adapter.ts, so each branch names the input that reaches it.
  const faults: [string, () => unknown][] = [
    ["a unit scale of zero", () => createThreeGeometry(freshLod(), { unitScale: 0 })],
    [
      "a LOD with no vertices",
      () => {
        const lod = freshLod();
        lod.vertices = [];
        return createThreeGeometry(lod);
      },
    ],
    [
      "an index count that is not a multiple of three",
      () => {
        const lod = freshLod();
        lod.indices = [0, 1];
        return createThreeGeometry(lod);
      },
    ],
    [
      "an index past the last vertex",
      () => {
        const lod = freshLod();
        lod.indices[0] = 99;
        return createThreeGeometry(lod);
      },
    ],
    [
      "a normal count that disagrees with the vertex count",
      () => {
        const lod = freshLod();
        lod.normals = lod.normals.slice(0, 2);
        return createThreeGeometry(lod);
      },
    ],
    [
      "a UV channel of the wrong length",
      () => {
        const lod = freshLod();
        const channel = first(lod.texCoords);
        channel.uvs = channel.uvs.slice(0, 2);
        return createThreeGeometry(lod);
      },
    ],
    [
      "a vertex-color channel of the wrong length",
      () => {
        const lod = freshLod();
        const channel = first(lod.vertexColors);
        channel.colors = channel.colors.slice(0, 2);
        return createThreeGeometry(lod);
      },
    ],
    [
      "a material section that runs past the index buffer",
      () => {
        const lod = freshLod();
        first(lod.materials).numFaces = 2;
        return createThreeGeometry(lod);
      },
    ],
    [
      "a morph delta that names a missing vertex",
      () => {
        const lod = freshRichLod();
        first(first(lod.morphTargets).deltas).vertexIndex = 99;
        return createThreeGeometry(lod);
      },
    ],
    [
      "a skin weight that names a missing vertex",
      () => {
        const lod = freshRichLod();
        first(lod.weights).vertexIndex = 99;
        return createThreeGeometry(lod);
      },
    ],
    [
      "a negative LOD distance",
      () =>
        createThreeObject(
          parseUEModel(
            modelFile({ body: staticModelBody([triangleLod("LOD0"), triangleLod("LOD1")]) }),
          ),
          { lodDistances: [0, -1] },
        ),
    ],
  ];

  it.each(faults)("rejects %s", (_label, build) => {
    expect(codeOf(build)).toBe("INVALID_GEOMETRY");
  });
});

describe("UEFormatLoader", () => {
  it("parse returns a Three.js object", () => {
    const loader = new UEFormatLoader(undefined, { three: { unitScale: 0.01 } });
    const object = loader.parse(modelFile({ body: staticModelBody() }));
    expect(object).toBeInstanceOf(Group);
    expect(object.children.length).toBe(1);
  });
});
