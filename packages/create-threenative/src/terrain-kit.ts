import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The five starter kits. The allowlist also blocks path escape: a name reaches the disk only when it matches.
const KITS = ["alpine", "coastal", "desert", "forest", "tundra"];
// These six files are game source. bake.mjs uses @threenative/terrain/kit to resolve pinned assets on demand.
const COPIED = [
  "assets.json",
  "bake.mjs",
  "credits.json",
  "heightmap.r16",
  "recipe.json",
  "surface.json",
];
const DEFAULT_TEMPLATES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../templates",
);

// Checks each existing parent of the target, nearest first, up to the filesystem root.
// The check skips a missing parent. It still finds a symlink above missing folders.
async function assertNoSymlinkAncestor(target: string): Promise<void> {
  let dir = path.dirname(path.resolve(target));
  for (;;) {
    const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new Error(
        `TN_TERRAIN_KIT_SYMLINK: A parent folder is a symlink: ${dir}. Choose a target path with real parent folders.`,
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Copies one packaged terrain kit into a new game-owned folder.
 * It checks the name, the packaged inputs and the target before it writes.
 */
export async function copyTerrainKit(
  kit: string,
  targetPath: string,
  templatesRoot = DEFAULT_TEMPLATES_ROOT,
): Promise<void> {
  const target = path.resolve(targetPath);
  if (!KITS.includes(kit)) {
    throw new Error(
      `TN_TERRAIN_KIT_NAME: "${kit}" is not a packaged terrain kit. Use one of: ${KITS.join(", ")}.`,
    );
  }
  const sourceDir = path.join(path.resolve(templatesRoot, "..", "template-assets", "terrain"), kit);
  const sourceStat = await lstat(sourceDir).catch(() => null);
  if (!sourceStat)
    throw new Error(
      `TN_TERRAIN_KIT_UNKNOWN: The packaged folder for "${kit}" is missing: ${sourceDir}.`,
    );
  if (!sourceStat.isDirectory()) {
    throw new Error(
      `TN_TERRAIN_KIT_SOURCE: The packaged folder is not a real directory: ${sourceDir}.`,
    );
  }

  // Read every input before the target exists. A symlink is not a regular file, so it fails here.
  const bytes = new Map<string, Buffer>();
  for (const file of COPIED) {
    const source = path.join(sourceDir, file);
    if (!(await lstat(source).catch(() => null))?.isFile()) {
      throw new Error(
        `TN_TERRAIN_KIT_SOURCE: The packaged input is missing or not a regular file: ${source}.`,
      );
    }
    bytes.set(file, await readFile(source));
  }

  const targetStat = await lstat(target).catch(() => null);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(
      `TN_TERRAIN_KIT_SYMLINK: The target is a symlink. Choose a real folder: ${target}.`,
    );
  }
  if (targetStat)
    throw new Error(
      `TN_TERRAIN_KIT_EXISTS: The target already exists. Choose a new folder: ${target}.`,
    );

  // shortcut: the lstat checks are not race-proof. A parent can become a symlink after its check.
  // The packaged inputs are trusted, so this limit stays.
  // Add O_NOFOLLOW and a realpath walk if the roots become untrusted.
  await assertNoSymlinkAncestor(target);
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target);
  for (const [file, data] of bytes) await writeFile(path.join(target, file), data, { flag: "wx" });
}
