import { defineConfig } from "tsup";

export default defineConfig([
  {
    // Some CLI inspection dependencies are CJS and need a real require inside this ESM bundle.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
    entry: ["src/index.ts", "src/threenative.ts"],
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
  },
  {
    entry: {
      "web-engine-runtime": "../three-native/src/browser-entry.ts",
      "web-engine-mesh-bvh": "../three-native/src/addons/mesh-bvh.ts",
      "web-engine-mesh-bvh-webgpu": "../three-native/src/addons/mesh-bvh-webgpu.ts",
      "web-engine-buffer-geometry-utils": "../three-native/src/addons/buffer-geometry-utils.ts",
      "web-engine-decal-geometry": "../three-native/src/addons/decal-geometry.ts",
      "web-engine-lut-cube-loader": "../three-native/src/addons/lut-cube-loader-web.ts",
      "web-engine-hdr-loader": "../three-native/src/addons/hdr-loader.ts",
      "web-engine-gltf-loader": "../three-native/src/addons/gltf-loader-web.ts",
      "web-engine-post-effects": "../three-native/src/addons/post-effects-web.ts",
    },
    platform: "browser",
    format: ["esm"],
    target: "es2022",
    dts: false,
    splitting: false,
    treeshake: true,
  },
]);
