import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit opt-in source installation, not a new threenative CLI command or runtime dependency.
const source = fileURLToPath(new URL("./src/", import.meta.url));
const root = path.resolve(process.argv[2] ?? process.cwd());
const destination = path.join(root, "src");
try {
  await lstat(path.join(root, "package.json"));
} catch {
  throw new Error(`${root} has no package.json: run this from a game's root or pass its path.`);
}
const files = [];
const directories = [""];
async function walk(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      directories.push(relative);
      await walk(path.join(directory, entry.name), relative);
    } else files.push(relative);
  }
}
await walk(source);
// Check parents first: lstat(file) follows directory links, including links outside the game.
// A dangling directory link must also fail before any earlier source file has been copied.
for (const relative of directories) {
  const target = path.join(destination, relative);
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink())
      throw new Error(`Refusing to install through symbolic link ${target}.`);
    if (!stat.isDirectory()) throw new Error(`Refusing to install into non-directory ${target}.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Preflight all names before the first copy. Existing game source must never be overwritten.
for (const relative of files) {
  const target = path.join(destination, relative);
  try {
    await lstat(target);
    throw new Error(`Refusing to overwrite ${target}. Move or review the existing source first.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
for (const relative of files) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(source, relative), target, { errorOnExist: true, force: false });
}
console.log(
  `Installed realistic-ocean source into ${destination}. Import createRealisticOcean from ./realisticOcean.js.`,
);
