import { mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureGlb } from "../../../test-support/generate-fixture-model.js";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { type IBakeReceipt, compileAssets } from "../src/index.js";

const TRANSCODER = basisTranscoderPaths();
const RECEIPT = "bake.receipt.json";

async function readReceipt(root: string): Promise<IBakeReceipt> {
  return JSON.parse(await readFile(path.join(root, "public", RECEIPT), "utf8")) as IBakeReceipt;
}

/** A pass that ships one auxiliary output beside the model it was handed, like the lightmap pass. */
const lightmapFixture = {
  name: "lightmap-fixture",
  apply: (input: Buffer) => ({
    auxiliaryOutputs: [
      {
        buffer: Buffer.from("ktx2"),
        extension: ".ktx2",
        manifestField: "lightmaps",
        metadata: { texCoord: 1 },
        role: "lightmap",
      },
    ],
    buffer: input,
  }),
};

describe("bake receipt", () => {
  it("should list the compiled output of every source, with the pass that produced it", async () => {
    const root = await makeTempDir("threenative-receipt-basic-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    const result = await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const receipt = await readReceipt(root);

    expect(receipt.pipelineVersion).toBe(10);
    expect(result.receipt).toEqual(receipt);
    const compiled = receipt.outputs.find((output) => output.source === "rock.png");
    expect(compiled?.path).toMatch(/^rock\.[0-9a-f]{8}\.png$/u);
    expect(compiled?.producer).toBe("audio+ktx2+model");
    expect(compiled?.bytes).toBeGreaterThan(0);
  });

  it("should list every auxiliary output a pass produced", async () => {
    const root = await makeTempDir("threenative-receipt-auxiliary-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "level.glb"), Buffer.from(await buildFixtureGlb()));

    await compileAssets({ cwd: root, passes: [lightmapFixture] });
    const receipt = await readReceipt(root);

    const auxiliary = receipt.outputs.find((output) => output.producer === "lightmap");
    expect(auxiliary?.path).toMatch(/^level\.lightmap\.[0-9a-f]{8}\.ktx2$/u);
    expect(auxiliary?.source).toBe("level.glb");
    expect(auxiliary?.bytes).toBe(4);
  });

  it.each([
    "../outside.txt",
    "shared/../../outside.txt",
    "..\\outside.txt",
    "/outside.txt",
    "C:\\outside.txt",
  ])("should reject auxiliary traversal %s before publishing", async (outputPath) => {
    const root = await makeTempDir("threenative-receipt-auxiliary-containment-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "level.bin"), "source");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "belongs to the game");
    await expect(
      compileAssets({
        cwd: root,
        passes: [
          {
            ...lightmapFixture,
            apply: (input: Buffer) => ({
              buffer: input,
              auxiliaryOutputs: lightmapFixture.apply(input).auxiliaryOutputs.map((output) => ({
                ...output,
                outputPath,
              })),
            }),
          },
        ],
      }),
    ).rejects.toThrow(/TN_ASSETS_OUTPUT_INVALID/u);
    expect(await readFile(outside, "utf8")).toBe("belongs to the game");
    await expect(readFile(path.join(root, "public", RECEIPT))).rejects.toThrow(/ENOENT/u);
    await expect(readFile(path.join(root, "public", "assets.manifest.json"))).rejects.toThrow(
      /ENOENT/u,
    );
  });

  it("should list the Basis transcoder it ships beside the compiled textures", async () => {
    const root = await makeTempDir("threenative-receipt-transcoder-");
    await mkdir(path.join(root, "assets"));
    // A textured image, so the pass actually encodes a KTX2 the transcoder can serve.
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({
        height: 256,
        width: 256,
        red: (x, y) => 100 + ((x * 21 + y * 21) % 8),
        green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
        blue: (x, y) => 100 + ((x * 37 + y * 41) % 8),
      }),
    );

    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const receipt = await readReceipt(root);

    expect(receipt.outputs.map((output) => output.path)).toEqual(
      expect.arrayContaining(["basis/basis_transcoder.js", "basis/basis_transcoder.wasm"]),
    );
    for (const output of receipt.outputs.filter((entry) => entry.producer === "basis-transcoder")) {
      expect(output.source).toBeNull();
    }
  });

  it("should still list an output the second build served from cache", async () => {
    const root = await makeTempDir("threenative-receipt-cached-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    const first = await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const firstReceipt = await readFile(path.join(root, "public", RECEIPT), "utf8");
    const second = await compileAssets({ cwd: root, transcoder: TRANSCODER });

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
    // The point of the whole receipt: a cache hit writes nothing and the file is still this
    // bake's output, so the delete-test must be told to remove it.
    expect(await readFile(path.join(root, "public", RECEIPT), "utf8")).toBe(firstReceipt);
  });

  it("should remove only receipt-owned outputs that a recook no longer references", async () => {
    const root = await makeTempDir("threenative-receipt-recook-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "assets", "level.bin"), "first");
    await writeFile(path.join(root, "public", "icon.txt"), "authored by the game");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fixturePass = {
      name: "recook-fixture",
      cacheKey: "v1",
      apply: (input: Buffer) => ({
        auxiliaryOutputs: [
          {
            buffer: input,
            extension: ".bin",
            manifestField: "sharedImages",
            outputPath: `shared/images/${input.toString("utf8")}.bin`,
            role: "image",
          },
          {
            buffer: Buffer.from("keep"),
            extension: ".bin",
            manifestField: "sharedImages",
            outputPath: "shared/images/keep.bin",
            role: "image",
          },
        ],
        buffer: input,
      }),
    };

    const first = await compileAssets({ cwd: root, passes: [fixturePass] });
    const firstPaths = first.receipt?.outputs.map((output) => output.path) ?? [];
    const oldPrimary = firstPaths.find((output) => /^level\.[0-9a-f]{8}\.bin$/u.test(output));
    expect(oldPrimary).toBeDefined();

    await writeFile(path.join(root, "assets", "level.bin"), "second");
    const second = await compileAssets({ cwd: root, passes: [fixturePass] });
    const secondPaths = second.receipt?.outputs.map((output) => output.path) ?? [];

    await expect(readFile(path.join(root, "public", oldPrimary ?? ""))).rejects.toThrow(/ENOENT/u);
    await expect(readFile(path.join(root, "public", "shared/images/first.bin"))).rejects.toThrow(
      /ENOENT/u,
    );
    expect(await readFile(path.join(root, "public", "shared/images/second.bin"), "utf8")).toBe(
      "second",
    );
    expect(secondPaths).toContain("shared/images/keep.bin");
    expect(await readFile(path.join(root, "public", "shared/images/keep.bin"), "utf8")).toBe(
      "keep",
    );
    expect(await readFile(path.join(root, "public", "icon.txt"), "utf8")).toBe(
      "authored by the game",
    );
  });

  it("should reject a stale receipt path outside the output root", async () => {
    const root = await makeTempDir("threenative-receipt-containment-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "level.bin"), "first");
    await compileAssets({ cwd: root, passes: [lightmapFixture] });
    const goodManifest = await readFile(path.join(root, "public", "assets.manifest.json"), "utf8");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "belongs to the game");
    const receipt = await readReceipt(root);
    const invalidReceipt = `${JSON.stringify({
      ...receipt,
      outputs: [
        ...receipt.outputs,
        { bytes: 19, path: "../outside.txt", producer: "fixture", source: "level.bin" },
      ],
    })}\n`;
    await writeFile(path.join(root, "public", RECEIPT), invalidReceipt);
    const oldOutput = receipt.outputs.find((output) => output.source === "level.bin")?.path;
    expect(oldOutput).toBeDefined();
    await writeFile(path.join(root, "assets", "level.bin"), "second");

    await expect(compileAssets({ cwd: root, passes: [lightmapFixture] })).rejects.toThrow(
      /TN_ASSETS_RECEIPT_INVALID.*outside assets\.output/u,
    );
    expect(await readFile(outside, "utf8")).toBe("belongs to the game");
    expect(await readFile(path.join(root, "public", oldOutput ?? ""), "utf8")).toBe("first");
    expect(await readFile(path.join(root, "public", RECEIPT), "utf8")).toBe(invalidReceipt);
    expect(await readFile(path.join(root, "public", "assets.manifest.json"), "utf8")).toBe(
      goodManifest,
    );
  });

  it("should recover outputs written by a failed cook without losing the last good receipt", async () => {
    const root = await makeTempDir("threenative-receipt-failed-cook-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "assets", "level.bin"), "old");
    const identity = { name: "identity", apply: (input: Buffer) => input };
    await compileAssets({ cwd: root, passes: [identity], config: { budget: "none" } });
    const goodReceipt = await readFile(path.join(root, "public", RECEIPT), "utf8");
    const oldOutput = (JSON.parse(goodReceipt) as IBakeReceipt).outputs[0]?.path;

    await writeFile(path.join(root, "assets", "level.bin"), "failed-output");
    await expect(
      compileAssets({
        cwd: root,
        passes: [identity],
        config: { budget: { total: 1, uncooked: "none" } },
      }),
    ).rejects.toThrow("TN_ASSETS_BUDGET_EXCEEDED");
    expect(await readFile(path.join(root, "public", RECEIPT), "utf8")).toBe(goodReceipt);
    const failedOutputs = (await readdir(path.join(root, "public"))).filter(
      (name) => name.endsWith(".bin") && name !== oldOutput,
    );
    expect(failedOutputs).toHaveLength(1);
    await writeFile(path.join(root, "public", "icon.txt"), "belongs to the game");

    await compileAssets({
      cwd: root,
      passes: [identity],
      config: { budget: "none", exclude: ["level.bin"] },
    });

    await expect(readFile(path.join(root, "public", oldOutput ?? ""))).rejects.toThrow(/ENOENT/u);
    await expect(readFile(path.join(root, "public", failedOutputs[0] ?? ""))).rejects.toThrow(
      /ENOENT/u,
    );
    await expect(readFile(path.join(root, "public", RECEIPT), "utf8")).rejects.toThrow(/ENOENT/u);
    await expect(
      readFile(path.join(root, "public", ".bake.pending-receipt.json"), "utf8"),
    ).rejects.toThrow(/ENOENT/u);
    expect(await readFile(path.join(root, "public", "icon.txt"), "utf8")).toBe(
      "belongs to the game",
    );
  });

  it("should produce an identical receipt for identical inputs", async () => {
    const first = await makeTempDir("threenative-receipt-determinism-a-");
    const second = await makeTempDir("threenative-receipt-determinism-b-");
    const png = rgbaPng({ height: 32, width: 32 });
    for (const root of [first, second]) {
      await mkdir(path.join(root, "assets"));
      await writeFile(path.join(root, "assets", "rock.png"), png);
      await compileAssets({ cwd: root, transcoder: TRANSCODER });
    }

    expect(await readFile(path.join(first, "public", RECEIPT), "utf8")).toBe(
      await readFile(path.join(second, "public", RECEIPT), "utf8"),
    );
  });

  it.each([
    ["ordinary", false],
    ["backdated", true],
  ])("should throw when a pass writes an undeclared file (%s)", async (_label, backdate) => {
    const root = await makeTempDir("threenative-receipt-stray-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    await expect(
      compileAssets({
        cwd: root,
        transcoder: TRANSCODER,
        passes: [
          {
            name: "stray-writer",
            apply: async (input: Buffer) => {
              await mkdir(path.join(root, "public"), { recursive: true });
              await writeFile(path.join(root, "public", "stray.bin"), "undeclared");
              if (backdate) {
                await utimes(
                  path.join(root, "public", "stray.bin"),
                  new Date("2000-01-01T00:00:00Z"),
                  new Date("2000-01-01T00:00:00Z"),
                );
              }
              return input;
            },
          },
        ],
      }),
    ).rejects.toThrow(/TN_ASSETS_UNDECLARED_OUTPUT.*stray\.bin/su);
  });

  it("should throw when a pass overwrites a pre-existing undeclared file", async () => {
    const root = await makeTempDir("threenative-receipt-stray-overwrite-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "public", "stray.bin"), "old");
    await utimes(
      path.join(root, "public", "stray.bin"),
      new Date("2000-01-01T00:00:00Z"),
      new Date("2000-01-01T00:00:00Z"),
    );
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));

    await expect(
      compileAssets({
        cwd: root,
        transcoder: TRANSCODER,
        passes: [
          {
            name: "stray-writer",
            apply: async (input: Buffer) => {
              await writeFile(path.join(root, "public", "stray.bin"), "undeclared");
              const future = new Date(Date.now() + 1000);
              await utimes(path.join(root, "public", "stray.bin"), future, future);
              return input;
            },
          },
        ],
      }),
    ).rejects.toThrow(/TN_ASSETS_UNDECLARED_OUTPUT.*stray\.bin/su);
  });

  it("should leave a static file the project authored alone", async () => {
    const root = await makeTempDir("threenative-receipt-static-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public"));
    // Written before the bake and never touched by it — a scaffolded project's own icon.
    await writeFile(path.join(root, "public", "icon.png"), rgbaPng({ height: 8, width: 8 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A textured image, so the pass actually encodes a KTX2 the transcoder can serve.
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({
        height: 256,
        width: 256,
        red: (x, y) => 100 + ((x * 21 + y * 21) % 8),
        green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
        blue: (x, y) => 100 + ((x * 37 + y * 41) % 8),
      }),
    );

    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    const receipt = await readReceipt(root);

    expect(receipt.outputs.map((output) => output.path)).not.toContain("icon.png");
  });

  it("should remove a stale receipt rather than leave one describing files nothing produces", async () => {
    const root = await makeTempDir("threenative-receipt-stale-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), rgbaPng({ height: 32, width: 32 }));
    await compileAssets({ cwd: root, transcoder: TRANSCODER });
    expect(await readReceipt(root)).toBeDefined();

    await rm(path.join(root, "assets", "rock.png"));
    await compileAssets({ cwd: root, transcoder: TRANSCODER });

    await expect(readFile(path.join(root, "public", RECEIPT), "utf8")).rejects.toThrow(/ENOENT/u);
  });

  it("should write no receipt at all when there is no source directory", async () => {
    const root = await makeTempDir("threenative-receipt-nosource-");
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => lines.push(String(line)));
    let result: Awaited<ReturnType<typeof compileAssets>>;
    try {
      result = await compileAssets({ cwd: root, transcoder: TRANSCODER });
    } finally {
      log.mockRestore();
    }

    expect(result.written).toBe(0);
    expect(result.receipt).toBeUndefined();
    expect(lines).toContain(
      "TN_ASSETS_BUDGET: uncooked 0 bytes (ceiling 64000000); total 0 bytes (ceiling none)",
    );
    await expect(readFile(path.join(root, "public", RECEIPT), "utf8")).rejects.toThrow(/ENOENT/u);
  });

  it("should remove owned outputs and report zero when the source directory disappeared", async () => {
    const root = await makeTempDir("threenative-receipt-removed-source-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public"));
    await writeFile(path.join(root, "assets", "level.bin"), "compiled");
    const first = await compileAssets({
      cwd: root,
      passes: [{ name: "identity", apply: (input: Buffer) => input }],
      config: { budget: "none" },
    });
    const output = first.receipt?.outputs[0]?.path;
    await writeFile(path.join(root, "public", "icon.txt"), "belongs to the game");
    await rm(path.join(root, "assets"), { recursive: true });

    await compileAssets({ cwd: root, config: { budget: "none" } });

    await expect(readFile(path.join(root, "public", output ?? ""))).rejects.toThrow(/ENOENT/u);
    expect(
      JSON.parse(await readFile(path.join(root, "public", "assets.manifest.json"), "utf8")),
    ).toEqual({ version: 1, entries: {} });
    expect(await readFile(path.join(root, "public", "icon.txt"), "utf8")).toBe(
      "belongs to the game",
    );
  });
});
