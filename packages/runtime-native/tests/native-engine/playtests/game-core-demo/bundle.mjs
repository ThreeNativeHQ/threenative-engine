import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../../..");
const player = resolve(root, "packages/runtime-native/src/engine/player");
const outfile = resolve(root, "packages/runtime-native/build/tn-linux/game-core-demo.js");
await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  entryPoints: [resolve(here, "main.mjs")],
  outfile,
  bundle: true,
  format: "iife",
  platform: "neutral",
  target: "es2022",
  metafile: true,
  define: { "import.meta.env": "{}" },
  alias: {
    three: resolve(player, "core-three.mjs"),
    "three/webgpu": resolve(player, "core-webgpu.mjs"),
    "three/tsl": resolve(player, "core-unused.mjs"),
    "three-mesh-bvh": resolve(player, "core-unused.mjs"),
  },
  plugins: [{ name: "native-core-demo", setup(builder) {
    builder.onResolve({ filter: /^@threenative\/core$/ }, () => ({ path: "core", namespace: "demo" }));
    builder.onLoad({ filter: /.*/, namespace: "demo" }, () => ({
      contents: `export { defineGame } from ${JSON.stringify(resolve(root, "packages/core/src/game.ts"))}; export { Scene } from ${JSON.stringify(resolve(root, "packages/core/src/scene.ts"))};`,
      resolveDir: root,
    }));
    builder.onResolve({ filter: /^three\/addons\// }, () => ({ path: resolve(player, "core-unused.mjs") }));
  } }],
});
const upstream = Object.keys(result.metafile.inputs).filter((path) => /(?:^|\/)node_modules\/(?:.*\/)?three\//.test(path));
if (upstream.length) throw new Error(`Upstream Three.js entered the bundle: ${upstream.join(", ")}`);
console.log(`Bundle: ${outfile} (${(await stat(outfile)).size} bytes)`);
