import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir";

const run = promisify(execFile);
const bundle = path.resolve("packages/create-threenative/template-assets/realistic-ocean");
it("installs source and license, then refuses to overwrite an edited game", async () => {
  const target = await makeTempDir("realistic-ocean-install-");
  try {
    await run(process.execPath, [path.join(bundle, "install.mjs"), target]);
    expect(await readFile(path.join(target, "src/realisticOcean.ts"), "utf8")).toContain(
      "createRealisticOcean",
    );
    expect(
      await readFile(path.join(target, "src/render/REALISTIC-OCEAN-LICENSE.txt"), "utf8"),
    ).toContain("Copyright (c) 2026 Maksymilian Dendura");
    await writeFile(path.join(target, "src/realisticOcean.ts"), "// game-owned edits\n");
    await expect(run(process.execPath, [path.join(bundle, "install.mjs"), target])).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readFile(path.join(target, "src/realisticOcean.ts"), "utf8")).toBe(
      "// game-owned edits\n",
    );
    expect(await readdir(path.join(target, "src/render"))).toContain("realisticSeaMaps.ts");
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it.each(["src", "src/render"])(
  "refuses a %s directory symlink before writing",
  async (relative) => {
    const target = await makeTempDir("realistic-ocean-link-");
    const external = await makeTempDir("realistic-ocean-external-");
    try {
      const link = path.join(target, relative);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(external, link, "dir");
      await expect(
        run(process.execPath, [path.join(bundle, "install.mjs"), target]),
      ).rejects.toThrow("Refusing to install through symbolic link");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readdir(external)).toEqual([]);
      if (relative === "src/render") {
        expect(await readdir(path.join(target, "src"))).toEqual(["render"]);
      }
    } finally {
      await rm(target, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  },
);

it("rejects dangling directory links without leaving a partial installation", async () => {
  const target = await makeTempDir("realistic-ocean-dangling-");
  try {
    const src = path.join(target, "src");
    await mkdir(src);
    await symlink(path.join(target, "missing"), path.join(src, "render"), "dir");
    await expect(
      run(process.execPath, [path.join(bundle, "install.mjs"), target]),
    ).rejects.toThrow();
    expect(await readdir(src)).toEqual(["render"]);
    expect(await readdir(target)).toEqual(["src"]);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});

it("preflights a late filename collision before copying any source", async () => {
  const target = await makeTempDir("realistic-ocean-collision-");
  try {
    const render = path.join(target, "src/render");
    await mkdir(render, { recursive: true });
    await writeFile(path.join(render, "realisticSea.ts"), "// game-owned edits\n");
    await expect(run(process.execPath, [path.join(bundle, "install.mjs"), target])).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readdir(path.join(target, "src"))).toEqual(["render"]);
    expect(await readdir(render)).toEqual(["realisticSea.ts"]);
    expect(await readFile(path.join(render, "realisticSea.ts"), "utf8")).toBe(
      "// game-owned edits\n",
    );
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
