import { defineConfig } from "tsup";

// `three` stays external so the baked geometry belongs to the consumer's installed Three.js
// instance (the subpath is a peer dependency), never a second copy bundled into this addon.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    three: "src/three.ts",
    export: "src/export.ts",
    "editor/server": "src/editor/server.ts",
    "editor/index": "src/editor/index.ts",
    "editor/worker": "src/editor/worker.js",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: false,
  clean: true,
  external: ["three"],
  splitting: false,
  treeshake: true,
});
