import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const generatorPath = "../scripts/generate-three-patch.mjs";
const { assemblePatches, blobHash, generateThreePatch, parseSourceDeltaPaths, validatePin } =
  (await import(generatorPath)) as {
    assemblePatches(options: {
      stockDir: string;
      patchedDir: string;
      pin: { baseFinalHashes: Record<string, string> };
    }): Promise<{ basePatch: string; upgradePatch: string }>;
    blobHash(contents: string | Uint8Array): string;
    generateThreePatch(options: {
      packageRoot: string;
      archive?: string;
      check?: boolean;
      planner?: () => Promise<{ basePatch: string; upgradePatch: string }>;
    }): Promise<{ status: "written" | "matched" }>;
    parseSourceDeltaPaths(sourceDelta: string): string[];
    validatePin(pin: unknown): Record<string, unknown>;
  };

const realPatchDir = join(dirname(fileURLToPath(import.meta.url)), "..", "three-patch");

async function tempRoot(): Promise<string> {
  return makeTempDir("tn-test-gen-patch-");
}

async function readRealPin(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(realPatchDir, "pin.json"), "utf8"));
}

async function copyRealInputs(packageRoot: string): Promise<void> {
  await mkdir(join(packageRoot, "three-patch"), { recursive: true });
  await cp(join(realPatchDir, "pin.json"), join(packageRoot, "three-patch", "pin.json"));
  await cp(
    join(realPatchDir, "source-delta.patch"),
    join(packageRoot, "three-patch", "source-delta.patch"),
  );
}

/** Builds stock and patched trees holding exactly the pinned target paths. */
async function makeScopedTrees(
  root: string,
  pin: { baseFinalHashes: Record<string, string> },
): Promise<{ stockDir: string; patchedDir: string }> {
  const stockDir = join(root, "stock");
  const patchedDir = join(root, "patched");
  for (const rel of Object.keys(pin.baseFinalHashes)) {
    await mkdir(dirname(join(stockDir, rel)), { recursive: true });
    await mkdir(dirname(join(patchedDir, rel)), { recursive: true });
    await writeFile(join(stockDir, rel), `// stock ${rel}\n`, "utf8");
    await writeFile(join(patchedDir, rel), `// patched ${rel}\n`, "utf8");
  }
  return { patchedDir, stockDir };
}

describe("generateThreePatch validation", () => {
  it("rejects when pin.json or source-delta.patch is missing", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await mkdir(join(packageRoot, "three-patch"), { recursive: true });
    await expect(generateThreePatch({ packageRoot })).rejects.toThrow(
      /missing pin\.json or source-delta\.patch/u,
    );
  });

  it("rejects an invalid pin commit or version", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await mkdir(join(packageRoot, "three-patch"), { recursive: true });
    await writeFile(
      join(packageRoot, "three-patch", "pin.json"),
      JSON.stringify({ version: "0.185.0", commit: "badcommit" }),
      "utf8",
    );
    await writeFile(join(packageRoot, "three-patch", "source-delta.patch"), "", "utf8");
    await expect(generateThreePatch({ packageRoot })).rejects.toThrow(/unsupported pin/u);
  });

  it("rejects a pin with an unsafe path, bad hash, or duplicate pair", async () => {
    const pin = (await readRealPin()) as Record<string, unknown>;
    const pair = (path: string, oldHash: string) => ({
      path,
      oldHash,
      newHash: "a".repeat(40),
    });
    expect(() => validatePin(pin)).not.toThrow();
    expect(() =>
      validatePin({ ...pin, frozenCompatPairs: [pair("../evil.js", "b".repeat(40))] }),
    ).toThrow(/unsafe compat path/u);
    expect(() => validatePin({ ...pin, frozenCompatPairs: [pair("src/a.js", "nothex")] })).toThrow(
      /invalid compat hash/u,
    );
    const duplicate = pair("src/a.js", "c".repeat(40));
    expect(() => validatePin({ ...pin, frozenCompatPairs: [duplicate, { ...duplicate }] })).toThrow(
      /duplicate compat pair/u,
    );
    expect(() => validatePin({ ...pin, baseFinalHashes: { "src/ok.js": "nothex" } })).toThrow(
      /invalid final hash/u,
    );
    expect(() => validatePin({ ...pin, baseFinalHashes: {} })).toThrow(/non-empty/u);
  });

  it("accepts a source delta only when every path is a safe src/ path", () => {
    expect(
      parseSourceDeltaPaths("diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n"),
    ).toEqual(["src/a.js"]);
    expect(() => parseSourceDeltaPaths("")).toThrow(/empty/u);
    expect(() =>
      parseSourceDeltaPaths(
        "diff --git a/build/a.js b/build/a.js\n--- a/build/a.js\n+++ b/build/a.js\n",
      ),
    ).toThrow(/safe src\//u);
    expect(() =>
      parseSourceDeltaPaths(
        "diff --git a/src/../escape.js b/src/../escape.js\n--- a/src/../escape.js\n+++ b/src/../escape.js\n",
      ),
    ).toThrow(/safe src\//u);
    expect(() =>
      parseSourceDeltaPaths("diff --git a/src/a.js b/src/b.js\n--- a/src/a.js\n+++ b/src/b.js\n"),
    ).toThrow(/rename/u);
  });
});

describe("assemblePatches", () => {
  it("scopes the diff to the pinned targets and never emits installed dependencies", async () => {
    const root = await tempRoot();
    const pin = (await readRealPin()) as { baseFinalHashes: Record<string, string> };
    const { stockDir, patchedDir } = await makeScopedTrees(root, pin);
    await mkdir(join(patchedDir, "node_modules/pkg"), { recursive: true });
    await writeFile(
      join(patchedDir, "node_modules/pkg/index.js"),
      "module.exports = {};\n",
      "utf8",
    );
    await writeFile(join(patchedDir, "package.json"), "{}\n", "utf8");
    await writeFile(join(patchedDir, "package-lock.json"), "{}\n", "utf8");
    await writeFile(join(patchedDir, "README.md"), "# three\n", "utf8");

    const { basePatch } = await assemblePatches({ patchedDir, pin, stockDir });
    const headers = basePatch.match(/^diff --git /gmu) ?? [];
    expect(headers.length).toBe(Object.keys(pin.baseFinalHashes).length);
    expect(basePatch).not.toContain("node_modules");
    expect(basePatch).not.toContain("diff --git a/package.json");
    expect(basePatch).not.toContain("b/package-lock.json");
    expect(basePatch).not.toContain("b/README.md");
  });

  it("reflects the actual build result and is deterministic", async () => {
    const root = await tempRoot();
    const pin = (await readRealPin()) as { baseFinalHashes: Record<string, string> };
    const { stockDir, patchedDir } = await makeScopedTrees(root, pin);
    const target = "build/three.cjs";

    await writeFile(join(patchedDir, target), "console.log(1);\n", "utf8");
    const first = await assemblePatches({ patchedDir, pin, stockDir });
    const repeat = await assemblePatches({ patchedDir, pin, stockDir });
    expect(first.basePatch).toBe(repeat.basePatch);
    expect(first.upgradePatch).toBe(repeat.upgradePatch);

    await writeFile(join(patchedDir, target), "console.log(2);\n", "utf8");
    const second = await assemblePatches({ patchedDir, pin, stockDir });
    expect(second.basePatch).not.toBe(first.basePatch);
    const firstJson = JSON.parse(first.upgradePatch);
    const secondJson = JSON.parse(second.upgradePatch);
    expect(secondJson.generatedFinalHashes[target]).toBe(blobHash("console.log(2);\n"));
    expect(secondJson.generatedFinalHashes[target]).not.toBe(
      firstJson.generatedFinalHashes[target],
    );
  });

  it("covers all pinned targets and preserves every legacy compat pair", async () => {
    const root = await tempRoot();
    const pin = (await readRealPin()) as {
      baseFinalHashes: Record<string, string>;
      frozenCompatPairs: unknown[];
    };
    const { stockDir, patchedDir } = await makeScopedTrees(root, pin);
    const rel = "src/renderers/common/Renderer.js";
    await writeFile(join(patchedDir, rel), "// current renderer\n", "utf8");

    const { basePatch, upgradePatch } = await assemblePatches({ patchedDir, pin, stockDir });
    expect(Object.keys(pin.baseFinalHashes)).toHaveLength(35);
    expect(pin.frozenCompatPairs).toHaveLength(75);

    const json = JSON.parse(upgradePatch);
    expect(Object.keys(json.generatedFinalHashes)).toHaveLength(
      Object.keys(pin.baseFinalHashes).length,
    );
    expect(json.acceptedLegacyCompatPairs).toHaveLength(75);
    expect(Object.keys(json.acceptedLegacyFinalHashes)).toHaveLength(
      Object.keys(pin.baseFinalHashes).length,
    );
    expect(json.generatedFinalHashes[rel]).toBe(blobHash("// current renderer\n"));
    expect(json.acceptedLegacyFinalHashes[rel]).toBe(pin.baseFinalHashes[rel]);

    const bundled = JSON.parse(
      brotliDecompressSync(Buffer.from(json.bundleBrotliBase64, "base64")).toString("utf8"),
    );
    expect(Object.keys(bundled)).toHaveLength(Object.keys(pin.baseFinalHashes).length);
    expect(basePatch).toContain(
      "diff --git a/src/renderers/common/Renderer.js b/src/renderers/common/Renderer.js",
    );
  });
});

describe("generateThreePatch artifacts", () => {
  it("writes both artifacts on success", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await copyRealInputs(packageRoot);
    const planner = async () => ({ basePatch: "BASE\n", upgradePatch: "UP\n" });

    const result = await generateThreePatch({ packageRoot, planner });
    expect(result.status).toBe("written");
    expect(await readFile(join(packageRoot, "patches", "three@0.185.1.patch"), "utf8")).toBe(
      "BASE\n",
    );
    expect(
      await readFile(join(packageRoot, "patches", "three@0.185.1-prd269-upgrade.patch"), "utf8"),
    ).toBe("UP\n");
  });

  it("rejects drift in check mode and leaves both destinations unchanged", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await copyRealInputs(packageRoot);
    const baseDest = join(packageRoot, "patches", "three@0.185.1.patch");
    const upgradeDest = join(packageRoot, "patches", "three@0.185.1-prd269-upgrade.patch");
    await mkdir(join(packageRoot, "patches"), { recursive: true });
    await writeFile(baseDest, "OLD\n", "utf8");
    await writeFile(upgradeDest, "OLDUP\n", "utf8");
    const planner = async () => ({ basePatch: "NEW\n", upgradePatch: "NEWUP\n" });

    await expect(generateThreePatch({ packageRoot, planner, check: true })).rejects.toThrow(
      /drift/u,
    );
    expect(await readFile(baseDest, "utf8")).toBe("OLD\n");
    expect(await readFile(upgradeDest, "utf8")).toBe("OLDUP\n");
  });

  it("matches in check mode when the generated text equals the committed text", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await copyRealInputs(packageRoot);
    const baseDest = join(packageRoot, "patches", "three@0.185.1.patch");
    const upgradeDest = join(packageRoot, "patches", "three@0.185.1-prd269-upgrade.patch");
    await mkdir(join(packageRoot, "patches"), { recursive: true });
    await writeFile(baseDest, "SAME\n", "utf8");
    await writeFile(upgradeDest, "SAMEUP\n", "utf8");
    const planner = async () => ({ basePatch: "SAME\n", upgradePatch: "SAMEUP\n" });

    const result = await generateThreePatch({ packageRoot, planner, check: true });
    expect(result.status).toBe("matched");
  });

  it("does not write either destination when the archive is missing", async () => {
    const root = await tempRoot();
    const packageRoot = join(root, "core");
    await copyRealInputs(packageRoot);
    const baseDest = join(packageRoot, "patches", "three@0.185.1.patch");

    await expect(
      generateThreePatch({ archive: join(root, "absent.tar.gz"), packageRoot }),
    ).rejects.toThrow(/archive not found/u);
    expect(existsSync(baseDest)).toBe(false);
  });
});
