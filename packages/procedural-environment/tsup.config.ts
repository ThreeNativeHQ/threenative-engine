import { defineConfig } from "tsup";

// A watch rebuild must not empty dist: the asset library imports it while tsup writes.
const clean = !process.argv.includes("--watch");
export default defineConfig([
  {
    entry: ["src/index.ts", "src/stylized.ts", "src/asset-library.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    splitting: false,
    clean,
    treeshake: true,
  },
  {
    // The Asset Library's browser half: one file whose only import is `three`, so the library's
    // plugin can hand it upstream three inside a kit whose own `three` is the Wasm engine.
    entry: ["src/asset-library-client.ts"],
    format: ["esm"],
    target: "es2022",
    platform: "browser",
    dts: false,
    splitting: false,
    clean: false,
    treeshake: true,
    external: ["three"],
    noExternal: [/^three\/addons\//u],
  },
]);
