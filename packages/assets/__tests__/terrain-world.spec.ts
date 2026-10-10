import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Document, type Buffer as GltfBuffer, type Material, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { type ITerrainState, Terrain, bakeTerrain, bakeWorldPackage } from "@threenative/terrain";
import { PNG } from "pngjs";
import { type Group, InstancedMesh, Mesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookTerrainWorld } from "../src/world/terrain-world.js";

// GLTFLoader reads the global `self` while it parses. Node has none.
Object.assign(globalThis, { self: globalThis });

/** A real evaluated terrain. The fixed seed fixes every scatter position. */
function evaluatedTerrain(): ITerrainState {
  const state = new Terrain({ resolution: 33, seed: 73, size: 256 })
    .scatter({ id: "firs", asset: "fir", count: 40, minDistance: 3 })
    .evaluate();
  if (state.instances.length === 0) throw new Error("fixture terrain has no placements");
  return state;
}

function io(): NodeIO {
  return new NodeIO().registerExtensions([...ALL_EXTENSIONS]);
}

/** One triangle with normals and UVs. Its vertices sit in the unit square on the XZ plane. */
function triangle(doc: Document, buffer: GltfBuffer, material: Material) {
  return doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
        .setBuffer(buffer),
    )
    .setAttribute(
      "NORMAL",
      doc
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]))
        .setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      doc
        .createAccessor()
        .setType("VEC2")
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer),
    )
    .setIndices(
      doc
        .createAccessor()
        .setType("SCALAR")
        .setArray(new Uint16Array([0, 1, 2]))
        .setBuffer(buffer),
    )
    .setMaterial(material);
}

/** A static species with one mesh of one primitive. */
async function simpleSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const mesh = doc
    .createMesh("rock")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("rock")));
  scene.addChild(doc.createNode("rockNode").setMesh(mesh));
  return io().writeBinary(doc);
}

/** A static species with two meshes. The trunk is textured and sits 5 m along +X in its node. */
async function twoMeshSpecies(): Promise<{ glb: Uint8Array; png: Uint8Array }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const texture = doc.createTexture("bark").setImage(png).setMimeType("image/png");
  const bark = doc.createMaterial("bark").setBaseColorTexture(texture);
  const trunk = doc.createMesh("trunk").addPrimitive(triangle(doc, buffer, bark));
  const crown = doc
    .createMesh("crown")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("leaf")));
  scene.addChild(doc.createNode("trunkNode").setMesh(trunk).setTranslation([5, 0, 0]));
  scene.addChild(doc.createNode("crownNode").setMesh(crown));
  return { glb: await io().writeBinary(doc), png };
}

/** A static species whose one textured mesh is reused by two nodes, at X=0 and X=5. */
async function sharedMeshSpecies(): Promise<{ glb: Uint8Array; png: Uint8Array }> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const texture = doc.createTexture("shared").setImage(png).setMimeType("image/png");
  const material = doc.createMaterial("shared").setBaseColorTexture(texture);
  const mesh = doc.createMesh("shared").addPrimitive(triangle(doc, buffer, material));
  scene.addChild(doc.createNode("node0").setMesh(mesh).setTranslation([0, 0, 0]));
  scene.addChild(doc.createNode("node1").setMesh(mesh).setTranslation([5, 0, 0]));
  return { glb: await io().writeBinary(doc), png };
}

/** A species with a skin. The cook must refuse it by name. */
async function skinnedSpecies(): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("Scene");
  const joint = doc.createNode("root");
  const skin = doc.createSkin("rig").addJoint(joint);
  const mesh = doc
    .createMesh("rigged")
    .addPrimitive(triangle(doc, buffer, doc.createMaterial("rigged")));
  scene.addChild(joint);
  scene.addChild(doc.createNode("rigged").setMesh(mesh).setSkin(skin));
  return io().writeBinary(doc);
}

/** Parses a GLB with the vanilla three loader, the same reader a game uses. */
function loadWorld(glb: Uint8Array): Promise<Group> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(glb.slice().buffer, "", (gltf) => resolve(gltf.scene), reject);
  });
}

describe("cookTerrainWorld", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "strata-terrain-world-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the real terrain chunks and one instancing node for the species", async () => {
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    });

    const lod0 = bakeTerrain(state, { lodSteps: [1] }).lods[0];
    assert.ok(lod0);
    const chunks = lod0.chunks;
    expect(chunks.length).toBeGreaterThan(0);
    const scene = await loadWorld(result.worldGlb);
    const terrainNames: string[] = [];
    const instanceCounts: number[] = [];
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanceCounts.push(object.count);
      else if (object instanceof Mesh && object.name.startsWith("terrain_"))
        terrainNames.push(object.name);
    });
    expect(terrainNames.sort()).toEqual(chunks.map((chunk) => chunk.name).sort());
    expect(instanceCounts).toEqual([state.instances.length]);

    for (const file of [
      "world.glb",
      "world.json",
      "heightmap.u16",
      "placements.bin",
      "splat.rgba",
      "models/fir.glb",
    ]) {
      expect((await stat(path.join(dir, file))).size).toBeGreaterThan(0);
    }
  });

  it("writes the splat and placement files exactly as bakeWorldPackage bakes them", async () => {
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    });

    const baked = bakeWorldPackage(state, { assets: result.manifest.assets });
    const splat = new Uint8Array(await readFile(path.join(dir, "splat.rgba")));
    expect(splat.some((byte) => byte !== 0)).toBe(true);
    expect(splat).toEqual(baked.files["splat.rgba"]);
    expect(new Uint8Array(await readFile(path.join(dir, "placements.bin")))).toEqual(
      baked.files["placements.bin"],
    );
  });

  it("keeps one instancing node per species when its source has two meshes", async () => {
    const state = evaluatedTerrain();
    const species = await twoMeshSpecies();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    expect(result.instancedMeshCount).toBe(1);
    expect(result.placementCounts.fir).toBe(state.instances.length);
    const scene = await loadWorld(result.worldGlb);
    const instanceCounts: number[] = [];
    scene.traverse((object) => {
      if (object instanceof InstancedMesh) instanceCounts.push(object.count);
    });
    // One InstancedMesh per primitive; the two source meshes flatten into one glTF mesh.
    expect(instanceCounts).toEqual([state.instances.length, state.instances.length]);
  });

  it("keeps source translation, texture bytes and vertex attributes when it flattens a species", async () => {
    const species = await twoMeshSpecies();
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    // The trunk's child translation becomes model-space bounds: x runs from 0 to 6.
    const fir = result.manifest.assets.fir;
    assert.ok(fir);
    expect(fir.bounds).toEqual({ min: [0, 0, 0], max: [6, 0, 1] });

    const doc = await io().readBinary(result.worldGlb);
    const textured = doc
      .getRoot()
      .listMaterials()
      .find((m) => m.getBaseColorTexture() !== null);
    assert.ok(textured);
    const baseColorTexture = textured.getBaseColorTexture();
    assert.ok(baseColorTexture);
    const image = baseColorTexture.getImage();
    assert.ok(image);
    expect(new Uint8Array(image)).toEqual(new Uint8Array(species.png));
    const instancedNode = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getExtension("EXT_mesh_gpu_instancing") !== null);
    assert.ok(instancedNode);
    const instancedMesh = instancedNode.getMesh();
    assert.ok(instancedMesh);
    const primitive = instancedMesh.listPrimitives().find((p) => p.getMaterial() === textured);
    assert.ok(primitive);
    const positionAttr = primitive.getAttribute("POSITION");
    assert.ok(positionAttr);
    const positions = positionAttr.getArray() as Float32Array;
    expect(Math.min(...positions.filter((_, i) => i % 3 === 0))).toBe(5);
    expect(primitive.getAttribute("NORMAL")).not.toBeNull();
    expect(primitive.getAttribute("TEXCOORD_0")).not.toBeNull();
    expect(primitive.getMode()).toBe(4); // TRIANGLES
  });

  it("flattens one shared mesh at each node's own transform", async () => {
    const species = await sharedMeshSpecies();
    const state = evaluatedTerrain();
    const result = await cookTerrainWorld({
      state,
      species: { fir: { glb: species.glb } },
      out: dir,
    });

    expect(result.instancedMeshCount).toBe(1);
    expect(result.placementCounts.fir).toBe(state.instances.length);

    const doc = await io().readBinary(result.worldGlb);
    const instancedNode = doc
      .getRoot()
      .listNodes()
      .find((node) => node.getExtension("EXT_mesh_gpu_instancing") !== null);
    assert.ok(instancedNode);
    const instancedMesh = instancedNode.getMesh();
    assert.ok(instancedMesh);
    const primitives = instancedMesh.listPrimitives();
    // Both source nodes survive as their own primitive: one translated to x=0, one to x=5.
    expect(primitives.length).toBe(2);
    const minX = primitives.map((p) => {
      const positionAttr = p.getAttribute("POSITION");
      assert.ok(positionAttr);
      return Math.min(...(positionAttr.getArray() as Float32Array).filter((_, i) => i % 3 === 0));
    });
    expect(minX.sort((a, b) => a - b)).toEqual([0, 5]);

    const textured = doc
      .getRoot()
      .listMaterials()
      .find((m) => m.getBaseColorTexture() !== null);
    assert.ok(textured);
    const baseColorTexture = textured.getBaseColorTexture();
    assert.ok(baseColorTexture);
    const image = baseColorTexture.getImage();
    assert.ok(image);
    expect(new Uint8Array(image)).toEqual(new Uint8Array(species.png));
  });

  it("writes explicit LOD files and authored bounds without changing them", async () => {
    const near = await simpleSpecies();
    const lod = await simpleSpecies();
    const result = await cookTerrainWorld({
      state: evaluatedTerrain(),
      species: {
        fir: {
          glb: near,
          bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
          lods: [{ distance: 45, glb: lod }],
        },
      },
      out: dir,
    });

    expect(result.manifest.assets.fir).toMatchObject({
      glb: "models/fir.glb",
      bounds: { min: [-1, 0, -1], max: [1, 2, 1] },
      lods: [{ distance: 45, glb: "models/fir_lod1.glb" }],
    });
    expect(new Uint8Array(await readFile(path.join(dir, "models", "fir.glb")))).toEqual(near);
    expect(new Uint8Array(await readFile(path.join(dir, "models", "fir_lod1.glb")))).toEqual(lod);
  });

  it("fails before writing when a placement names a species that is not in the map", async () => {
    await expect(
      cookTerrainWorld({ state: evaluatedTerrain(), species: {}, out: dir }),
    ).rejects.toThrow(/species 'fir'/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("fails before writing when a placement has a non-finite position", async () => {
    const state = evaluatedTerrain();
    const [first, ...rest] = state.instances;
    assert.ok(first);
    const broken = {
      ...state,
      instances: [
        {
          ...first,
          position: [Number.NaN, first.position[1], first.position[2]] as [number, number, number],
        },
        ...rest,
      ],
    };
    await expect(
      cookTerrainWorld({
        state: broken,
        species: { fir: { glb: await simpleSpecies() } },
        out: dir,
      }),
    ).rejects.toThrow(/non-finite/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("refuses a skinned species by name before writing", async () => {
    await expect(
      cookTerrainWorld({
        state: evaluatedTerrain(),
        species: { fir: { glb: await skinnedSpecies() } },
        out: dir,
      }),
    ).rejects.toThrow(/species 'fir' .*skin/);
    await expect(stat(path.join(dir, "world.glb"))).rejects.toThrow();
  });

  it("names a placement that is mirrored in Z as a contact failure", async () => {
    const state = evaluatedTerrain();
    const spacing = state.size / (state.resolution - 1);
    // A deterministic north-to-south ramp makes mirroring change the ground by half the map size.
    state.height.set(
      Array.from(state.height, (_, i) => Math.floor(i / state.resolution) * spacing),
    );
    const first = state.instances[0];
    assert.ok(first);
    const item = {
      ...first,
      position: [0, state.size / 4, -state.size / 4] as [number, number, number],
    };
    const mirrored = {
      ...item,
      position: [item.position[0], item.position[1], -item.position[2]] as [number, number, number],
    };
    const error = await cookTerrainWorld({
      state: { ...state, instances: [mirrored] },
      species: { fir: { glb: await simpleSpecies() } },
      out: dir,
    }).then(
      () => null,
      (caught: Error) => caught,
    );
    expect(error?.message).toContain(
      `Placement '${item.id}' of species 'fir' contact check failed`,
    );
    expect(error?.message).toContain("mirrored-Z");
  });

  it("keeps the node count constant from 1 000 to 10 000 placements", async () => {
    const base = evaluatedTerrain();
    const withPlacements = (count: number): ITerrainState => ({
      ...base,
      instances: Array.from({ length: count }, (_, i) => {
        const placement = base.instances[i % base.instances.length];
        assert.ok(placement);
        return { ...placement, id: `fir_${i}` };
      }),
    });
    const species = { fir: { glb: await simpleSpecies() } };

    const small = await cookTerrainWorld({
      state: withPlacements(1_000),
      species,
      out: path.join(dir, "1k"),
    });
    const large = await cookTerrainWorld({
      state: withPlacements(10_000),
      species,
      out: path.join(dir, "10k"),
    });

    expect(large.nodeCount).toBe(small.nodeCount);
    expect(small.instancedMeshCount).toBe(1);
    expect(large.instancedMeshCount).toBe(1);
    expect(large.placementCounts.fir).toBe(10_000);
  });
});
