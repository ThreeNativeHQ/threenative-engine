import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Mesh, PerspectiveCamera, TorusKnotGeometry } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { modelPass } from "../../assets/src/passes/model.js";
import {
  ClusteredMesh,
  VirtualGeometryPlugin,
  updateClusteredMeshes,
} from "../src/clustered-mesh.js";

// The seam: a `.glb` that went through the pipeline with `assets.models.virtual` on comes back as a
// `ClusteredMesh`, and one that did not comes back as an ordinary `Mesh`. No runtime switch decides
// which — the file does.

async function sourceGlb(): Promise<Buffer> {
  const geometry = new TorusKnotGeometry(1, 0.4, 512, 64);
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const attribute = (name: "normal" | "position") =>
    document
      .createAccessor()
      .setType("VEC3")
      .setArray(Float32Array.from(geometry.attributes[name]?.array ?? []))
      .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", attribute("position"))
    .setAttribute("NORMAL", attribute("normal"))
    .setIndices(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(Uint32Array.from(geometry.index?.array ?? []))
        .setBuffer(buffer),
    )
    .setMaterial(document.createMaterial("rock"));
  scene.addChild(
    document.createNode("face").setMesh(document.createMesh("face").addPrimitive(primitive)),
  );
  return Buffer.from(await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
}

async function compiled(virtual: boolean): Promise<ArrayBuffer> {
  const result = await modelPass(
    virtual ? { virtual: { minSourceTriangles: 1024 } } : { virtual: "none" },
  ).apply(await sourceGlb(), "face.glb");
  if (Buffer.isBuffer(result)) throw new Error("model pass returned an unchanged buffer");
  const copy = new ArrayBuffer(result.buffer.byteLength);
  new Uint8Array(copy).set(result.buffer);
  return copy;
}

async function load(data: ArrayBuffer, plugin: boolean): Promise<Mesh[]> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (plugin) loader.register((parser) => new VirtualGeometryPlugin(parser as never) as never);
  const gltf = await new Promise<{ scene: { traverse(cb: (o: object) => void): void } }>(
    (resolve, reject) => loader.parse(data, "", resolve as never, reject),
  );
  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if ((object as Mesh).isMesh === true) meshes.push(object as Mesh);
  });
  return meshes;
}

describe("the virtual-geometry loader seam", () => {
  it("returns a ClusteredMesh for a primitive that carries the bake", async () => {
    const meshes = await load(await compiled(true), true);

    expect(meshes).toHaveLength(1);
    const mesh = meshes[0] as ClusteredMesh;
    expect(mesh).toBeInstanceOf(ClusteredMesh);
    expect(mesh.name).toBe("face");
    expect(mesh.table.ranges.length / 2).toBeGreaterThan(100);
    expect(mesh.table.groups?.length).toBe(mesh.table.ranges.length);
    expect(mesh.material).not.toBeNull();
  }, 300_000);

  it("prunes the loaded mesh's cut by the view, with the edges the bake wrote", async () => {
    // `clusterGroups` was baked and read by nothing until a cut could descend by it. A file that has
    // it, and a walk that found its children from it, is the whole seam this PRD adds.
    const meshes = await load(await compiled(true), true);
    const mesh = meshes[0] as ClusteredMesh;

    expect(mesh.viewCullReport).toBe("on");

    // Close enough that the body spills out of the frame: a cut pruned by the view only differs
    // from the oracle when the view does not hold the whole mesh.
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    camera.position.set(0, 0, 1.2);
    camera.updateMatrixWorld(true);
    const pruned = updateClusteredMeshes(mesh.parent as never, camera, 1080);

    mesh.viewCull = false;
    const whole = updateClusteredMeshes(mesh.parent as never, camera, 1080);
    expect(mesh.viewCullReport).toBe("off (viewCull = false)");
    expect(pruned).toBeLessThan(whole);
    expect(pruned).toBeGreaterThan(0);
  }, 300_000);

  it("returns an ordinary Mesh when the file carries no bake", async () => {
    const meshes = await load(await compiled(false), true);

    expect(meshes).toHaveLength(1);
    expect(meshes[0]).toBeInstanceOf(Mesh);
    expect(meshes[0]).not.toBeInstanceOf(ClusteredMesh);
  }, 300_000);

  it("draws the source triangles for a reader that never registered the plugin", async () => {
    const meshes = await load(await compiled(true), false);

    expect(meshes[0]).not.toBeInstanceOf(ClusteredMesh);
    expect((meshes[0]?.geometry.getIndex()?.count ?? 0) / 3).toBe(512 * 64 * 2);
  }, 300_000);

  it("names the asset when the payload is from an older bake", async () => {
    const compiledBytes = await compiled(true);
    // Strip the two spheres a bake before PRD-282 did not write. A file like this really existed:
    // one stale `dist` produced it, and the loader's failure was a crash inside `GLTFLoader`.
    const bytes = new Uint8Array(compiledBytes);
    const jsonLength = new DataView(compiledBytes).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
      meshes: { primitives: { extensions?: Record<string, Record<string, unknown>> }[] }[];
    };
    const primitive = json.meshes[0]?.primitives[0];
    const def = primitive?.extensions?.TN_virtual_geometry;
    if (primitive?.extensions === undefined || def === undefined)
      throw new Error("the compiled fixture carries no payload");
    const { clusterSourceSpheres: _dropped, ...withoutSpheres } = def;
    primitive.extensions.TN_virtual_geometry = withoutSpheres;
    const replacement = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(replacement.length / 4) * 4).fill(0x20);
    padded.set(replacement);
    const rebuilt = new Uint8Array(20 + padded.length + (bytes.length - 20 - jsonLength));
    rebuilt.set(bytes.subarray(0, 20));
    rebuilt.set(padded, 20);
    rebuilt.set(bytes.subarray(20 + jsonLength), 20 + padded.length);
    new DataView(rebuilt.buffer).setUint32(8, rebuilt.length, true);
    new DataView(rebuilt.buffer).setUint32(12, padded.length, true);

    const failure = await load(rebuilt.buffer, true).then(
      () => "it loaded",
      (error: unknown) => (error as Error).message,
    );
    expect(failure).toMatch(/TN_VIRTUAL_GEOMETRY_INCOMPLETE/u);
  }, 300_000);

  it("cuts the loaded mesh from one call a frame", async () => {
    const meshes = await load(await compiled(true), true);
    const mesh = meshes[0] as ClusteredMesh;
    const scene = mesh.parent;
    if (scene === null) throw new Error("the swapped mesh kept no parent");
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);

    camera.position.set(0, 0, 40);
    const far = updateClusteredMeshes(scene, camera, 1080);
    camera.position.set(0, 0, 3);
    const near = updateClusteredMeshes(scene, camera, 1080);

    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(512 * 64 * 2);
  }, 300_000);
});
