import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { starterAssetsDir } from "@threenative/terrain/kit";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(here, "assets");
// Match Vite publicDir and preparedAssets mounts, including first-root-wins /basis.
const roots = [
  { dir: await starterAssetsDir(), mount: "", required: true },
  { dir: join(here, "src/world"), mount: "world", required: true },
  ...[
    ["temperate", "temperate"],
    ["temperate/basis", "basis"],
    ["prepared", "prepared"],
    ["landscape-pro", "landscape-pro"],
    ["landscape-pro/basis", "basis"],
  ].map(([dir, mount]) => ({ dir: join(here, "local-assets", dir), mount })),
];

let linked = 0;
const entries = {};
function mirror(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (
      source === join(here, "src/world") &&
      !/\.(?:placements\.bin|world\.json|layers\.json|splat\.rgba8)$/u.test(entry.name)
    )
      continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      mirror(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    const logical = relative(out, to).split(sep).join("/");
    if (entries[logical]) continue;
    entries[logical] = { output: logical, bytes: statSync(from).size };
    if (existsSync(to) && statSync(to).ino === statSync(from).ino) continue;
    if (existsSync(to)) unlinkSync(to);
    try {
      linkSync(from, to);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      copyFileSync(from, to);
    }
    linked += 1;
  }
}

mkdirSync(out, { recursive: true });
for (const root of roots) {
  if (!existsSync(root.dir)) {
    // Licensed roots are absent in the fallback arm; the public starter set never is.
    if (root.required) throw new Error(`stage-native-assets: missing ${relative(here, root.dir)}`);
    continue;
  }
  const target = join(out, root.mount);
  mkdirSync(target, { recursive: true });
  mirror(root.dir, target);
}
if (Object.keys(entries).length === 0) throw new Error("stage-native-assets: no staged assets");
// A nonempty manifest skips bare-path probes and rejects absent optional assets before fetching.
writeFileSync(
  join(out, "assets.manifest.json"),
  `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
);
// Remove only this script's old starter-only manifest, never a user-authored manifest.
const legacy = join(here, "assets.manifest.json");
if (existsSync(legacy)) {
  const old = JSON.parse(readFileSync(legacy, "utf8"));
  const starter = Object.fromEntries(
    Object.entries(entries)
      .filter(([key]) => existsSync(join(roots[0].dir, key)))
      .map(([key, entry]) => [key, { ...entry, output: `assets/${key}` }]),
  );
  // Generated identity survives asset revisions; byte counts do not.
  if (
    old?.version === 1 &&
    Object.keys(old).length === 2 &&
    old.entries &&
    !Array.isArray(old.entries) &&
    Object.keys(old.entries).length === Object.keys(starter).length &&
    Object.entries(starter).every(([key, entry]) => {
      const previous = old.entries[key];
      return (
        previous &&
        Object.keys(previous).length === 2 &&
        previous.output === entry.output &&
        Number.isSafeInteger(previous.bytes) &&
        previous.bytes >= 0
      );
    })
  )
    unlinkSync(legacy);
}
console.log(`stage-native-assets: ${linked} file(s) linked into ${relative(here, out)}/`);
