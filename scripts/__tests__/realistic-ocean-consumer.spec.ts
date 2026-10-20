import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir";
import {
  addCapturePose,
  adoptRealisticOcean,
  digestSource,
  removeRealisticOcean,
} from "../realistic-ocean-consumer";

const sailing = path.resolve("packages/create-threenative/templates/sailing/src");

async function game() {
  const target = await makeTempDir("realistic-consumer-");
  await cp(sailing, path.join(target, "src"), { recursive: true });
  await writeFile(path.join(target, "package.json"), "{}\n");
  return target;
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

it("adopts the bundle into the sailing kit and removing it restores the scaffold byte for byte", async () => {
  const target = await game();
  try {
    const scaffold = await digestSource(target);
    await adoptRealisticOcean(target);
    expect(await digestSource(target)).not.toBe(scaffold);
    expect(await readFile(path.join(target, "src/scenes/Sailing.ts"), "utf8")).toContain(
      "createRealisticSea",
    );
    expect(await exists(path.join(target, "src/render/realisticSea.ts"))).toBe(true);
    await removeRealisticOcean(target);
    expect(await digestSource(target)).toBe(scaffold);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it("refuses a second adoption and leaves the first one untouched", async () => {
  const target = await game();
  try {
    await adoptRealisticOcean(target);
    const scene = path.join(target, "src/scenes/Sailing.ts");
    const adopted = await readFile(scene, "utf8");
    await expect(adoptRealisticOcean(target)).rejects.toThrow("TN_REALISTIC_CONSUMER_EDIT");
    expect(await readFile(scene, "utf8")).toBe(adopted);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it("checks every edit before it copies a file, so a changed kit is never half adopted", async () => {
  const target = await game();
  try {
    const scene = path.join(target, "src/scenes/Sailing.ts");
    const source = await readFile(scene, "utf8");
    const changed = source.replace("    const ocean = ctx.add(createOcean());\n", "");
    expect(changed).not.toBe(source);
    await writeFile(scene, changed);
    await expect(adoptRealisticOcean(target)).rejects.toThrow("TN_REALISTIC_CONSUMER_EDIT");
    expect(await exists(path.join(target, "src/render/realisticSea.ts"))).toBe(false);
    expect(await readFile(scene, "utf8")).toBe(changed);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it("poses the camera for a capture once, and refuses to patch it twice", async () => {
  const target = await game();
  try {
    await addCapturePose(target);
    expect(await readFile(path.join(target, "src/render/camera.ts"), "utf8")).toContain(
      "__TN_OCEAN_POSE",
    );
    await expect(addCapturePose(target)).rejects.toThrow("TN_REALISTIC_CONSUMER_EDIT");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
