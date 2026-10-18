import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));

async function packStarterAssets() {
  const source = join(root, "starter-assets");
  const chunks = [];
  async function visit(relative) {
    const info = await lstat(join(source, relative));
    if (!info.isDirectory() && !info.isFile())
      throw new Error(`TN_TERRAIN_ARCHIVE_TYPE: ${relative}`);
    const name = `starter-assets/${relative}${info.isDirectory() && relative ? "/" : ""}`;
    const bytes = info.isFile() ? await readFile(join(source, relative)) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(name) > 100) throw new Error(`TN_TERRAIN_ARCHIVE_PATH: ${name}`);
    header.write(name, 0, 100);
    for (const [offset, length, value] of [
      [100, 8, info.isDirectory() ? 0o755 : 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, bytes.length],
      [136, 12, 0],
    ]) {
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
    }
    header.fill(32, 148, 156);
    header[156] = info.isDirectory() ? 53 : 48;
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0")}\0 `,
      148,
      8,
    );
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    if (info.isDirectory())
      for (const child of (await readdir(join(source, relative))).sort())
        await visit(`${relative ? `${relative}/` : ""}${child}`);
  }
  await visit("");
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out || out.startsWith("--"))
    throw new Error("Usage: pack-starter-assets.mjs <out.tar.gz> [--write-manifest]");
  const file = resolve(out);
  const archive = await packStarterAssets();
  const record = {
    file,
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, archive);
  if (process.argv.includes("--write-manifest")) {
    const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const tag = `terrain-starter-assets-sha256-${record.sha256}`;
    const url = `https://github.com/ThreeNativeHQ/threenative-engine/releases/download/${tag}/terrain-starter-assets-${version}.tar.gz`;
    await writeFile(
      join(root, "starter-assets.json"),
      `${JSON.stringify({ version, url, sha256: record.sha256, bytes: record.bytes }, null, 2)}\n`,
    );
    await writeFile(
      join(root, "starter-credits.json"),
      await readFile(join(root, "starter-assets/credits.json")),
    );
  }
  console.log(JSON.stringify(record));
}
