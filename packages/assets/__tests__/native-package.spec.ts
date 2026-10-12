import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { compileAssets } from "../src/index.js";
import {
  type INativePackageEntry,
  NATIVE_PACKAGE_FORMAT_VERSION,
  NATIVE_PACKAGE_HEADER_SIZE,
  NativeDecoderBits,
  NativeEntryKind,
  NativePackageError,
  WGPU_TEXTURE_FORMAT_RGBA8_UNORM,
  readNativePackageManifest,
  writeNativePackage,
} from "../src/native-package.js";

/**
 * Parses the C++ header that specifies the format, so the constants can never drift from it.
 * This reads only the declarations the writer mirrors; a value that moves in `package.h` fails.
 */
function parseHeader(text: string): {
  decoders: Record<string, number>;
  entryKinds: Record<string, number>;
  formatVersion: number;
  headerSize: number;
} {
  const scalar = (name: string): number => {
    const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text);
    if (match === null) throw new Error(`package.h is missing ${name}`);
    return Number(match[1]);
  };
  const enumBody = (name: string): string => {
    const match = new RegExp(`enum(?:\\s+class)?\\s+${name}[^{]*\\{([^}]*)\\}`).exec(text);
    if (match === null) throw new Error(`package.h is missing enum ${name}`);
    return match[1] ?? "";
  };
  const entryKinds: Record<string, number> = {};
  for (const match of enumBody("EntryKind").matchAll(/(\w+)\s*=\s*(\d+)/g)) {
    entryKinds[match[1] as string] = Number(match[2]);
  }
  const decoders: Record<string, number> = {};
  for (const match of enumBody("DecoderBits").matchAll(/kDecoder(\w+)\s*=\s*1u\s*<<\s*(\d+)/g)) {
    decoders[(match[1] as string).toLowerCase()] = 1 << Number(match[2]);
  }
  return {
    decoders,
    entryKinds,
    formatVersion: scalar("kPackageFormatVersion"),
    headerSize: scalar("kPackageHeaderSize"),
  };
}

const PACKAGE_HEADER = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "runtime-native/src/engine/assets/package.h",
);

/** The exact inputs `package_writer_fixture.cpp` writes, in the same order. */
function referenceEntries(): INativePackageEntry[] {
  const geometry = Uint8Array.from({ length: 16 }, (_value, index) => index);
  const texture = Buffer.alloc(12);
  texture.writeUInt32LE(2, 0);
  texture.writeUInt32LE(2, 4);
  texture.writeUInt32LE(WGPU_TEXTURE_FORMAT_RGBA8_UNORM, 8);
  const pixels = Uint8Array.from({ length: 2 * 2 * 4 }, (_value, index) => 255 - index);
  return [
    {
      data: geometry,
      dependencies: [],
      kind: NativeEntryKind.Buffer,
      name: "geometry/positions",
      uploadSize: 16,
    },
    {
      data: Uint8Array.from([1, 2, 3, 4]),
      dependencies: [0, 2],
      kind: NativeEntryKind.Scene,
      name: "scenes/main",
      uploadSize: 0,
    },
    {
      data: Buffer.concat([texture, pixels]),
      dependencies: [0],
      kind: NativeEntryKind.Texture,
      name: "textures/albedo",
      uploadSize: 16,
    },
  ];
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof NativePackageError) return error.code;
    throw error;
  }
  throw new Error("expected readNativePackageManifest to refuse");
}

/** One entry whose dependency list names index 0, itself, the way a damaged file would. */
function selfDependencyBytes(): Buffer {
  const name = Buffer.from("self", "utf8");
  const data = Buffer.from([1, 2, 3, 4]);
  const tableSize = 2 + name.length + 2 + 4 + 8 + 8 + 8 + 32 + 4 + 4;
  const dataStart = NATIVE_PACKAGE_HEADER_SIZE + tableSize;
  const bytes = Buffer.alloc(dataStart + data.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes.write("TNPK", 0, "latin1");
  view.setUint32(4, NATIVE_PACKAGE_FORMAT_VERSION, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, BigInt(tableSize), true);
  let at = NATIVE_PACKAGE_HEADER_SIZE;
  view.setUint16(at, name.length, true);
  at += 2;
  name.copy(bytes, at);
  at += name.length;
  view.setUint16(at, NativeEntryKind.Buffer, true);
  at += 2;
  view.setUint32(at, 0, true);
  at += 4;
  view.setBigUint64(at, BigInt(dataStart), true);
  at += 8;
  view.setBigUint64(at, BigInt(data.length), true);
  at += 8;
  view.setBigUint64(at, 0n, true);
  at += 8;
  createHash("sha256").update(data).digest().copy(bytes, at);
  at += 32;
  view.setUint32(at, 1, true);
  at += 4;
  view.setUint32(at, 0, true);
  at += 4;
  data.copy(bytes, at);
  return bytes;
}

describe("package.h parity", () => {
  it("every mirrored constant equals the value in the C++ header", async () => {
    const header = parseHeader(await readFile(PACKAGE_HEADER, "utf8"));

    expect(NATIVE_PACKAGE_FORMAT_VERSION).toBe(header.formatVersion);
    expect(NATIVE_PACKAGE_HEADER_SIZE).toBe(header.headerSize);
    for (const [name, value] of Object.entries(header.entryKinds)) {
      expect(NativeEntryKind[name as keyof typeof NativeEntryKind]).toBe(value);
    }
    for (const [name, value] of Object.entries(header.decoders)) {
      expect(NativeDecoderBits[name as keyof typeof NativeDecoderBits]).toBe(value);
    }
  });
});

describe("writeNativePackage validation", () => {
  const entry = (overrides: Partial<INativePackageEntry> = {}): INativePackageEntry => ({
    data: Uint8Array.from([1, 2, 3, 4]),
    kind: NativeEntryKind.Buffer,
    name: "ok",
    ...overrides,
  });

  const invalid = (entries: readonly INativePackageEntry[]): string => {
    try {
      writeNativePackage(entries);
    } catch (error) {
      if (error instanceof NativePackageError) return `${error.code}: ${error.detail}`;
      throw error;
    }
    throw new Error("expected writeNativePackage to refuse");
  };

  it("refuses a name longer than u16 can hold", () => {
    const message = invalid([entry({ name: "n".repeat(65536) })]);
    expect(message).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(message).toMatch(/name/u);
  });

  it("refuses a dependency index past the entry count", () => {
    const message = invalid([entry(), entry({ dependencies: [2] })]);
    expect(message).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(message).toMatch(/depend/u);
  });

  it("refuses a self-referencing dependency", () => {
    const message = invalid([entry(), entry({ dependencies: [1] })]);
    expect(message).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(message).toMatch(/itself/u);
  });

  it("refuses a GPU buffer (uploadSize above 0) whose length is not a multiple of four", () => {
    const message = invalid([entry({ data: Uint8Array.from([1, 2, 3]), uploadSize: 3 })]);
    expect(message).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(message).toMatch(/GPU buffer/u);
    // A CPU buffer (uploadSize 0) is read by a decoder, never uploaded, so it keeps any length.
    expect(() =>
      writeNativePackage([entry({ data: Uint8Array.from([1, 2, 3]), uploadSize: 0 })]),
    ).not.toThrow();
  });

  it("refuses a negative or non-integer uploadSize", () => {
    expect(invalid([entry({ uploadSize: -1 })])).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(invalid([entry({ uploadSize: 1.5 })])).toContain("TN_NATIVE_PACKAGE_INVALID");
  });

  it("refuses a u32 field out of range", () => {
    expect(invalid([entry({ decoders: 2 ** 32 })])).toContain("TN_NATIVE_PACKAGE_INVALID");
    expect(invalid([entry({ kind: 70000 })])).toContain("TN_NATIVE_PACKAGE_INVALID");
  });
});

describe("writeNativePackage", () => {
  it("round-trips the header and table through the reader", () => {
    const bytes = writeNativePackage(referenceEntries());
    const manifest = readNativePackageManifest(bytes);

    expect(manifest.version).toBe(1);
    expect(manifest.entries.map((entry) => entry.name)).toEqual([
      "geometry/positions",
      "scenes/main",
      "textures/albedo",
    ]);
    expect(manifest.entries.map((entry) => entry.kind)).toEqual([1, 6, 2]);
    expect(manifest.entries.map((entry) => entry.dependencies)).toEqual([[], [0, 2], [0]]);
    expect(manifest.entries.map((entry) => entry.size)).toEqual([16, 4, 28]);
    expect(manifest.entries.map((entry) => entry.uploadSize)).toEqual([16, 0, 16]);

    const positions = referenceEntries()[0]?.data ?? new Uint8Array();
    const digest = new Uint8Array(createHash("sha256").update(positions).digest());
    expect(manifest.entries[0]?.hash).toEqual(digest);
    // Data sits right after the table, in entry order.
    const tableEnd = manifest.entries[0]?.offset ?? 0;
    expect(manifest.entries[1]?.offset).toBe(tableEnd + 16);
  });

  it("produces byte-identical output to the C++ reference writer", async () => {
    const reference = await readFile(path.join(import.meta.dirname, "fixtures/reference.tnpk"));
    const written = Buffer.from(writeNativePackage(referenceEntries()));

    expect(written.length).toBe(reference.length);
    expect(written.equals(reference)).toBe(true);
  });

  it("refuses truncation, magic, version and out-of-range data with the C++ codes", async () => {
    const reference = await readFile(path.join(import.meta.dirname, "fixtures/reference.tnpk"));
    const view = (bytes: Buffer): DataView =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(codeOf(() => readNativePackageManifest(reference.subarray(0, 10)))).toBe(
      "TN_PACKAGE_TRUNCATED",
    );

    const magic = Buffer.from(reference);
    magic[0] = 0x58;
    expect(codeOf(() => readNativePackageManifest(magic))).toBe("TN_PACKAGE_MAGIC");

    const version = Buffer.from(reference);
    view(version).setUint32(4, 2, true);
    expect(codeOf(() => readNativePackageManifest(version))).toBe("TN_PACKAGE_VERSION");

    const tableRunsPastEnd = Buffer.from(reference);
    view(tableRunsPastEnd).setBigUint64(16, BigInt(reference.length), true);
    expect(codeOf(() => readNativePackageManifest(tableRunsPastEnd))).toBe("TN_PACKAGE_TRUNCATED");

    const range = Buffer.from(reference);
    // The first entry's offset field: name length and name precede kind, decoders and offset.
    const nameLength = view(range).getUint16(24, true);
    view(range).setBigUint64(24 + 2 + nameLength + 2 + 4, BigInt(reference.length), true);
    expect(codeOf(() => readNativePackageManifest(range))).toBe("TN_PACKAGE_RANGE");

    // Hand-encoded, not `writeNativePackage`: the writer now refuses a self-dependency itself, and
    // this pins that the reader keeps refusing one arriving as untrusted bytes.
    expect(codeOf(() => readNativePackageManifest(selfDependencyBytes()))).toBe(
      "TN_PACKAGE_DEPENDENCY",
    );
  });
});

describe("assets.nativePackage", () => {
  it("writes one Texture entry per RGBA8 PNG and one Buffer entry per binary buffer", async () => {
    const root = await makeTempDir("threenative-native-package-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 4, width: 4 }));
    await writeFile(path.join(root, "assets", "data.bin"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));

    // Decoder-free and model-free: the PNG ships as a PNG, so it is a legal v1 texture.
    const first = await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
    const manifest = readNativePackageManifest(output);

    expect(manifest.entries.map((entry) => entry.name)).toEqual(["data.bin", "rock.png"]);
    expect(manifest.entries[0]?.kind).toBe(NativeEntryKind.Buffer);
    expect(manifest.entries[0]?.size).toBe(8);
    expect(manifest.entries[1]?.kind).toBe(NativeEntryKind.Texture);
    // 12-byte header plus 4x4 RGBA pixels.
    expect(manifest.entries[1]?.size).toBe(12 + 4 * 4 * 4);
    expect(manifest.entries[1]?.uploadSize).toBe(4 * 4 * 4);
    expect(first.receipt?.outputs.some((entry) => entry.path === "native/assets.tnpk")).toBe(true);

    // A cache hit rebuilds the package from the outputs on disk and still lists it.
    const second = await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    expect(second.written).toBe(0);
    expect(second.receipt?.outputs.some((entry) => entry.path === "native/assets.tnpk")).toBe(true);
    expect(
      (await readFile(path.join(root, "public", "native", "assets.tnpk"))).equals(output),
    ).toBe(true);
  });

  it("writes a model as a Scene entry and a JPEG as a decoded RGBA8 Texture entry", async () => {
    const root = await makeTempDir("threenative-native-package-scene-");
    await mkdir(path.join(root, "assets"));
    // A 2x1 baseline JPEG (pure red, pure blue) and a minimal glTF binary with one node.
    const { encode } = await import("jpeg-js");
    const jpeg = encode(
      { data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), height: 1, width: 2 },
      100,
    ).data;
    await writeFile(path.join(root, "assets", "sky.jpg"), jpeg);
    const json = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        nodes: [{ name: "n" }],
        scene: 0,
        scenes: [{ nodes: [0] }],
      }).padEnd(84, " "),
    );
    const glb = Buffer.alloc(12 + 8 + json.length);
    glb.write("glTF", 0, "ascii");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(glb.length, 8);
    glb.writeUInt32LE(json.length, 12);
    glb.write("JSON", 16, "ascii");
    json.copy(glb, 20);
    await writeFile(path.join(root, "assets", "model.glb"), glb);

    await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const manifest = readNativePackageManifest(
      await readFile(path.join(root, "public", "native", "assets.tnpk")),
    );
    // The cooked model enters once, by logical path, never again under its web-root URL.
    expect(manifest.entries.map((entry) => entry.name)).toEqual(["model.glb", "sky.jpg"]);
    const byName = Object.fromEntries(manifest.entries.map((entry) => [entry.name, entry]));
    expect(byName["model.glb"]?.kind).toBe(NativeEntryKind.Scene);
    expect(byName["model.glb"]?.size).toBe(glb.length);
    expect(byName["sky.jpg"]?.kind).toBe(NativeEntryKind.Texture);
    // 12-byte header plus 2x1 RGBA pixels.
    expect(byName["sky.jpg"]?.size).toBe(12 + 2 * 1 * 4);
  });

  it("ships audio as a Buffer entry of its encoded bytes, at any length", async () => {
    const root = await makeTempDir("threenative-native-package-audio-");
    await mkdir(path.join(root, "assets"));
    // WebAudio decodes the bytes; no GPU upload, so the buffer alignment rule does not apply.
    await writeFile(path.join(root, "assets", "beep.ogg"), Buffer.from("OggS!"));

    await compileAssets({
      config: { audio: "none", models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
    const [entry] = readNativePackageManifest(output).entries;
    expect(entry?.name).toBe("beep.ogg");
    expect(entry?.kind).toBe(NativeEntryKind.Buffer);
    expect(entry?.size).toBe(5);
  });

  it("keeps a CPU-decoded buffer at its exact length and declares no GPU upload", async () => {
    const root = await makeTempDir("threenative-native-package-cpu-buffer-");
    await mkdir(path.join(root, "assets"));
    // An HDRLoader parses the .hdr in JS: 7 bytes is a legal entry, and nothing uploads it.
    await writeFile(path.join(root, "assets", "sky.hdr"), Buffer.from("#?RGBE\n"));

    await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
    const [entry] = readNativePackageManifest(output).entries;
    expect(entry?.name).toBe("sky.hdr");
    expect(entry?.kind).toBe(NativeEntryKind.Buffer);
    expect(entry?.size).toBe(7);
    expect(entry?.uploadSize).toBe(0);
  });

  it("cooks a JPEG into an RGBA8 Texture entry, as it does a PNG", async () => {
    const root = await makeTempDir("threenative-native-package-jpeg-");
    await mkdir(path.join(root, "assets"));
    const { encode } = await import("jpeg-js");
    const pixels = Buffer.alloc(8 * 4 * 4, 200);
    await writeFile(
      path.join(root, "assets", "panel.jpg"),
      encode({ data: pixels, height: 4, width: 8 }, 90).data,
    );

    await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
    const [entry] = readNativePackageManifest(output).entries;
    expect(entry?.name).toBe("panel.jpg");
    expect(entry?.kind).toBe(NativeEntryKind.Texture);
    expect(entry?.size).toBe(12 + 8 * 4 * 4);
    expect(entry?.uploadSize).toBe(8 * 4 * 4);
  });

  it("packages a web root laid out like Midway's under the URLs the game requests", async () => {
    // No source directory, every file hand-placed in public/assets and requested as `/assets/…`:
    // the web serves those URLs from the web root, so the package names them the same way.
    const root = await makeTempDir("threenative-native-package-web-root-");
    const web = path.join(root, "public", "assets");
    await mkdir(path.join(web, "cockpit"), { recursive: true });
    await writeFile(path.join(web, "dawn-sky.hdr"), Buffer.from("#?RGBE\n"));
    const { encode } = await import("jpeg-js");
    await writeFile(
      path.join(web, "cockpit", "panel.jpg"),
      encode({ data: Buffer.alloc(4 * 2 * 4, 120), height: 2, width: 4 }, 90).data,
    );
    const glb = Buffer.alloc(12);
    glb.write("glTF", 0, "latin1");
    glb.writeUInt32LE(2, 4);
    glb.writeUInt32LE(12, 8);
    await writeFile(path.join(web, "ship.glb"), glb);
    await writeFile(path.join(web, ".DS_Store"), Buffer.from("finder"));

    for (let run = 0; run < 2; run++) {
      await compileAssets({
        config: { models: "none", nativePackage: true, textures: "none" },
        cwd: root,
      });
      const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
      const entries = readNativePackageManifest(output).entries.map((entry) => [
        entry.name,
        entry.kind,
        entry.size,
        entry.uploadSize,
      ]);
      // The second run must not package the first run's package or its receipt.
      expect(entries, `run ${String(run)}`).toEqual([
        ["/assets/cockpit/panel.jpg", NativeEntryKind.Texture, 12 + 4 * 2 * 4, 4 * 2 * 4],
        ["/assets/dawn-sky.hdr", NativeEntryKind.Buffer, 7, 0],
        ["/assets/ship.glb", NativeEntryKind.Scene, 12, 0],
      ]);
    }
  });

  it("packages cooked entries by logical path and hand-placed files by URL, never a cook output twice", async () => {
    const root = await makeTempDir("threenative-native-package-mixed-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "data.bin"), Buffer.from([1, 2, 3]));
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(path.join(root, "public", "icon.png"), rgbaPng({ height: 2, width: 2 }));

    await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    const output = await readFile(path.join(root, "public", "native", "assets.tnpk"));
    expect(readNativePackageManifest(output).entries.map((entry) => entry.name)).toEqual([
      "/icon.png",
      "data.bin",
    ]);
  });

  it("removes a stale package when a recook has no v1 entry", async () => {
    const root = await makeTempDir("threenative-native-package-empty-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "data.bin"), Buffer.alloc(0));
    // The fixed path the bake owns whenever nativePackage is on, left by an earlier run whose
    // receipt is gone. An empty buffer is not a legal v1 entry, so this run emits none.
    const target = path.join(root, "public", "native", "assets.tnpk");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from("stale package left by an earlier run"));

    const result = await compileAssets({
      config: { models: "none", nativePackage: true, textures: "none" },
      cwd: root,
    });
    await expect(readFile(target)).rejects.toThrow();
    expect(result.receipt?.outputs.some((entry) => entry.path === "native/assets.tnpk")).toBe(
      false,
    );
  });

  it("writes nothing when the option is off", async () => {
    const root = await makeTempDir("threenative-native-package-off-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 4, width: 4 }));

    await compileAssets({ config: { models: "none", textures: "none" }, cwd: root });

    await expect(readFile(path.join(root, "public", "native", "assets.tnpk"))).rejects.toThrow();
  });

  it("accepts the resolved option and rejects a non-boolean with the named code", async () => {
    const root = await makeTempDir("threenative-native-package-config-");
    await expect(
      compileAssets({ config: { nativePackage: true }, cwd: root }),
    ).resolves.toBeDefined();
    await expect(
      compileAssets({
        config: { nativePackage: "yes" } as unknown as { nativePackage: boolean },
        cwd: root,
      }),
    ).rejects.toThrow(/TN_ASSETS_CONFIG_INVALID: assets\.nativePackage must be a boolean/u);
  });
});
