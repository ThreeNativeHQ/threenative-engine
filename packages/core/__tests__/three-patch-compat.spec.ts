import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

// @ts-expect-error -- the postinstall helper is plain ESM with no type declarations.
import { applyThreePatch } from "../scripts/apply-three-patch.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const patchDir = join(resolve("packages/core"), "patches");

const UPGRADE_TEXT = readFileSync(join(patchDir, "three@0.185.1-prd269-upgrade.patch"), "utf8");
const BASE_PATCH = readFileSync(join(patchDir, "three@0.185.1.patch"), "utf8");
const UPGRADE = JSON.parse(UPGRADE_TEXT) as {
  acceptedLegacyCompatPairs: { path: string; oldHash: string; newHash: string }[];
  acceptedLegacyFinalHashes: Record<string, string>;
  bundleBrotliBase64: string;
  generatedFinalHashes: Record<string, string>;
  version: number;
};

// Frozen, test-only copy of the legacy unified migration and the exact bytes the previous release
// shipped. It is the only stable reference for the predecessor states a consumer can hold.
const FIXTURE = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "legacy-three-patch.json.br")),
  ).toString("utf8"),
) as {
  originalBasePatch: string;
  originalUpgradePatch: string;
  targetTexts: Record<string, string>;
};

const GEOMETRY_CACHE_PREDECESSORS = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "geometry-cache-predecessors.json.br")),
  ).toString("utf8"),
) as Record<string, string>;

const RESOURCE_LIFETIME_PREDECESSORS = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "resource-lifetime-predecessors.json.br")),
  ).toString("utf8"),
) as Record<string, string>;

const DEVELOP_REFRESH_PREDECESSORS = JSON.parse(
  brotliDecompressSync(
    readFileSync(join(testDir, "fixtures", "develop-refresh-predecessors.json.br")),
  ).toString("utf8"),
) as Record<string, string>;

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function tempRoot(): Promise<string> {
  const root = await makeTempDir("threenative-three-compat-");
  roots.push(root);
  return root;
}

function blobHash(contents: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
}

/** A full, registered Three.js tree at the exact bytes the previous release shipped. */
async function installedTree(): Promise<{
  packageRoot: string;
  threeRoot: string;
}> {
  const root = await tempRoot();
  const packageRoot = join(root, "core");
  const threeRoot = join(root, "three");
  await mkdir(join(packageRoot, "patches"), { recursive: true });
  await writeFile(join(packageRoot, "patches", "three@0.185.1.patch"), BASE_PATCH, "utf8");
  await writeFile(
    join(packageRoot, "patches", "three@0.185.1-prd269-upgrade.patch"),
    UPGRADE_TEXT,
    "utf8",
  );
  await mkdir(threeRoot, { recursive: true });
  await writeFile(
    join(threeRoot, "package.json"),
    `${JSON.stringify({ name: "three", version: "0.185.1" })}\n`,
    "utf8",
  );
  for (const [rel, contents] of Object.entries(FIXTURE.targetTexts)) {
    await mkdir(dirname(join(threeRoot, rel)), { recursive: true });
    await writeFile(join(threeRoot, rel), contents, "utf8");
  }
  return { packageRoot, threeRoot };
}

/** Invert the frozen legacy hunks to materialise the exact predecessor bytes for one entry. */
async function legacyPredecessor(path: string, oldHash: string): Promise<string> {
  const developRefresh = DEVELOP_REFRESH_PREDECESSORS[`${path}:${oldHash}`];
  if (developRefresh !== undefined && blobHash(developRefresh) === oldHash) return developRefresh;
  const recorded = GEOMETRY_CACHE_PREDECESSORS[path];
  if (recorded !== undefined && blobHash(recorded) === oldHash) return recorded;
  const resourceLifetime = RESOURCE_LIFETIME_PREDECESSORS[path];
  if (resourceLifetime !== undefined && blobHash(resourceLifetime) === oldHash) {
    return resourceLifetime;
  }
  const root = await tempRoot();
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  const targetText = FIXTURE.targetTexts[path];
  expect(targetText).toBeDefined();
  await writeFile(file, targetText as string, "utf8");
  const block = FIXTURE.originalUpgradePatch.split(/(?=^diff --git )/mu).find((section) => {
    const candidate = /^diff --git a\/(\S+) /mu.exec(section)?.[1];
    const hash = /^index ([a-f0-9]{40})\.\./mu.exec(section)?.[1];
    return candidate === path && hash === oldHash;
  });
  const patchFile = join(root, "one.patch");
  const baseBlock = FIXTURE.originalBasePatch
    .split(/(?=^diff --git )/mu)
    .find((section) => section.startsWith(`diff --git a/${path} `));
  expect(block ?? baseBlock, `no frozen hunk for ${path} ${oldHash}`).toBeDefined();
  await writeFile(patchFile, block ?? baseBlock ?? "", "utf8");
  await run("patch", ["--reverse", "--batch", "--fuzz=0", "--silent", "-p1", "-i", patchFile], {
    cwd: root,
  });
  if (block === undefined) {
    const generatedPatch = brotliDecompressSync(
      readFileSync(join(testDir, "fixtures", "generated-three-patch.patch.br")),
    ).toString("utf8");
    const generatedBlock = generatedPatch
      .split(/(?=^diff --git )/mu)
      .find((section) => section.startsWith(`diff --git a/${path} `));
    expect(generatedBlock).toBeDefined();
    await writeFile(patchFile, generatedBlock ?? "");
    await run("patch", ["--batch", "--fuzz=0", "--silent", "-p1", "-i", patchFile], { cwd: root });
  }
  const contents = await readFile(file, "utf8");
  expect(blobHash(contents), `predecessor ${path} ${oldHash}`).toBe(oldHash);
  return contents;
}

const STOCK_TEXT = "const alpha = 1;\n";
const TARGET_TEXT = "const alpha = 1; // threenative\n";
const TARGET_BLOB = blobHash(TARGET_TEXT);
const STOCK_BLOB = blobHash(STOCK_TEXT);
const COMMIT = "2431a09f46f34c560bc8e44b33be0e567723d5b9";

const TINY_BASE = `diff --git a/src/thing.js b/src/thing.js
index ${STOCK_BLOB}..${TARGET_BLOB} 100644
--- a/src/thing.js
+++ b/src/thing.js
@@ -1,1 +1,1 @@
-const alpha = 1;
+const alpha = 1; // threenative
`;

function tinyUpgrade(overrides: Record<string, unknown> = {}): string {
  const json = {
    version: 2,
    generator: "scripts/generate-three-patch.mjs",
    pin: { commit: COMMIT, version: "0.185.1" },
    acceptedLegacyCompatPairs: [
      { path: "src/thing.js", oldHash: blobHash("old\n"), newHash: TARGET_BLOB },
    ],
    acceptedLegacyFinalHashes: { "src/thing.js": TARGET_BLOB },
    generatedFinalHashes: { "src/thing.js": TARGET_BLOB },
    bundleBrotliBase64: brotliCompressSync(
      Buffer.from(JSON.stringify({ "src/thing.js": TARGET_TEXT })),
    ).toString("base64"),
    ...overrides,
  };
  return `${JSON.stringify(json)}\n`;
}

async function tinyTree(
  upgradeText: string,
  baseText = TINY_BASE,
): Promise<{
  packageRoot: string;
  threeRoot: string;
}> {
  const root = await tempRoot();
  const packageRoot = join(root, "core");
  const threeRoot = join(root, "three");
  await mkdir(join(packageRoot, "patches"), { recursive: true });
  await writeFile(join(packageRoot, "patches", "three@0.185.1.patch"), baseText, "utf8");
  await writeFile(
    join(packageRoot, "patches", "three@0.185.1-prd269-upgrade.patch"),
    upgradeText,
    "utf8",
  );
  await mkdir(join(threeRoot, "src"), { recursive: true });
  await writeFile(
    join(threeRoot, "package.json"),
    `${JSON.stringify({ name: "three", version: "0.185.1" })}\n`,
    "utf8",
  );
  await writeFile(join(threeRoot, "src", "thing.js"), STOCK_TEXT, "utf8");
  return { packageRoot, threeRoot };
}

describe("the versioned JSON upgrade patch", () => {
  it("frozen fixture matches the shipped final hashes for all registered targets", () => {
    expect(Object.keys(FIXTURE.targetTexts).sort()).toEqual(
      Object.keys(UPGRADE.acceptedLegacyFinalHashes).sort(),
    );
    for (const [rel, hash] of Object.entries(UPGRADE.acceptedLegacyFinalHashes)) {
      expect(blobHash(FIXTURE.targetTexts[rel] ?? ""), rel).toBe(hash);
    }
  });

  it("recognises every registered compat predecessor and lands on the generated target", async () => {
    const { packageRoot, threeRoot } = await installedTree();
    for (const pair of UPGRADE.acceptedLegacyCompatPairs) {
      const predecessor = await legacyPredecessor(pair.path, pair.oldHash);
      await writeFile(join(threeRoot, pair.path), predecessor, "utf8");
      await expect(applyThreePatch({ packageRoot, threeRoot }), pair.oldHash).resolves.toBe(
        pair.oldHash === UPGRADE.generatedFinalHashes[pair.path] ? "unchanged" : "patched",
      );
      expect(
        blobHash(await readFile(join(threeRoot, pair.path), "utf8")),
        `${pair.path} ${pair.oldHash}`,
      ).toBe(UPGRADE.generatedFinalHashes[pair.path]);
      await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("unchanged");
    }
  });

  it("migrates all 30 previously shipped finals to the generated target", async () => {
    const { packageRoot, threeRoot } = await installedTree();
    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("patched");
    for (const rel of Object.keys(UPGRADE.generatedFinalHashes)) {
      expect(blobHash(await readFile(join(threeRoot, rel), "utf8")), rel).toBe(
        UPGRADE.generatedFinalHashes[rel],
      );
    }
    await expect(applyThreePatch({ packageRoot, threeRoot })).resolves.toBe("unchanged");
  });

  it("refuses one custom byte and writes no recognised file", async () => {
    const { packageRoot, threeRoot } = await installedTree();
    const edited = join(threeRoot, "src/renderers/common/Renderer.js");
    const untouched = join(threeRoot, "build/three.webgpu.js");
    await writeFile(edited, `${await readFile(edited, "utf8")} `, "utf8");
    const before = await readFile(untouched, "utf8");
    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /TN_THREE_PATCH_PARTIAL/,
    );
    expect(await readFile(edited, "utf8")).toBe(
      `${FIXTURE.targetTexts["src/renderers/common/Renderer.js"]} `,
    );
    expect(await readFile(untouched, "utf8")).toBe(before);
  });

  it("rejects an unsupported version, schema drift, and a duplicate compat pair", async () => {
    const pair = {
      path: "src/thing.js",
      oldHash: blobHash("old\n"),
      newHash: TARGET_BLOB,
    };
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["version", { version: 1 }, /unsupported upgrade version/u],
      ["schema", { acceptedLegacyCompatPairs: "nope" }, /non-empty array/u],
      ["pin", { pin: {} }, /pin must name/u],
      ["duplicate", { acceptedLegacyCompatPairs: [pair, { ...pair }] }, /duplicate compat pair/u],
      ["unsafe", { acceptedLegacyFinalHashes: { "../evil.js": TARGET_BLOB } }, /unsafe/u],
      [
        "compat-final",
        {
          acceptedLegacyCompatPairs: [
            { path: "src/thing.js", oldHash: pair.oldHash, newHash: "d".repeat(40) },
          ],
        },
        /does not match its accepted final hash/u,
      ],
    ];
    for (const [name, override, expected] of cases) {
      const { packageRoot, threeRoot } = await tinyTree(tinyUpgrade(override));
      await expect(applyThreePatch({ packageRoot, threeRoot }), name).rejects.toThrow(expected);
    }
  });

  it("rejects mismatched payloads, bad base64, a decompression bomb, and a missing target", async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        "mismatched payload hash",
        {
          bundleBrotliBase64: brotliCompressSync(
            Buffer.from(JSON.stringify({ "src/thing.js": "const alpha = 1; // other\n" })),
          ).toString("base64"),
        },
        /does not match its generated hash/u,
      ],
      ["bad base64", { bundleBrotliBase64: "not base64!!" }, /not valid base64/u],
      [
        "decompression bomb",
        {
          bundleBrotliBase64: brotliCompressSync(
            Buffer.from(JSON.stringify({ "src/thing.js": "a".repeat(9 * 1024 * 1024) })),
          ).toString("base64"),
        },
        /bounded Brotli payload/u,
      ],
      ["missing target", { generatedFinalHashes: { "src/other.js": TARGET_BLOB } }, /base patch/u],
    ];
    for (const [name, override, expected] of cases) {
      const { packageRoot, threeRoot } = await tinyTree(tinyUpgrade(override));
      await expect(applyThreePatch({ packageRoot, threeRoot }), name).rejects.toThrow(expected);
    }
  });

  it("rejects a wrong pin even when the consumer already holds the current target", async () => {
    const cases: [string, { commit: string; version: string }][] = [
      ["wrong version", { commit: COMMIT, version: "999.0.0" }],
      ["wrong commit", { commit: "0".repeat(40), version: "0.185.1" }],
    ];
    for (const [name, pin] of cases) {
      const { packageRoot, threeRoot } = await tinyTree(tinyUpgrade({ pin }));
      await writeFile(join(threeRoot, "src", "thing.js"), TARGET_TEXT, "utf8");
      await expect(applyThreePatch({ packageRoot, threeRoot }), name).rejects.toThrow(
        /pin must name/u,
      );
    }
  });

  it("rejects a bundle missing the target for a registered predecessor when already current", async () => {
    const { packageRoot, threeRoot } = await tinyTree(
      tinyUpgrade({
        bundleBrotliBase64: brotliCompressSync(Buffer.from("{}")).toString("base64"),
      }),
    );
    await writeFile(join(threeRoot, "src", "thing.js"), TARGET_TEXT, "utf8");
    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /missing the target/u,
    );
  });

  it("refuses a stock hunk whose new text does not match the patch index blob", async () => {
    const corrupted = TINY_BASE.replace(
      "+const alpha = 1; // threenative\n",
      "+const alpha = 1; // tampered\n",
    );
    const { packageRoot, threeRoot } = await tinyTree(tinyUpgrade(), corrupted);
    await expect(applyThreePatch({ packageRoot, threeRoot })).rejects.toThrow(
      /does not match the base patch index blob/u,
    );
    await expect(readFile(join(threeRoot, "src", "thing.js"), "utf8")).resolves.toBe(STOCK_TEXT);
  });
});
