import { defineConfig } from "tsup";

export default defineConfig({
  // Some CLI inspection dependencies are CJS and need a real require inside this ESM bundle.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  entry: ["src/index.ts", "src/threenative.ts", "src/terrain-kit.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  // The asset package and codec packages stay external: emscripten loaders resolve their
  // .wasm sidecars and Node globals against their own module url. Inlining rewrites that
  // context to this ESM CLI bundle and breaks packed-project asset compilation.
  external: [
    "@threenative/assets",
    "@gltf-transform/core",
    "@gltf-transform/extensions",
    "@gltf-transform/functions",
    "draco3dgltf",
    "ktx-parse",
    "ktx2-encoder",
    "meshoptimizer",
  ],
});
