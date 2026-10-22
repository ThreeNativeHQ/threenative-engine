import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

function fail(reason: string): never {
  throw new Error(`TN_TERRAIN_ASSETS_${reason}`);
}

async function isDirectory(path: string) {
  return (
    (
      await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    )?.isDirectory() === true
  );
}

// Accept only the pinned packer's ustar subset; never links, devices or extended headers.
async function extract(archive: Buffer, target: string) {
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 });
  const seen = new Set<string>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        tar.length < at + 1024 ||
        !tar.subarray(at).every((byte) => byte === 0) ||
        seen.size === 0
      )
        fail("END");
      return;
    }
    const text = (from: number, to: number) =>
      header.subarray(from, to).toString("utf8").split("\0")[0] ?? "";
    const octal = (from: number, to: number) => {
      const value = text(from, to).trim();
      if (!/^[0-7]+$/u.test(value)) fail("HEADER");
      return Number.parseInt(value, 8);
    };
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (text(257, 263) !== "ustar" || text(263, 265) !== "00" || octal(148, 156) !== checksum)
      fail("HEADER");
    const prefix = text(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${text(0, 100)}`.replace(/\/$/u, "");
    if (!name.startsWith("starter-assets/") && name !== "starter-assets") fail("PATH");
    if (
      name.includes("\\") ||
      name
        .split("/")
        .some((part) => part === ".." || part === "." || part === "" || part.includes(":"))
    )
      fail("PATH");
    if (seen.has(name)) fail("DUPLICATE");
    seen.add(name);
    const size = octal(124, 136);
    const type = header[156];
    if (type !== 48 && type !== 53) fail("TYPE");
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (type === 53 && size !== 0) ||
      (name === "starter-assets" && type !== 53)
    )
      fail("SIZE");
    const next = at + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) fail("TRUNCATED");
    const path = join(target, ...name.split("/").slice(1));
    if (type === 53) await mkdir(path, { recursive: true, mode: 0o755 });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, tar.subarray(at + 512, at + 512 + size), { flag: "wx", mode: 0o644 });
    }
    at = next;
  }
  fail("END");
}

/**
 * Resolve shared starter assets locally, or download the package's pinned archive on demand.
 * @situation resolve terrain kit models and textures for offline baking
 * @constraint Node authoring only; verifies archive size and SHA256 before atomic extraction
 * @requires npm i -D @threenative/terrain
 * @example const assets = await starterAssetsDir();
 */
export async function starterAssetsDir(): Promise<string> {
  const root = dirname(fileURLToPath(import.meta.resolve("@threenative/terrain/package.json")));
  const local = join(root, "starter-assets");
  if (await isDirectory(local)) return local;
  const manifest = JSON.parse(await readFile(join(root, "starter-assets.json"), "utf8")) as {
    version: string;
    url: string;
    sha256: string;
    bytes: number;
  };
  if (
    !/^[a-f0-9]{64}$/u.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    manifest.bytes > 128 * 1024 * 1024
  )
    fail("MANIFEST");
  const cache = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "threenative",
    "terrain-starter-assets",
    manifest.sha256,
  );
  if (await isDirectory(cache)) return cache;
  const url = new URL(process.env.THREENATIVE_TERRAIN_ASSETS_URL || manifest.url);
  let archive: Buffer;
  if (url.protocol === "file:") archive = await readFile(url);
  else {
    if (url.protocol !== "https:" && url.protocol !== "http:") fail("URL");
    const response = await fetch(url);
    if (!response.ok) fail(`HTTP: ${response.status} ${url.href}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (archive.length !== manifest.bytes) fail("SIZE");
  if (createHash("sha256").update(archive).digest("hex") !== manifest.sha256) fail("SHA256");
  await mkdir(dirname(cache), { recursive: true });
  const tmp = await mkdtemp(`${cache}.tmp-`);
  try {
    await extract(archive, tmp);
    try {
      await rename(tmp, cache);
    } catch (error) {
      if (
        !(await isDirectory(cache)) ||
        !["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return cache;
}
