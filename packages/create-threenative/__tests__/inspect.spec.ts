import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  formatAssetInspection,
  inspectAsset,
  inspectCommand,
  parseInspectArgs,
} from "../src/inspect.js";

const temporaryDirectories: string[] = [];

function concatenate(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function makeGlb(document: Record<string, unknown>, binary: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = (json.byteLength + 3) & ~3;
  const binaryLength = (binary.byteLength + 3) & ~3;
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

function viewOf(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function inspectionFixture(scale = 1): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 4].map((value) => value * scale));
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2]);
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const weights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const inverseBindMatrices = new Float32Array(32);
  inverseBindMatrices[0] = 1;
  inverseBindMatrices[5] = 1;
  inverseBindMatrices[10] = 1;
  inverseBindMatrices[15] = 1;
  inverseBindMatrices[16] = 1;
  inverseBindMatrices[21] = 1;
  inverseBindMatrices[26] = 1;
  inverseBindMatrices[31] = 1;
  const animationInput = new Float32Array([0, 1]);
  const animationOutput = new Float32Array([0, 0, 0, 0, 0, 0]);
  const binary = concatenate(
    viewOf(positions),
    viewOf(normals),
    viewOf(indices),
    new Uint8Array(2),
    viewOf(joints),
    viewOf(weights),
    viewOf(inverseBindMatrices),
    viewOf(animationInput),
    viewOf(animationOutput),
  );
  const document = {
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        max: [2, 3, 4],
        min: [0, 0, 0],
        type: "VEC3",
      },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
      { bufferView: 3, componentType: 5121, count: 3, type: "VEC4" },
      { bufferView: 4, componentType: 5126, count: 3, type: "VEC4" },
      { bufferView: 5, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 6, componentType: 5126, count: 2, max: [1], min: [0], type: "SCALAR" },
      { bufferView: 7, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [
      {
        channels: [{ sampler: 0, target: { node: 1, path: "translation" } }],
        name: "Walk",
        samplers: [{ input: 6, interpolation: "LINEAR", output: 7 }],
      },
    ],
    asset: {
      extras: { tnOrigin: "procedural" },
      generator: "ThreeNative inspect test",
      version: "2.0",
    },
    bufferViews: [
      { buffer: 0, byteLength: 36, byteOffset: 0, target: 34962 },
      { buffer: 0, byteLength: 36, byteOffset: 36, target: 34962 },
      { buffer: 0, byteLength: 6, byteOffset: 72, target: 34963 },
      { buffer: 0, byteLength: 12, byteOffset: 80, target: 34962 },
      { buffer: 0, byteLength: 48, byteOffset: 92, target: 34962 },
      { buffer: 0, byteLength: 128, byteOffset: 140 },
      { buffer: 0, byteLength: 8, byteOffset: 268 },
      { buffer: 0, byteLength: 24, byteOffset: 276 },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    materials: [{ name: "FixtureMaterial", pbrMetallicRoughness: { roughnessFactor: 0.5 } }],
    meshes: [
      {
        name: "FixtureMesh",
        primitives: [
          {
            attributes: { JOINTS_0: 3, NORMAL: 1, POSITION: 0, WEIGHTS_0: 4 },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    nodes: [
      { children: [1, 2], mesh: 0, name: "FixtureRoot", skin: 0 },
      { name: "Hip" },
      { name: "Hand", translation: [0, 1, 0] },
    ],
    scene: 0,
    scenes: [{ nodes: [0] }],
    skins: [{ inverseBindMatrices: 5, joints: [1, 2], skeleton: 1 }],
  };
  return makeGlb(document, binary);
}

async function temporaryAsset(name: string, contents: Uint8Array | string): Promise<string> {
  const directory = await makeTempDir("threenative-inspect-");
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  await writeFile(file, contents);
  return file;
}

async function temporaryExternalGltf(resourceUri = "external-fixture.bin"): Promise<string> {
  const directory = await makeTempDir("threenative-inspect-external-");
  temporaryDirectories.push(directory);
  const file = path.join(directory, "external-fixture.gltf");
  const binary = new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 3]);
  await writeFile(
    file,
    JSON.stringify({
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          max: [2, 3, 0],
          min: [0, 0, 0],
          type: "VEC3",
        },
      ],
      asset: { generator: "ThreeNative inspect external test", version: "2.0" },
      bufferViews: [{ buffer: 0, byteLength: binary.byteLength }],
      buffers: [{ byteLength: binary.byteLength, uri: resourceUri }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scene: 0,
      scenes: [{ nodes: [0] }],
    }),
  );
  await writeFile(path.join(directory, decodeURIComponent(resourceUri)), viewOf(binary));
  return file;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("asset inspection", () => {
  it("loads a glTF fixture with an adjacent external binary buffer", async () => {
    const file = await temporaryExternalGltf();

    const result = await inspectAsset(file);

    expect(result.bounds).toEqual({
      center: { x: 1, y: 1.5, z: 0 },
      size: { x: 2, y: 3, z: 0 },
    });
    expect(result.meshes).toBe(1);
  });

  it("loads an adjacent external binary buffer with a percent-encoded filename", async () => {
    const file = await temporaryExternalGltf("mesh%20data.bin");

    const result = await inspectAsset(file);

    expect(result.bounds).toEqual({
      center: { x: 1, y: 1.5, z: 0 },
      size: { x: 2, y: 3, z: 0 },
    });
    expect(result.meshes).toBe(1);
  });

  it("reports bounds, clips, bones and resource counts from a GLB fixture", async () => {
    const file = await temporaryAsset("animated-fixture.glb", inspectionFixture());

    const result = await inspectAsset(file);

    expect(result.bounds).toEqual({
      center: { x: 1, y: 1.5, z: 2 },
      size: { x: 2, y: 3, z: 4 },
    });
    expect(result.clips).toEqual(["Walk"]);
    expect(result.bones).toEqual(["Hip", "Hand"]);
    expect(result.meshes).toBe(1);
    expect(result.materials).toBe(1);
    expect(result.textures).toBe(0);
    expect(formatAssetInspection(result)).toContain("2.000 x 3.000 x 4.000");
  });

  it("prints JSON with every human-readable field", async () => {
    const file = await temporaryAsset("json-fixture.glb", inspectionFixture());
    let output = "";

    await inspectCommand([file, "--json"], (text) => {
      output += text;
    });

    const result = JSON.parse(output) as Record<string, unknown>;
    expect(result).toMatchObject({
      bones: ["Hip", "Hand"],
      clips: ["Walk"],
      file: "json-fixture.glb",
      forwardAxis: { axis: "Z", basis: "longest geometry axis", direction: "unknown" },
      materials: 1,
      meshes: 1,
      textures: 0,
      units: { label: "likely metres", longestAxis: 4 },
    });
    expect(result.bounds).toEqual({
      center: { x: 1, y: 1.5, z: 2 },
      size: { x: 2, y: 3, z: 4 },
    });
  });

  /**
   * A 56-metre building is not centimetres.
   *
   * The heuristic called anything longer than ten units centimetres, so importing a real Unreal
   * level — a 31.9 x 56.3 x 31.9 m office, correct in metres — reported "likely centimetres" and
   * told an agent to divide it by a hundred. Between a large scene in metres and a prop in
   * centimetres there is a band where the longest axis genuinely cannot tell them apart, and
   * saying so is the honest answer; guessing confidently is what did the damage.
   */
  it.each([
    [1, "likely metres", "a 4-unit prop is metres"],
    [14, "ambiguous", "a 56-unit scene could be either"],
    [60, "likely centimetres", "a 240-unit asset is centimetres"],
  ])("labels a %s-scaled asset %s — %s", async (scale, label) => {
    const file = await temporaryAsset(`units-${scale}.glb`, inspectionFixture(scale));

    const result = await inspectAsset(file);

    expect(result.units.label).toBe(label);
  });

  it.each([
    ["missing.glb", undefined, "missing.glb"],
    ["notes.txt", "not a glTF asset", "notes.txt"],
    ["corrupt.glb", new Uint8Array([0, 1, 2, 3]), "corrupt.glb"],
  ])("throws and names the file for %s", async (name, contents, expectedName) => {
    let file: string;
    if (contents === undefined) {
      const directory = await makeTempDir("threenative-inspect-missing-");
      temporaryDirectories.push(directory);
      file = path.join(directory, name);
    } else {
      file = await temporaryAsset(name, contents);
    }

    await expect(inspectAsset(file)).rejects.toThrow(expectedName);
  });

  it("throws and names the glTF when an adjacent external resource is missing", async () => {
    const file = await temporaryExternalGltf();
    await rm(file.replace(/\.gltf$/, ".bin"));

    await expect(inspectAsset(file)).rejects.toThrow("external-fixture.gltf");
  });

  it("accepts the JSON flag in either argument position", () => {
    expect(parseInspectArgs(["--json", "asset.glb"])).toEqual({ file: "asset.glb", json: true });
    expect(parseInspectArgs(["asset.glb", "--json"])).toEqual({ file: "asset.glb", json: true });
  });

  it("reports grounding, triangles, material names and asset extras", async () => {
    const file = await temporaryAsset("grounded.glb", inspectionFixture());
    const result = await inspectAsset(file);
    expect(result).toMatchObject({
      assetExtras: { tnOrigin: "procedural" },
      materialNames: ["FixtureMaterial"],
      maxY: 3,
      minY: 0,
      triangles: 1,
    });
    expect(formatAssetInspection(result)).toContain("minY 0.000");
  });

  it("is a public threenative command with its own help", async () => {
    const cli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/threenative.js",
    );
    const run = promisify(execFile);
    const general = await run(process.execPath, [cli, "--help"]);
    expect(general.stdout).toContain("inspect");
    const help = await run(process.execPath, [cli, "inspect", "--help"]);
    expect(help.stdout).toContain("--manifest");
    expect(help.stdout).toContain("threenative inspect <file.glb>");
    const glb = await temporaryAsset("cli.glb", inspectionFixture());
    const report = await run(process.execPath, [cli, "inspect", glb, "--json"]);
    expect(JSON.parse(report.stdout)).toMatchObject({ minY: 0, triangles: 1 });
  });

  it("parses --manifest and --frame with repeated --sample", () => {
    expect(parseInspectArgs(["--manifest", "--project", "game"])).toEqual({
      json: false,
      manifest: { project: "game" },
    });
    expect(
      parseInspectArgs([
        "--frame",
        "a.png",
        "--sample",
        "hero:0.5,0.5",
        "--sample",
        "sky:0.1,0.1",
        "--json",
      ]),
    ).toEqual({ frame: { file: "a.png", samples: ["hero:0.5,0.5", "sky:0.1,0.1"] }, json: true });
    expect(() => parseInspectArgs(["--frame"])).toThrow("--frame needs a value");
    expect(() => parseInspectArgs([])).toThrow("Usage");
  });

  it("audits assets against the manifest: unlisted, missing, archives, duplicates", async () => {
    const project = await makeTempDir("threenative-inspect-manifest-");
    temporaryDirectories.push(project);
    await mkdir(path.join(project, "assets", "downloads"), { recursive: true });
    await mkdir(path.join(project, "public"), { recursive: true });
    await writeFile(path.join(project, "assets", "a.glb"), "same");
    await writeFile(path.join(project, "assets", "downloads", "b.glb"), "same");
    await writeFile(path.join(project, "assets", "downloads", "pack.zip"), "zip");
    await writeFile(
      path.join(project, "public", "assets.manifest.json"),
      JSON.stringify({ entries: { "a.glb": {}, "gone.glb": {} }, version: 1 }),
    );

    let output = "";
    process.exitCode = undefined;
    await inspectCommand(["--manifest", "--project", project, "--json"], (text) => {
      output += text;
    });

    expect(JSON.parse(output)).toMatchObject({
      duplicates: [["a.glb", "downloads/b.glb"]],
      leftoverArchives: ["downloads/pack.zip"],
      missingFiles: ["gone.glb"],
      pass: false,
      unlisted: ["downloads/b.glb"],
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it("passes a project whose manifest lists every asset", async () => {
    const project = await makeTempDir("threenative-inspect-manifest-ok-");
    temporaryDirectories.push(project);
    await mkdir(path.join(project, "assets"), { recursive: true });
    await mkdir(path.join(project, "public"), { recursive: true });
    await writeFile(path.join(project, "assets", "a.glb"), "x");
    await writeFile(
      path.join(project, "public", "assets.manifest.json"),
      JSON.stringify({ entries: { "a.glb": {} }, version: 1 }),
    );
    const { auditAssetManifest } = await import("../src/inspect-project.js");
    expect((await auditAssetManifest(project)).pass).toBe(true);
  });

  /** A real PNG: two colour bands, left red and right blue, RGB with a Sub-filtered row. */
  function png(
    width: number,
    height: number,
    colour: (x: number) => [number, number, number],
  ): Buffer {
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
      rows[y * (width * 3 + 1)] = 1;
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = colour(x);
        const [pr, pg, pb] = x === 0 ? [0, 0, 0] : colour(x - 1);
        const at = y * (width * 3 + 1) + 1 + x * 3;
        rows[at] = (r - pr) & 255;
        rows[at + 1] = (g - pg) & 255;
        rows[at + 2] = (b - pb) & 255;
      }
    }
    const chunk = (type: string, body: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
      return Buffer.concat([head, body, tail]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  it("samples a frame's colours and passes a drawn frame", async () => {
    const file = await temporaryAsset(
      "frame.png",
      png(8, 8, (x) => (x < 4 ? [255, 0, 0] : [0, 0, 255])),
    );
    let output = "";
    await inspectCommand(
      ["--frame", file, "--sample", "left:0.1,0.5", "--sample", "right:0.9,0.5", "--json"],
      (text) => {
        output += text;
      },
    );
    expect(JSON.parse(output)).toMatchObject({
      blank: false,
      dark: false,
      height: 8,
      pass: true,
      samples: [
        { hex: "#ff0000", role: "left" },
        { hex: "#0000ff", role: "right" },
      ],
      width: 8,
    });
  });

  it("fails a blank frame and a black frame", async () => {
    const { inspectFrame } = await import("../src/inspect-project.js");
    const flat = await temporaryAsset(
      "flat.png",
      png(8, 8, () => [90, 90, 90]),
    );
    const black = await temporaryAsset(
      "black.png",
      png(8, 8, () => [0, 0, 0]),
    );
    expect(await inspectFrame(flat, [])).toMatchObject({ blank: true, pass: false });
    expect(await inspectFrame(black, [])).toMatchObject({ blank: true, dark: true, pass: false });
  });
});
