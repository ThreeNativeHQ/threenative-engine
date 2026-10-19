import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRDracoMeshCompression,
  KHRMaterialsUnlit,
} from "@gltf-transform/extensions";
import { texturePass } from "@threenative/assets";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { PNG } from "pngjs";
import { BoxGeometry, type BufferGeometry, TorusGeometry } from "three";

const draco = createRequire(import.meta.url)("draco3dgltf") as {
  createEncoderModule(): Promise<unknown>;
  createDecoderModule(): Promise<unknown>;
};
export const MODEL_NAMES = ["meshopt", "draco"] as const;

function checker(a: readonly number[], b: readonly number[]): Buffer {
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const rgb = ((x >> 3) + (y >> 3)) % 2 === 0 ? a : b;
      png.data.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 255], (y * 32 + x) * 4);
    }
  return PNG.sync.write(png);
}

function specimen(name: string, geometry: BufferGeometry, image: Buffer): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const material = document
    .createMaterial(name)
    .setBaseColorTexture(document.createTexture(name).setMimeType("image/png").setImage(image));
  material.setExtension(
    "KHR_materials_unlit",
    document.createExtension(KHRMaterialsUnlit).createUnlit(),
  );
  const primitive = document.createPrimitive().setMaterial(material);
  for (const [attribute, semantic, type] of [
    ["position", "POSITION", "VEC3"],
    ["normal", "NORMAL", "VEC3"],
    ["uv", "TEXCOORD_0", "VEC2"],
  ] as const) {
    primitive.setAttribute(
      semantic,
      document
        .createAccessor()
        .setType(type)
        .setArray(Float32Array.from(geometry.getAttribute(attribute).array))
        .setBuffer(buffer),
    );
  }
  if (!geometry.index) throw new Error("Fixture requires indexed geometry");
  primitive.setIndices(
    document
      .createAccessor()
      .setType("SCALAR")
      .setArray(Uint16Array.from(geometry.index.array))
      .setBuffer(buffer),
  );
  geometry.dispose();
  const node = document
    .createNode(`${name}-animated`)
    .setMesh(document.createMesh(name).addPrimitive(primitive));
  document.createScene().addChild(node);
  const sampler = document
    .createAnimationSampler()
    .setInterpolation("LINEAR")
    .setInput(
      document
        .createAccessor()
        .setType("SCALAR")
        .setArray(new Float32Array([0, 1, 2]))
        .setBuffer(buffer),
    )
    .setOutput(
      document
        .createAccessor()
        .setType("VEC4")
        .setArray(new Float32Array([0, 0, 0, 1, 0, Math.sin(0.6), 0, Math.cos(0.6), 0, 0, 0, 1]))
        .setBuffer(buffer),
    );
  document
    .createAnimation("turn")
    .addSampler(sampler)
    .addChannel(
      document
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath("rotation")
        .setSampler(sampler),
    );
  return document;
}

export async function fixtureReader(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.decoder": MeshoptDecoder,
    "draco3d.decoder": await draco.createDecoderModule(),
  });
}

/** Real compressed inputs from the installed encoders; all source art is authored here. */
export async function generateNativeAssetFixture(source: string): Promise<Buffer> {
  await mkdir(source, { recursive: true });
  await MeshoptEncoder.ready;
  for (const name of MODEL_NAMES) {
    const document = specimen(
      name,
      name === "meshopt"
        ? new BoxGeometry(1.4, 1.4, 1.4, 2, 2, 2)
        : new TorusGeometry(0.7, 0.27, 12, 32),
      name === "meshopt"
        ? checker([20, 210, 225], [240, 85, 35])
        : checker([235, 45, 170], [245, 205, 35]),
    );
    if (name === "meshopt")
      document
        .createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    else document.createExtension(KHRDracoMeshCompression).setRequired(true);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "draco3d.encoder": await draco.createEncoderModule(),
    });
    await writeFile(path.join(source, `${name}.glb`), await io.writeBinary(document));
  }
  const png = checker([95, 210, 60], [85, 100, 235]);
  await writeFile(path.join(source, "checker.png"), png);
  const result = await texturePass({ overrides: [{ glob: "*.png", codec: "uastc" }] }).apply(
    png,
    "checker.png",
  );
  if (Buffer.isBuffer(result) || result.outputExtension !== ".ktx2")
    throw new Error("Fixture encoder did not produce KTX2");
  return result.buffer;
}

/** Decoded payload measurements, not download sizes or claimed GPU savings. */
export async function inspectFixtureModel(file: string) {
  const bytes = await readFile(file);
  const document = await (await fixtureReader()).read(file);
  const root = document.getRoot();
  return {
    encodedBytes: bytes.length,
    extensions: root.listExtensionsUsed().map((extension) => extension.extensionName),
    triangles: root
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0),
    positions: root
      .listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .flatMap((primitive) => Array.from(primitive.getAttribute("POSITION")?.getArray() ?? [])),
    decodedGeometryBytes: root
      .listAccessors()
      .reduce((sum, accessor) => sum + (accessor.getArray()?.byteLength ?? 0), 0),
    images: root
      .listTextures()
      .map((texture) => PNG.sync.read(Buffer.from(texture.getImage() ?? []))),
    animation: root
      .listAnimations()
      .flatMap((animation) => animation.listSamplers())
      .map((sampler) => ({
        input: Array.from(sampler.getInput()?.getArray() ?? []),
        output: Array.from(sampler.getOutput()?.getArray() ?? []),
      })),
  };
}
