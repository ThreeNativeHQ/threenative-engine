import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFixtureDocument } from "../../../test-support/generate-fixture-model.js";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir, makeTempDirSync } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import {
  type IAssetPass,
  type IAssetWatchHandle,
  type IAssetWatchSummary,
  watchAssets,
} from "../src/index.js";
import { unpackGlb } from "../src/passes/shared-images.js";

const DEBOUNCE_MS = 25;
// The burst test needs a window wider than the burst that is supposed to fit inside it, and a
// fixed number has now failed that twice: 60ms was wide enough on an idle machine and not on a
// loaded CI runner, and the 500ms that replaced it was overrun in turn by a 743ms burst
// ("the burst took 743ms and does not fit the 500ms window"). Each time the watcher compiled after
// write 1 and the test failed on compiled content rather than on the coalescing it exists to check.
//
// A constant is a schedule racing machine speed, so raising it again only moves the machine where
// it breaks. This measures the very operation that has to fit - five sequential writes, on this
// machine, on this filesystem - immediately at load, and sizes the window from that. The floor
// keeps a fast machine from picking a window so tight that scheduling noise alone defeats it.
//
// Those overruns came from `await writeFile` bursts. The coalescing test now writes synchronously,
// so it cannot race any window and asserts no burst duration; only the async fail-closed test does.
const BURST_WRITES = 5;

function measureBurstCostMs(): number {
  // makeTempDirSync, not mkdtempSync: scripts/__tests__/temp-dir-guard.spec.ts requires every
  // test-owned temporary directory to come from the helper that registers its cleanup.
  const probeDir = makeTempDirSync("threenative-watch-calibrate-");
  const probe = join(probeDir, "probe.bin");
  try {
    const started = Date.now();
    for (let index = 1; index <= BURST_WRITES; index += 1) {
      writeFileSync(probe, `calibration write ${index}`);
    }
    return Date.now() - started;
  } finally {
    rmSync(probeDir, { force: true, recursive: true });
  }
}

const BURST_DEBOUNCE_MS = Math.max(500, measureBurstCostMs() * 8);

const manifestWriteProbe = vi.hoisted(() => ({
  onPartial: undefined as ((filename: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      const filename = String(args[0]);
      const finalName = `${path.sep}assets.manifest.json`;
      const stagingPrefix = `${finalName}.`;
      const isManifest = filename.endsWith(finalName) || filename.includes(stagingPrefix);
      if (!isManifest || manifestWriteProbe.onPartial === undefined) {
        return original.writeFile(...args);
      }
      const bytes = Buffer.from(String(args[1]), "utf8");
      const split = Math.max(1, Math.floor(bytes.length / 2));
      const handle = await original.open(filename, "w");
      try {
        await handle.write(bytes.subarray(0, split));
        await manifestWriteProbe.onPartial(filename);
        await handle.write(bytes.subarray(split));
      } finally {
        await handle.close();
      }
    },
  };
});

interface IBurstRecorder {
  onChange(summary: IAssetWatchSummary): void;
  readonly summaries: IAssetWatchSummary[];
  waitForCount(target: number): Promise<void>;
}

/** Collects burst summaries and lets tests await a deterministic burst count instead of sleeps. */
function createBurstRecorder(): IBurstRecorder {
  const summaries: IAssetWatchSummary[] = [];
  const waiters: Array<() => void> = [];
  return {
    onChange: (summary) => {
      summaries.push(summary);
      for (const waiter of waiters.splice(0)) waiter();
    },
    summaries,
    waitForCount: (target) =>
      summaries.length >= target
        ? Promise.resolve()
        : new Promise((resolve) => {
            waiters.push(() => {
              if (summaries.length >= target) resolve();
            });
          }),
  };
}

const openHandles: IAssetWatchHandle[] = [];

afterEach(() => {
  for (const handle of openHandles.splice(0)) handle.close();
});

interface IManifestEntry {
  readonly format?: string;
  readonly output: string;
  readonly sharedImages?: readonly { readonly bytes: number; readonly output: string }[];
}

function requireEntry(
  entries: Record<string, IManifestEntry | undefined>,
  logical: string,
): IManifestEntry {
  const entry = entries[logical];
  if (entry === undefined || entry.output === undefined) {
    throw new Error(`manifest has no usable '${logical}' entry`);
  }
  return entry;
}

function readManifestEntries(manifestPath: string): Promise<Record<string, IManifestEntry>> {
  return readFile(manifestPath, "utf8").then((raw): Record<string, IManifestEntry> => {
    const entries = (JSON.parse(raw) as { entries?: Record<string, IManifestEntry> }).entries;
    return entries ?? {};
  });
}

/** The skinned fixture with a seed-keyed base-colour map and a constant normal map. */
async function texturedGlb(seed: number): Promise<Buffer> {
  const document = buildFixtureDocument();
  const [baseColor, normal] = document.getRoot().listTextures();
  baseColor
    ?.setImage(
      rgbaPng({
        blue: (x) => (x * 4 + seed) % 256,
        height: 32,
        red: (x, y) => (x + y) % 256,
        width: 32,
      }),
    )
    .setMimeType("image/png");
  normal
    ?.setImage(
      rgbaPng({
        blue: () => 255,
        green: (_x, y) => 128 + (y % 5),
        height: 32,
        red: (x) => 128 + (x % 7),
        width: 32,
      }),
    )
    .setMimeType("image/png");
  return Buffer.from(await new NodeIO().writeBinary(document));
}

/**
 * Everything the manifest promises for one cooked model is on disk: every shared image it
 * declares, every image uri the served GLB resolves against its own directory — which is what
 * GLTFLoader actually fetches — and the Basis runtime a transcoded image is decoded by.
 */
async function expectServable(
  publicDirectory: string,
  manifestPath: string,
  logical: string,
): Promise<void> {
  const entry = requireEntry(await readManifestEntries(manifestPath), logical);
  const declared = entry.sharedImages ?? [];
  // Fail on the premise, not a downstream symptom: a fixture that stopped sharing its images
  // would make every loop below pass over an empty list.
  expect(
    declared.length,
    `'${logical}' declared no shared images, so this test proves nothing about publishing them`,
  ).toBeGreaterThan(0);
  for (const image of declared) {
    // The whole image, not a placeholder: the manifest declares how many bytes the game will
    // fetch, and an image the pass shipped as authored (a normal map that does not compress
    // smaller) is as much a published file as a transcoded one.
    const bytes = await readFile(path.join(publicDirectory, image.output));
    expect(bytes.length).toBe(image.bytes);
    expect(bytes.length).toBeGreaterThan(0);
  }
  const servedPath = path.join(publicDirectory, entry.output);
  const uris = (unpackGlb(await readFile(servedPath)).json.images ?? []).map((image) => image.uri);
  expect(uris.length).toBeGreaterThan(0);
  for (const uri of uris) {
    expect(uri).toBeDefined();
    await expect(stat(path.resolve(path.dirname(servedPath), uri ?? ""))).resolves.toBeDefined();
  }
  for (const name of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    await expect(stat(path.join(publicDirectory, "basis", name))).resolves.toBeDefined();
  }
}

/** Every file under the output root, relative to it, with `/` separators. */
async function walkFiles(root: string, directory = ""): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = directory === "" ? item.name : `${directory}/${item.name}`;
    if (item.isDirectory()) found.push(...(await walkFiles(root, relative)));
    else found.push(relative);
  }
  return found;
}

/**
 * The output root holds exactly what the last cook owns: the files its receipt lists, the two
 * records it writes, and the paths it never wrote and must never remove. Anything else is an
 * orphan — a file the game still fetches after nothing points at it, or one the next delete-test
 * will not clean up because no receipt claims it.
 */
async function expectOnlyOwnedOutputs(
  publicDirectory: string,
  unowned: readonly string[],
): Promise<void> {
  const receipt = JSON.parse(
    await readFile(path.join(publicDirectory, "bake.receipt.json"), "utf8"),
  ) as { outputs?: readonly { path: string }[] };
  const owned = (receipt.outputs ?? []).map((output) => output.path);
  expect(owned.length, "the receipt owns nothing, so this proves nothing").toBeGreaterThan(0);
  expect((await walkFiles(publicDirectory)).sort()).toEqual(
    [...owned, ...unowned, "assets.manifest.json", "bake.receipt.json"].sort(),
  );
  // And the manifest promises nothing the receipt does not own: an entry whose output no cook
  // claims is the same orphan seen from the other end.
  const entries = await readManifestEntries(path.join(publicDirectory, "assets.manifest.json"));
  for (const entry of Object.values(entries)) {
    expect(owned).toContain(entry.output);
    for (const image of entry.sharedImages ?? []) expect(owned).toContain(image.output);
  }
}

/**
 * Polls for something a burst settles without announcing: a burst that only deleted files
 * compiles nothing, so `onChange` is not called for it and there is no callback to await.
 */
async function waitUntil(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("watchAssets", () => {
  it("should serve a Meshopt-compressed source byte-identical under models: none on the initial compile", async () => {
    // Wildwood's dev watcher died on its initial compile: the health pass could not decode a
    // Meshopt source, so no manifest was written and the game served whatever stale public/
    // copy was left from an older build. `models: "none"` promises the served bytes are the
    // source bytes; the watcher's first compile must honour that for a compressed source.
    const { buildFixtureGlb } = await import("../../../test-support/generate-fixture-model.js");
    const { modelPass } = await import("../src/passes/model.js");
    const compressed = await modelPass().apply(Buffer.from(await buildFixtureGlb()), "pine.glb");
    if (Buffer.isBuffer(compressed)) throw new Error("the model pass did not compress the fixture");
    const root = await makeTempDir("threenative-watch-meshopt-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "pine.glb"), compressed.buffer);
    openHandles.push(
      watchAssets({
        config: { models: "none" },
        cwd: root,
        debounceMs: DEBOUNCE_MS,
        onChange: () => {},
      }),
    );
    await openHandles[0]?.ready;

    const publicDirectory = path.join(root, "public");
    const entries = await readManifestEntries(path.join(publicDirectory, "assets.manifest.json"));
    const served = await readFile(
      path.join(publicDirectory, requireEntry(entries, "pine.glb").output),
    );
    const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    expect(sha(served)).toBe(sha(compressed.buffer));
  });

  it("should recompile only the changed input", async () => {
    const root = await makeTempDir("threenative-watch-changed-");
    await mkdir(path.join(root, "assets"));
    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({ height: 64, red: (x) => x * 4, width: 64 }),
    );
    await writeFile(
      path.join(root, "assets", "shield.png"),
      rgbaPng({ blue: () => 90, green: () => 200, height: 32, width: 32 }),
    );
    const recorder = createBurstRecorder();
    openHandles.push(
      watchAssets({
        config: { textures: { overrides: [{ glob: "rock.png", codec: "etc1s" }] } },
        cwd: root,
        debounceMs: DEBOUNCE_MS,
        onChange: recorder.onChange,
        // A decoder-capable page (`engine: "threejs"`) names its decoders; the default has none.
        runtimeDecoders: { ktx2: true, meshopt: true },
        transcoder: basisTranscoderPaths(),
        // This case is about publishing the KTX2 runtime; a 32-pixel fixture cannot repay it.
        modelTranscoderBytes: 0,
      }),
    );
    await openHandles[0]?.ready;

    const publicDirectory = path.join(root, "public");
    const manifestPath = path.join(publicDirectory, "assets.manifest.json");
    const initialEntries = await readManifestEntries(manifestPath);
    expect(requireEntry(initialEntries, "rock.png").format).toBe("etc1s");
    const knightPath = path.join(
      publicDirectory,
      requireEntry(initialEntries, "shield.png").output,
    );
    const knightMtimeBefore = (await stat(knightPath)).mtimeMs;

    await writeFile(
      path.join(root, "assets", "rock.png"),
      rgbaPng({ height: 64, red: (x) => 255 - x * 4, width: 64 }),
    );
    await recorder.waitForCount(1);

    // The burst carries the same per-pass cost records a build emits (PRD-318).
    expect(recorder.summaries[0]).toEqual({
      compiled: ["rock.png"],
      failed: [],
      passCosts: expect.any(Array),
    });
    expect(recorder.summaries[0]?.passCosts?.map((row) => row.pass)).toEqual([
      "audio",
      "ktx2",
      "model",
    ]);
    // One ran input and one cached one in every pass: the burst cooks the whole project, and the
    // asset nobody touched is a cache hit rather than a re-encode.
    expect(
      recorder.summaries[0]?.passCosts?.every(
        (row) => row.status === "ran" && row.ranInputs === 1 && row.cachedInputs === 1,
      ),
    ).toBe(true);
    const updatedEntries = await readManifestEntries(manifestPath);
    expect(requireEntry(updatedEntries, "rock.png").output).not.toBe(
      requireEntry(initialEntries, "rock.png").output,
    );
    const recompiled = await readFile(
      path.join(publicDirectory, requireEntry(updatedEntries, "rock.png").output),
    );
    // The dev save produced what a build would: KTX2 bytes, not the raw source.
    expect([...recompiled.subarray(1, 7)].map((byte) => String.fromCharCode(byte)).join("")).toBe(
      "KTX 20",
    );
    expect(requireEntry(updatedEntries, "rock.png").format).toBe("etc1s");
    expect(updatedEntries["shield.png"]).toEqual(initialEntries["shield.png"]);
    expect((await stat(knightPath)).mtimeMs).toBe(knightMtimeBefore);
  });

  it("should cook loadable models for the default engine when the caller names no decoders", async () => {
    // A pre-0.3.5 vite config calls watchAssets without runtimeDecoders. The default web engine
    // decodes no Meshopt, so a Meshopt model from that dev loop would refuse to load.
    const root = await makeTempDir("threenative-watch-default-decoders-");
    await mkdir(path.join(root, "assets"));
    const { buildFixtureGlb } = await import("../../../test-support/generate-fixture-model.js");
    await writeFile(
      path.join(root, "assets", "post.glb"),
      await buildFixtureGlb({ textured: false }),
    );
    const recorder = createBurstRecorder();
    openHandles.push(
      watchAssets({ cwd: root, debounceMs: DEBOUNCE_MS, onChange: recorder.onChange }),
    );
    await openHandles[0]?.ready;
    const manifest = JSON.parse(
      await readFile(path.join(root, "public", "assets.manifest.json"), "utf8"),
    ) as { entries: Record<string, { extensions?: string[] }> };
    expect(manifest.entries["post.glb"]).toBeDefined();
    expect(manifest.entries["post.glb"]?.extensions ?? []).not.toContain("EXT_meshopt_compression");
  });

  it("should keep the last manifest readable while publishing a replacement", async () => {
    const root = await makeTempDir("threenative-watch-manifest-publication-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "town.txt"), "town v1");
    const recorder = createBurstRecorder();
    openHandles.push(
      watchAssets({ cwd: root, debounceMs: DEBOUNCE_MS, onChange: recorder.onChange }),
    );
    await openHandles[0]?.ready;

    const manifestPath = path.join(root, "public", "assets.manifest.json");
    const previous = await readFile(manifestPath, "utf8");
    let release = () => {};
    const partial = new Promise<void>((resolve) => {
      manifestWriteProbe.onPartial = async () => {
        resolve();
        await new Promise<void>((resume) => {
          release = resume;
        });
      };
    });
    try {
      await writeFile(path.join(root, "assets", "town.txt"), "town v2");
      await partial;
      await expect(readFile(manifestPath, "utf8")).resolves.toBe(previous);
      release();
      await recorder.waitForCount(1);
      expect(await readFile(manifestPath, "utf8")).not.toBe(previous);
    } finally {
      release();
      manifestWriteProbe.onPartial = undefined;
    }
  });

  it("should keep the previous output when compilation throws", async () => {
    const root = await makeTempDir("threenative-watch-throws-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), "good png");
    const explode: IAssetPass = {
      name: "explode",
      apply: (input) => {
        if (input.toString("utf8").includes("corrupt")) throw new Error("boom");
        return input;
      },
    };
    const recorder = createBurstRecorder();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      openHandles.push(
        watchAssets({
          cwd: root,
          debounceMs: DEBOUNCE_MS,
          onChange: recorder.onChange,
          passes: [explode],
        }),
      );
      await openHandles[0]?.ready;

      const publicDirectory = path.join(root, "public");
      const manifestPath = path.join(publicDirectory, "assets.manifest.json");
      const manifestRaw = await readFile(manifestPath, "utf8");
      const rockOutput = requireEntry(await readManifestEntries(manifestPath), "rock.png").output;
      const outputPath = path.join(publicDirectory, rockOutput);
      const bytesBefore = await readFile(outputPath);

      await writeFile(path.join(root, "assets", "rock.png"), "corrupt png");
      await recorder.waitForCount(1);

      expect(recorder.summaries[0]).toEqual({ compiled: [], failed: ["rock.png"] });
      const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(logged).toMatch(/TN_ASSETS_WATCH_FAILED/u);
      expect(logged).toMatch(/rock\.png/u);
      expect(await readFile(manifestPath, "utf8")).toBe(manifestRaw);
      expect((await readFile(outputPath)).equals(bytesBefore)).toBe(true);
      // The receipt is part of a successful compile's output, so the last good one survives the
      // failure exactly as the manifest and the compiled bytes do.
      expect(await readdir(publicDirectory)).toEqual(
        ["assets.manifest.json", "bake.receipt.json", rockOutput].sort(),
      );

      // Fixing the input heals the deviation: the next burst recompiles and updates the manifest.
      await writeFile(path.join(root, "assets", "rock.png"), "fixed png");
      await recorder.waitForCount(2);
      expect(recorder.summaries[1]).toEqual({
        compiled: ["rock.png"],
        failed: [],
        passCosts: expect.any(Array),
      });
      expect(recorder.summaries[1]?.passCosts?.map((row) => row.pass)).toEqual(["explode"]);
      expect(await readFile(manifestPath, "utf8")).not.toBe(manifestRaw);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("should debounce a burst of writes into one recompile", async () => {
    const root = await makeTempDir("threenative-watch-debounce-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), "before burst");
    const recorder = createBurstRecorder();
    // Identity compilation keeps the assertion on coalescing itself rather than on encoding.
    openHandles.push(
      watchAssets({
        cwd: root,
        config: { textures: "none" },
        debounceMs: BURST_DEBOUNCE_MS,
        onChange: recorder.onChange,
      }),
    );
    await openHandles[0]?.ready;

    // Synchronous on purpose: fs.watch delivers on this thread, so no event is even queued, let
    // alone a debounce timer fired, until the whole burst has landed. However long a loaded runner
    // takes over the five writes (506-783ms overran the old duration check on CI), they are one
    // burst by construction, and every assertion below measures the watcher, not the machine.
    for (let index = 1; index <= BURST_WRITES; index += 1) {
      writeFileSync(path.join(root, "assets", "rock.png"), `burst write ${index}`);
    }
    await recorder.waitForCount(1);
    // Any straggler event outside the debounced burst would have fired well within 3 windows.
    await new Promise((resolve) => setTimeout(resolve, BURST_DEBOUNCE_MS * 3));

    expect(recorder.summaries).toHaveLength(1);
    expect(recorder.summaries[0]).toEqual({
      compiled: ["rock.png"],
      failed: [],
      passCosts: expect.any(Array),
    });
    // textures: "none" drops the ktx2 pass; the model pass still ran and reports itself.
    expect(recorder.summaries[0]?.passCosts?.map((row) => row.pass)).toEqual(["audio", "model"]);
    const entries = await readManifestEntries(path.join(root, "public", "assets.manifest.json"));
    const compiled = await readFile(
      path.join(root, "public", requireEntry(entries, "rock.png").output),
      "utf8",
    );
    expect(compiled).toBe("burst write 5");
  });

  it("should publish a textured model's shared images and Basis runtime, not only its GLB", async () => {
    // A dev save of a textured model is not one file. Shared images cook on by default, so the
    // save that adds or changes a model also writes the images it references and the Basis
    // runtime the KTX2 loader fetches for them. The burst compiled all of that inside a scratch
    // directory, copied the GLB alone out of it and deleted the rest, then merged a manifest
    // entry pointing the served model at files that were never published: textures 404 in the
    // dev loop and reappear only after a restart.
    const root = await makeTempDir("threenative-watch-shared-");
    await mkdir(path.join(root, "assets", "props"), { recursive: true });
    const { buildFixtureGlb } = await import("../../../test-support/generate-fixture-model.js");
    // An untextured seed, so nothing shared and no transcoder exists before the burst runs and
    // the burst is the only thing that can put either on disk.
    await writeFile(
      path.join(root, "assets", "props", "post.glb"),
      await buildFixtureGlb({ textured: false }),
    );
    const recorder = createBurstRecorder();
    openHandles.push(
      watchAssets({
        // The tiny fixture auto-selects JPEG; force a Basis-backed rung to test runtime publishing.
        config: {
          models: { textures: { overrides: [{ slot: "baseColorTexture", codec: "uastc" }] } },
        },
        cwd: root,
        debounceMs: DEBOUNCE_MS,
        onChange: recorder.onChange,
        runtimeDecoders: { ktx2: true, meshopt: true },
        transcoder: basisTranscoderPaths(),
        // This case is about publishing the KTX2 runtime; a 32-pixel fixture cannot repay it.
        modelTranscoderBytes: 0,
      }),
    );
    await openHandles[0]?.ready;

    const publicDirectory = path.join(root, "public");
    const manifestPath = path.join(publicDirectory, "assets.manifest.json");
    const seeded = await readdir(publicDirectory);
    expect(seeded).not.toContain("shared");
    expect(seeded).not.toContain("basis");

    // Added: a model nothing in public/ has ever carried an image for.
    await writeFile(path.join(root, "assets", "props", "oak.glb"), await texturedGlb(11));
    await recorder.waitForCount(1);
    expect(recorder.summaries[0]?.compiled).toEqual(["props/oak.glb"]);
    expect(recorder.summaries[0]?.failed).toEqual([]);
    await expectServable(publicDirectory, manifestPath, "props/oak.glb");

    // Modified: a repainted base-colour map is a new content-addressed shared image, and the
    // unchanged normal map is one already on disk that must not be rewritten.
    const declaredBefore = (
      requireEntry(await readManifestEntries(manifestPath), "props/oak.glb").sharedImages ?? []
    ).map((image) => image.output);
    const mtimesBefore = new Map(
      await Promise.all(
        declaredBefore.map(
          async (output): Promise<[string, number]> => [
            output,
            (await stat(path.join(publicDirectory, output))).mtimeMs,
          ],
        ),
      ),
    );
    await writeFile(path.join(root, "assets", "props", "oak.glb"), await texturedGlb(200));
    await recorder.waitForCount(2);
    expect(recorder.summaries[1]?.compiled).toEqual(["props/oak.glb"]);
    expect(recorder.summaries[1]?.failed).toEqual([]);
    await expectServable(publicDirectory, manifestPath, "props/oak.glb");
    const declaredAfter = (
      requireEntry(await readManifestEntries(manifestPath), "props/oak.glb").sharedImages ?? []
    ).map((image) => image.output);
    expect([...declaredAfter].sort()).not.toEqual([...declaredBefore].sort());
    const carried = declaredAfter.filter((output) => mtimesBefore.has(output));
    expect(
      carried.length,
      "no shared image survived the repaint, so nothing here proves a published one is left alone",
    ).toBeGreaterThan(0);
    for (const output of carried) {
      // Content-addressed and shared: rewriting it would churn a file every other model that
      // carries the same map is already pointing at.
      expect((await stat(path.join(publicDirectory, output))).mtimeMs).toBe(
        mtimesBefore.get(output),
      );
    }
  });

  it("should fail the burst when a second small asset breaks the whole-project budget", async () => {
    // A byte ceiling is for the game, not for the file being saved. Two assets that each fit
    // under it do not both fit, and the save that adds the second one is the moment a dev can
    // still act on it. A burst that cooks only the changed file measures only the changed file:
    // it publishes the asset that broke the ceiling and reports success, and the build that
    // finally measures the project fails hours later on someone else's machine.
    const root = await makeTempDir("threenative-watch-budget-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "notes.txt"), "a".repeat(1000));
    const recorder = createBurstRecorder();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      openHandles.push(
        watchAssets({
          config: { budget: { total: 1500 } },
          cwd: root,
          debounceMs: DEBOUNCE_MS,
          onChange: recorder.onChange,
        }),
      );
      await openHandles[0]?.ready;

      const manifestPath = path.join(root, "public", "assets.manifest.json");
      // Fail on the premise: one asset has to be under the ceiling, or the second one is not
      // what broke it.
      const seeded = requireEntry(await readManifestEntries(manifestPath), "notes.txt");
      expect((await stat(path.join(root, "public", seeded.output))).size).toBeLessThan(1500);

      await writeFile(path.join(root, "assets", "credits.txt"), "b".repeat(1000));
      await recorder.waitForCount(1);

      expect(recorder.summaries[0]).toEqual({ compiled: [], failed: ["credits.txt"] });
      const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(logged).toMatch(/TN_ASSETS_WATCH_FAILED/u);
      expect(logged).toMatch(/TN_ASSETS_BUDGET_EXCEEDED/u);
      // Nothing the game fetches names the asset that broke the ceiling: the last cook that fit
      // keeps serving until a dev makes room.
      expect(await readManifestEntries(manifestPath)).not.toHaveProperty("credits.txt");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("should leave only receipt-owned outputs across add, edit and delete, sparing unowned files", async () => {
    const root = await makeTempDir("threenative-watch-ownership-");
    await mkdir(path.join(root, "assets"));
    await mkdir(path.join(root, "public", "vendor"), { recursive: true });
    // What public/ already holds in a real project: an index.html, a favicon, a vendored script.
    // No cook wrote it, so no cook may delete it — and it is not a stale output either.
    const unowned = path.join(root, "public", "vendor", "legacy.js");
    await writeFile(unowned, "// hand-written\n");
    // The compiler flags files that appear in its output root while it is cooking, by mtime. A
    // file written in the same millisecond the first compile starts would look like one of those.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(path.join(root, "assets", "town.txt"), "town v1");
    const recorder = createBurstRecorder();
    openHandles.push(
      watchAssets({ cwd: root, debounceMs: DEBOUNCE_MS, onChange: recorder.onChange }),
    );
    await openHandles[0]?.ready;

    const publicDirectory = path.join(root, "public");
    const manifestPath = path.join(publicDirectory, "assets.manifest.json");
    await expectOnlyOwnedOutputs(publicDirectory, ["vendor/legacy.js"]);

    // Added: a file the previous cook never saw.
    await writeFile(path.join(root, "assets", "props.txt"), "props v1");
    await recorder.waitForCount(1);
    expect(recorder.summaries[0]?.compiled).toEqual(["props.txt"]);
    await expectOnlyOwnedOutputs(publicDirectory, ["vendor/legacy.js"]);

    // Edited: new bytes get a new content-addressed name, so the output the dev was serving a
    // second ago is now an orphan unless the cook that replaced it also owns and removes it.
    const townBefore = requireEntry(await readManifestEntries(manifestPath), "town.txt").output;
    await writeFile(path.join(root, "assets", "town.txt"), "town v2");
    await recorder.waitForCount(2);
    const townAfter = requireEntry(await readManifestEntries(manifestPath), "town.txt").output;
    expect(townAfter).not.toBe(townBefore);
    await expect(stat(path.join(publicDirectory, townBefore))).rejects.toThrow();
    await expectOnlyOwnedOutputs(publicDirectory, ["vendor/legacy.js"]);

    // Deleted: a burst that compiles nothing still has to reconcile what the deletion left.
    const propsOutput = requireEntry(await readManifestEntries(manifestPath), "props.txt").output;
    const receiptPath = path.join(publicDirectory, "bake.receipt.json");
    const beforeDelete = JSON.parse(await readFile(receiptPath, "utf8")) as {
      outputs: { source: string }[];
    };
    const afterDelete = `${JSON.stringify(
      {
        ...beforeDelete,
        outputs: beforeDelete.outputs.filter((output) => output.source !== "props.txt"),
      },
      null,
      2,
    )}\n`;
    await rm(path.join(root, "assets", "props.txt"));
    await waitUntil(
      "the deleted asset to leave the manifest",
      async () => (await readManifestEntries(manifestPath))["props.txt"] === undefined,
    );
    // The receipt is published after stale-output cleanup. Wait for the complete expected
    // receipt, not merely the earlier manifest update (close() does not drain an active cook).
    await waitUntil(
      "the deletion receipt to commit",
      async () => (await readFile(receiptPath, "utf8")) === afterDelete,
    );
    await expect(stat(path.join(publicDirectory, propsOutput))).rejects.toThrow();
    await expectOnlyOwnedOutputs(publicDirectory, ["vendor/legacy.js"]);
    expect(await readFile(unowned, "utf8")).toBe("// hand-written\n");
  });

  it("should publish neither file when one asset in a burst is broken, then heal", async () => {
    // The cost of cooking the project per burst instead of per file: the burst is one compile, so
    // a file that cannot be cooked fails all of it and the good save beside it is not published
    // either. That is the direction to fail in — the last good cook keeps serving and the manifest
    // never points at half a burst — but it is a real difference from cooking each file alone, and
    // it is pinned here so nothing quietly starts publishing part of a failed burst.
    const root = await makeTempDir("threenative-watch-mixed-");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "rock.png"), "rock v1");
    const explode: IAssetPass = {
      name: "explode",
      apply: (input) => {
        if (input.toString("utf8").includes("corrupt")) throw new Error("boom");
        return input;
      },
    };
    const recorder = createBurstRecorder();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    try {
      openHandles.push(
        watchAssets({
          cwd: root,
          debounceMs: BURST_DEBOUNCE_MS,
          onChange: recorder.onChange,
          passes: [explode],
        }),
      );
      await openHandles[0]?.ready;

      const publicDirectory = path.join(root, "public");
      const manifestPath = path.join(publicDirectory, "assets.manifest.json");
      const servedBefore = requireEntry(await readManifestEntries(manifestPath), "rock.png").output;

      const burstStartedAt = Date.now();
      await writeFile(path.join(root, "assets", "rock.png"), "rock v2");
      await writeFile(path.join(root, "assets", "bomb.png"), "corrupt png");
      const burstMs = Date.now() - burstStartedAt;
      // Same premise check as the coalescing test: two writes outside one debounce window are two
      // bursts, and this test would then be measuring a machine rather than the fail-closed rule.
      expect(
        burstMs,
        `the two writes took ${burstMs}ms and do not fit the ${BURST_DEBOUNCE_MS}ms window they must share`,
      ).toBeLessThan(BURST_DEBOUNCE_MS);
      await recorder.waitForCount(1);

      expect(recorder.summaries[0]).toEqual({ compiled: [], failed: ["bomb.png", "rock.png"] });
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join("")).toMatch(/bomb\.png/u);
      // The good save is not published either: the game still fetches the last cook that held
      // together, entry for entry.
      const duringFailure = await readManifestEntries(manifestPath);
      expect(requireEntry(duringFailure, "rock.png").output).toBe(servedBefore);
      expect(duringFailure).not.toHaveProperty("bomb.png");
      expect(await readFile(path.join(publicDirectory, servedBefore), "utf8")).toBe("rock v1");

      // Fixing the one broken file publishes the whole burst, including the good save that was
      // held back — and leaves an output root that owns every file in it, the outputs the failed
      // cook wrote included.
      await writeFile(path.join(root, "assets", "bomb.png"), "bomb v1");
      await recorder.waitForCount(2);
      expect(recorder.summaries[1]?.compiled).toEqual(["bomb.png"]);
      const healed = await readManifestEntries(manifestPath);
      const readOutput = (entry: IManifestEntry): Promise<string> =>
        readFile(path.join(publicDirectory, entry.output), "utf8");
      expect(await readOutput(requireEntry(healed, "rock.png"))).toBe("rock v2");
      expect(await readOutput(requireEntry(healed, "bomb.png"))).toBe("bomb v1");
      await expect(stat(path.join(publicDirectory, servedBefore))).rejects.toThrow();
      await expectOnlyOwnedOutputs(publicDirectory, []);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
