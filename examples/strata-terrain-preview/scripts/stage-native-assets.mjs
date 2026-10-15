// The native host resolves a texture at `<path>` or `assets/<path>` beside the game; the web build
// gets the ground's CC0 starter maps from Vite's publicDir. Mirror that root into `assets/` with hard
// links so a desktop run reads the very bytes the browser does. The licensed `local-assets/` mounts
// are not staged: their cooked KTX2 models load untextured on the native host today, which is worse
// than the procedural fallback they leave in place, and the ground already falls back from
// `temperate/` to these public maps by name.
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(here, "assets");
// vite.config.ts publicDir, served at the root.
const roots = [
  { dir: join(here, "../../packages/terrain/starter-assets"), mount: "", required: true },
];

let linked = 0;
const entries = {};
function mirror(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      mirror(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    const logical = relative(out, to).split(sep).join("/");
    entries[logical] = { output: `assets/${logical}`, bytes: statSync(from).size };
    if (existsSync(to)) {
      if (statSync(to).ino === statSync(from).ino) continue;
      unlinkSync(to);
    }
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
writeFileSync(join(here, "assets.manifest.json"), `${JSON.stringify({ version: 1, entries })}\n`);
console.log(`stage-native-assets: ${linked} file(s) linked into ${relative(here, out)}/`);
