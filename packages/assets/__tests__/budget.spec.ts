import { mkdir, readFile, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildFixtureDocument,
  buildFixtureGlb,
} from "../../../test-support/generate-fixture-model.js";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { assertBudget, measureBudget, parseBudget } from "../src/budget.js";
import { compileAssets, modelTranscoderCharge } from "../src/compile.js";
import { unpackGlb } from "../src/passes/shared-images.js";
import { encodeLinearRgbaKtx2 } from "../src/passes/texture.js";

async function fixture() {
  const root = await makeTempDir("asset-budget-");
  await mkdir(path.join(root, "assets"));
  const bytes = rgbaPng({ width: 16, height: 16, red: () => 100, green: () => 50, blue: () => 20 });
  await writeFile(path.join(root, "assets/largest.png"), bytes);
  return { root, bytes };
}

/** Two colours in 4x4 cells: too small for any encode to save a byte, never a solid `prune` drops. */
function tinyPng(seed: number): Buffer {
  return rgbaPng({
    width: 16,
    height: 16,
    red: (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? 30 + seed : 210),
    green: (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? 40 : 150 + seed),
    blue: () => 90 + seed,
  });
}

/** 11x10: neither edge is a whole number of 4x4 blocks, so the cook retains it as authored. */
function unalignedPng(seed: number): Buffer {
  return rgbaPng({
    width: 11,
    height: 10,
    red: (x, y) => ((x + y) % 2 === 0 ? 40 + seed : 190),
    green: (x) => (x * 11 + seed) & 0xff,
    blue: (_x, y) => (y * 13 + seed) & 0xff,
  });
}

/**
 * Four embedded images on one material: an unnamed one and a `wood` that both skip as
 * `not-smaller`, then a second `wood` and another unnamed one that skip as `block-size`.
 * The pass files them as `texture#0`, `wood`, `wood#2` and `texture#3` — two keys the GLB's
 * `images[].name` cannot spell at all, and one it spells the same as an earlier image's.
 */
async function duplicateNameGlb(): Promise<Uint8Array> {
  const document = buildFixtureDocument({ textured: false });
  const cloth = document
    .getRoot()
    .listMaterials()
    .find((material) => material.getName() === "cloth");
  if (cloth === undefined) throw new Error("the fixture model no longer has a cloth material");
  const embed = (name: string, bytes: Buffer) =>
    document.createTexture(name).setImage(new Uint8Array(bytes)).setMimeType("image/png");
  cloth.setBaseColorTexture(embed("", tinyPng(0)));
  cloth.setNormalTexture(embed("wood", tinyPng(60)));
  cloth.setOcclusionTexture(embed("wood", unalignedPng(0)));
  cloth.setMetallicRoughnessTexture(embed("", unalignedPng(60)));
  return new NodeIO().writeBinary(document);
}

/** What each image of a compiled model costs the download, in `images[]` order. */
async function shippedImageBytes(outputRoot: string, output: string): Promise<number[]> {
  const model = path.join(outputRoot, output);
  const { json } = unpackGlb(await readFile(model));
  const views = json.bufferViews ?? [];
  return Promise.all(
    (json.images ?? []).map(async (image) =>
      image.uri === undefined
        ? (views[image.bufferView ?? -1]?.byteLength ?? 0)
        : (await stat(path.resolve(path.dirname(model), image.uri))).size,
    ),
  );
}

describe("asset byte budgets", () => {
  it.each([
    null,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "64",
    [],
    { total: 0 },
    { uncooked: null },
  ])("rejects malformed budget %j", (value) => {
    expect(() => parseBudget(value)).toThrow("TN_ASSETS_CONFIG_INVALID");
  });

  it("keeps an independent disabled counter and rejects unknown keys", () => {
    expect(parseBudget({ uncooked: "none" })).toEqual({ uncooked: "none", total: "none" });
    expect(parseBudget({ total: 100 })).toEqual({ uncooked: 64_000_000, total: 100 });
    expect(() => parseBudget({ typo: 2 })).toThrow("TN_ASSETS_CONFIG_UNKNOWN_KEY");
  });

  it("charges shared model texture savings once per distinct image", () => {
    const embeddedTextures = {
      bytesAfter: 1,
      bytesBefore: 1,
      count: 1,
      gpuBytesAfter: 1,
      gpuBytesBefore: 1,
      resized: 0,
      transcoderSavings: 400_000,
    };
    const entry = (output: string, key: string, detailed = true) => ({
      bytes: 1,
      embeddedTextures,
      kind: "model" as const,
      output,
      passes: [],
      sharedImages: [
        {
          key,
          ...(detailed ? { transcoderRequired: false, transcoderSavings: 400_000 } : {}),
        },
      ],
    });

    expect(
      modelTranscoderCharge({ one: entry("one.glb", "same"), two: entry("two.glb", "same") }),
    ).toBeUndefined();
    expect(
      modelTranscoderCharge({ one: entry("one.glb", "one"), two: entry("two.glb", "two") }),
    ).toBe(0);
    expect(
      modelTranscoderCharge({
        one: entry("one.glb", "same", false),
        two: entry("two.glb", "same", false),
      }),
    ).toBe(0);
  });

  it("counts 200 MB cooked once, using emitted sizes rather than stale manifest claims", async () => {
    const root = await makeTempDir("asset-budget-large-");
    const ktx2 = await encodeLinearRgbaKtx2(new Uint8Array(16 * 16 * 4).fill(128), 16, 16);
    await writeFile(path.join(root, "shared.ktx2"), ktx2);
    await truncate(path.join(root, "shared.ktx2"), 200_000_000);
    const output = { bytes: 1, output: "shared.ktx2", kind: "texture" };
    const result = await measureBudget(
      { first: output, second: output },
      root,
      true,
      parseBudget(undefined),
    );
    expect(result.total).toBe(200_000_000);
    expect(result.uncooked).toBe(0);
    expect(() => assertBudget(result)).not.toThrow();
    expect(() => assertBudget({ ...result, budget: parseBudget({ total: 199_999_999 }) })).toThrow(
      "TN_ASSETS_BUDGET_EXCEEDED",
    );
    // Same number of bytes, still PNG, must fail the default gate.
    await writeFile(path.join(root, "raw.png"), "png");
    await truncate(path.join(root, "raw.png"), 200_000_000);
    const raw = await measureBudget(
      { raw: { bytes: 1, output: "raw.png", kind: "texture" } },
      root,
      true,
      parseBudget(undefined),
    );
    expect(() => assertBudget(raw)).toThrow("TN_ASSETS_BUDGET_EXCEEDED");
  });

  it("counts compiler-owned Basis sidecars exactly once in total and never in uncooked", async () => {
    const { root } = await fixture();
    // A textured image, so the cook actually publishes KTX2 and the sidecars the budget counts.
    await writeFile(
      path.join(root, "assets/largest.png"),
      rgbaPng({
        height: 256,
        width: 256,
        red: (x, y) => 100 + ((x * 21 + y * 21) % 8),
        green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
        blue: (x, y) => 100 + ((x * 37 + y * 41) % 8),
      }),
    );
    const first = await compileAssets({
      cwd: root,
      transcoder: basisTranscoderPaths(),
      modelTranscoderBytes: 0,
      config: { budget: "none" },
    });
    const unique = new Map(first.receipt?.outputs.map((output) => [output.path, output]) ?? []);
    const primaryBytes = [...unique.values()]
      .filter((output) => output.producer !== "basis-transcoder")
      .reduce((total, output) => total + output.bytes, 0);
    const sidecarBytes = [...unique.values()]
      .filter((output) => output.producer === "basis-transcoder")
      .reduce((total, output) => total + output.bytes, 0);
    expect(sidecarBytes).toBeGreaterThan(0);
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      await expect(
        compileAssets({
          cwd: root,
          transcoder: basisTranscoderPaths(),
          modelTranscoderBytes: 0,
          config: { budget: { total: primaryBytes, uncooked: "none" } },
        }),
      ).rejects.toThrow(`total ${primaryBytes + sidecarBytes} bytes exceeds ${primaryBytes}`);
    } finally {
      log.mockRestore();
    }
    expect(lines.join("\n")).toContain("uncooked 0 bytes (ceiling none)");
  });

  it("counts raw embedded and shared images even when the model pass ran", async () => {
    const root = await makeTempDir("asset-budget-model-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/rock.glb"), await buildFixtureGlb());
    for (const sharedImages of [false, true]) {
      await compileAssets({
        cwd: root,
        concurrency: 1,
        config: { budget: "none", models: { sharedImages, textures: "none" } },
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      expect(manifest.entries["rock.glb"].passes).toContain("model");
      const measured = await measureBudget(
        manifest.entries,
        path.join(root, "public"),
        true,
        parseBudget(1),
      );
      expect(measured.uncooked).toBeGreaterThan(1);
      expect(measured.uncooked).toBeLessThan(measured.total);
      await expect(
        compileAssets({
          cwd: root,
          concurrency: 1,
          config: { budget: 1, models: { sharedImages, textures: "none" } },
        }),
      ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
    }
  });

  it("exempts automatic no-growth fallback but charges an explicit codec override", async () => {
    const { root } = await fixture();
    await compileAssets({ cwd: root, transcoder: basisTranscoderPaths(), config: { budget: 1 } });
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    );
    expect(manifest.entries["largest.png"].compressionSkipped).toBe("not-smaller");
    await expect(
      compileAssets({
        cwd: root,
        config: { budget: 1, textures: { overrides: [{ glob: "*.png", codec: "none" }] } },
      }),
    ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
  });

  // Unlike `not-smaller`, which no author can act on, an unaligned source is fixable by the
  // resize the cook refuses to make for them. So these bytes ship uncompressed *and* are
  // counted: the gate stays honest about what the download actually costs.
  it("charges automatically retained non-block-aligned bytes to uncooked and total", async () => {
    const root = await makeTempDir("asset-budget-block-size-");
    await mkdir(path.join(root, "assets"));
    const bytes = rgbaPng({
      width: 11,
      height: 10,
      red: () => 100,
      green: () => 50,
      blue: () => 20,
    });
    await writeFile(path.join(root, "assets/decal.png"), bytes);

    await expect(
      compileAssets({ cwd: root, transcoder: basisTranscoderPaths(), config: { budget: 1 } }),
    ).rejects.toThrow(/TN_ASSETS_BUDGET_EXCEEDED.*decal\.png/su);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    try {
      await compileAssets({
        cwd: root,
        transcoder: basisTranscoderPaths(),
        config: { budget: "none" },
      });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      expect(manifest.entries["decal.png"].compressionSkipped).toBe("block-size");
      // Both counters, on the row for this file: the Basis runtime `public/` also carries is
      // compiler machinery and only ever lands in the build-wide total.
      expect(lines).toContain(
        `  budget decal.png: uncooked ${bytes.length} bytes, total ${bytes.length} bytes`,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([false, true])(
    "exempts automatically retained embedded PNGs with sharedImages=%s, including cache hits",
    async (sharedImages) => {
      const root = await makeTempDir("asset-budget-small-model-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets/rock.glb"), await buildFixtureGlb());
      const options = {
        cwd: root,
        concurrency: 1,
        transcoder: basisTranscoderPaths(),
        config: { budget: 1, models: { sharedImages } },
      };
      await compileAssets(options);
      const result = await compileAssets(options);
      expect(result.skipped).toBe(1);
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      expect(
        Object.keys(manifest.entries["rock.glb"].embeddedTextures.skippedCompression).length,
      ).toBeGreaterThan(0);
    },
  );

  /**
   * Skip reasons are filed under the pass's texture keys, and two of those keys are not a name:
   * an unnamed texture is `texture#<index>` and a repeated name is `<name>#<index>`. Matching a
   * GLB's `images[].name` instead charged every unnamed image the encoder could not have
   * shrunk, and let the first `not-smaller` of a duplicated name carry a later `block-size`
   * image out of the count with it.
   */
  it.each([false, true])(
    "keys retained-image exemptions by texture index with sharedImages=%s",
    async (sharedImages) => {
      const root = await makeTempDir("asset-budget-image-key-");
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets/rock.glb"), await duplicateNameGlb());
      const compile = (budget: number | "none") =>
        compileAssets({
          cwd: root,
          concurrency: 1,
          transcoder: basisTranscoderPaths(),
          config: { budget, models: { sharedImages } },
        });
      await compile("none");
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      const entry = manifest.entries["rock.glb"];
      expect(entry.embeddedTextures.skippedCompression).toEqual({
        "texture#0": "not-smaller",
        wood: "not-smaller",
        "wood#2": "block-size",
        "texture#3": "block-size",
      });

      const outputRoot = path.join(root, "public");
      const shipped = await shippedImageBytes(outputRoot, entry.output);
      const exempt = (shipped[0] ?? 0) + (shipped[1] ?? 0);
      const charged = (shipped[2] ?? 0) + (shipped[3] ?? 0);
      // A fixture whose two halves happened to weigh the same would pass either way.
      expect(exempt).toBeGreaterThan(0);
      expect(charged).not.toBe(exempt);

      const measured = await measureBudget(manifest.entries, outputRoot, true, parseBudget("none"));
      // Every geometry bufferView is meshopt-compressed, so the only uncooked bytes left are the
      // two images retained for a reason a project can act on.
      expect(measured.uncooked).toBe(charged);
      await compile(charged);
      await expect(compile(charged - 1)).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
    },
  );

  it("fails on uncooked output and names the asset and remedies", async () => {
    const { root } = await fixture();
    await expect(
      compileAssets({ cwd: root, config: { models: "none", textures: "none", budget: 1 } }),
    ).rejects.toThrow(
      /TN_ASSETS_BUDGET_EXCEEDED.*largest.png.*assets.exclude.*assets.budget.*texture/,
    );
  });

  it("still prints measured bytes with both budgets disabled", async () => {
    const { root, bytes } = await fixture();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    await compileAssets({
      cwd: root,
      config: { models: "none", textures: "none", budget: "none" },
    });
    expect(lines.join("\n")).toContain(`uncooked ${bytes.length} bytes (ceiling none)`);
    expect(lines.join("\n")).toContain(`total ${bytes.length} bytes (ceiling none)`);
  });

  it.each(["android", "ios"] as const)(
    "exempts %s from uncooked but enforces total",
    async (platform) => {
      const { root, bytes } = await fixture();
      await compileAssets({ cwd: root, platform, config: { budget: 1 } });
      const manifest = JSON.parse(
        await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
      );
      expect(manifest.entries["largest.png"].bytes).toBe(bytes.length);
      await expect(
        compileAssets({ cwd: root, platform, config: { budget: { total: 1 } } }),
      ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
    },
  );

  it("counts mobile shared outputs once on cold and cached builds", async () => {
    const root = await makeTempDir("asset-budget-mobile-shared-");
    await mkdir(path.join(root, "assets"));
    const source = await buildFixtureGlb();
    await writeFile(path.join(root, "assets/one.glb"), source);
    await writeFile(path.join(root, "assets/two.glb"), source);
    const options = {
      config: { budget: "none", models: { sharedImages: true } },
      concurrency: 1,
      cwd: root,
      platform: "android" as const,
    } as const;

    const first = await compileAssets(options);
    const manifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    ) as {
      entries: Record<
        string,
        { bytes: number; output: string; kind?: string; sharedImages?: readonly unknown[] }
      >;
    };
    const outputRoot = path.join(root, "public");
    const measured = await measureBudget(
      manifest.entries,
      outputRoot,
      { ktx2: false, meshopt: false },
      parseBudget("none"),
    );
    const uniqueReceiptPaths = new Set(first.receipt?.outputs.map((output) => output.path));
    const receiptBytes = await Promise.all(
      [...uniqueReceiptPaths].map(
        async (output) => (await stat(path.join(outputRoot, output))).size,
      ),
    );
    expect(measured.total).toBe(receiptBytes.reduce((total, bytes) => total + bytes, 0));
    expect(measured.uncooked).toBe(0);
    expect(manifest.entries["one.glb"]?.sharedImages).toBeDefined();

    const second = await compileAssets(options);
    expect(second.skipped).toBe(2);
    const cachedManifest = JSON.parse(
      await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
    ) as {
      entries: Record<
        string,
        { bytes: number; output: string; kind?: string; sharedImages?: readonly unknown[] }
      >;
    };
    const cached = await measureBudget(
      cachedManifest.entries,
      outputRoot,
      { ktx2: false, meshopt: false },
      parseBudget("none"),
    );
    expect(cached.total).toBe(measured.total);
    expect(cached.uncooked).toBe(0);
  });

  it("accepts the exact ceiling and rejects one byte below on a cache hit", async () => {
    const { root, bytes } = await fixture();
    await compileAssets({ cwd: root, config: { textures: "none", budget: bytes.length } });
    await expect(
      compileAssets({ cwd: root, config: { textures: "none", budget: bytes.length - 1 } }),
    ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
  });
});
