import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { compileAssets } from "../../assets/src/compile.js";
import { animalBakePass, bakeWolf, bakeWolfToFile } from "../src/build.js";
import { parseAnimalBake } from "../src/format.js";
import { geometryFromValidatedBake, loadAnimalBake } from "../src/runtime.js";

const fault = vi.hoisted(() => ({ partialWrite: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (fault.partialWrite && String(args[0]).endsWith(".tmp")) {
        await fs.writeFile(args[0], "interrupted partial bake", args[2]);
        throw new Error("TN_ANIMAL_TEST_IO_INTERRUPTED");
      }
      return fs.writeFile(...args);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  fault.partialWrite = false;
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("actual pinned wolf build and normal asset cook", () => {
  it("regenerates identical bytes and invalidates actual cooked payloads for seed/tier", async () => {
    const root = await makeTempDir("tn-wolf-cook-");
    roots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "cooked");
    const destination = path.join(source, "wolf.animal");
    const first = await bakeWolfToFile({ seed: 7, tier: "crowd" }, destination);
    const run = () =>
      compileAssets({ cwd: root, source, output, concurrency: 1, passes: [animalBakePass()] });
    await run();
    const manifest1 = JSON.parse(await readFile(path.join(output, "assets.manifest.json"), "utf8"));
    const entry1 = manifest1.entries["wolf.animal"];
    expect(digest(await readFile(path.join(output, entry1.output)))).toBe(first);
    expect(await bakeWolfToFile({ seed: 7, tier: "crowd" }, destination)).toBe(first);
    await run();
    expect(await readFile(path.join(output, "assets.manifest.json"), "utf8")).toBe(
      `${JSON.stringify(manifest1, null, 2)}\n`,
    );
    const seed = await bakeWolfToFile({ seed: 8, tier: "crowd" }, destination);
    expect(seed).not.toBe(first);
    await run();
    const entry2 = JSON.parse(await readFile(path.join(output, "assets.manifest.json"), "utf8"))
      .entries["wolf.animal"];
    expect(entry2.output).not.toBe(entry1.output);
    expect(digest(await readFile(path.join(output, entry2.output)))).toBe(seed);
    const high = await bakeWolfToFile({ seed: 7, tier: "high" }, destination);
    expect(high).not.toBe(first);
    const bake = parseAnimalBake(Uint8Array.from(await readFile(destination)).buffer);
    expect(bake.params).toEqual(parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" })).params);
    await run();
    const entry3 = JSON.parse(await readFile(path.join(output, "assets.manifest.json"), "utf8"))
      .entries["wolf.animal"];
    expect(entry3.output).not.toBe(entry1.output);
    expect(digest(await readFile(path.join(output, entry3.output)))).toBe(high);
    expect(bake.bones.length).toBeLessThanOrEqual(128);
  }, 60_000);

  it("rejects unknown options/corrupt source without replacing valid source or manifest", async () => {
    const root = await makeTempDir("tn-wolf-atomic-");
    roots.push(root);
    const source = path.join(root, "source");
    const output = path.join(root, "cooked");
    const destination = path.join(source, "wolf.animal");
    await bakeWolfToFile({ seed: 7, tier: "crowd" }, destination);
    const original = await readFile(destination);
    await expect(bakeWolfToFile({ seed: -1, tier: "crowd" }, destination)).rejects.toThrow(
      "TN_ANIMAL_OPTIONS",
    );
    expect(await readFile(destination)).toEqual(original);
    expect(await readdir(source)).toEqual(["wolf.animal"]);
    const run = () =>
      compileAssets({ cwd: root, source, output, concurrency: 1, passes: [animalBakePass()] });
    await run();
    const manifest = await readFile(path.join(output, "assets.manifest.json"), "utf8");
    await writeFile(destination, "corrupt");
    await expect(run()).rejects.toThrow("TN_ANIMAL_");
    expect(await readFile(path.join(output, "assets.manifest.json"), "utf8")).toBe(manifest);
  }, 30_000);
});

it("preserves last valid source and removes staging after an interrupted partial write", async () => {
  const root = await makeTempDir("tn-wolf-interrupted-");
  roots.push(root);
  const destination = path.join(root, "wolf.animal");
  await bakeWolfToFile({ seed: 7, tier: "crowd" }, destination);
  const original = await readFile(destination);
  fault.partialWrite = true;
  await expect(bakeWolfToFile({ seed: 8, tier: "crowd" }, destination)).rejects.toThrow(
    "TN_ANIMAL_TEST_IO_INTERRUPTED",
  );
  expect(await readFile(destination)).toEqual(original);
  expect(await readdir(root)).toEqual(["wolf.animal"]);
}, 30_000);

it("loads an actual cooked wolf and preserves every skin attribute before geometry construction", async () => {
  const root = await makeTempDir("tn-wolf-resolve-");
  roots.push(root);
  const source = path.join(root, "source");
  const output = path.join(root, "cooked");
  const hash = await bakeWolfToFile({ seed: 7, tier: "crowd" }, path.join(source, "wolf.animal"));
  await compileAssets({ cwd: root, source, output, concurrency: 1, passes: [animalBakePass()] });
  const manifest = JSON.parse(await readFile(path.join(output, "assets.manifest.json"), "utf8"));
  const bytes = Uint8Array.from(
    await readFile(path.join(output, manifest.entries["wolf.animal"].output)),
  );
  expect(digest(bytes)).toBe(hash);
  const url = `https://fixture.invalid/${manifest.entries["wolf.animal"].output}`;
  const resolve = vi.fn(async () => [url]);
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  const bake = await loadAnimalBake({ resolve }, "wolf.animal");
  expect(resolve).toHaveBeenCalledWith("wolf.animal");
  expect(fetch).toHaveBeenCalledWith(url, { signal: undefined });
  const geometry = geometryFromValidatedBake(bake);
  expect(bake.nV).toBeLessThanOrEqual(8000);
  expect(bake.bones.length).toBeLessThanOrEqual(128);
  expect(geometry.getAttribute("position").array).toEqual(bake.pos);
  expect(geometry.getAttribute("skinIndex").array).toEqual(bake.skinIndex);
  expect(geometry.getAttribute("skinWeight").array).toEqual(bake.skinWeight);
  expect(geometry.getIndex()?.array).toEqual(bake.index);
  geometry.dispose();
}, 30_000);
