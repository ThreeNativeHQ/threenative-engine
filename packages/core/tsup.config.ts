import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/playtest.ts",
    "src/hot.ts",
    "src/react.ts",
    "src/react-css.ts",
    "src/ui-layer.ts",
    "src/worker.ts",
    "src/world.ts",
    "src/render-environment.ts",
    "src/net.ts",
    "src/spells/index.ts",
    "src/spells/ultra/index.ts",
    // The terrain jobs' worker entry, emitted as its own file so `new Worker(new URL(...))` in
    // `world.js` resolves next to the bundle it is loaded from. The bundling entries above cannot
    // inline it: a worker URL is only meaningful as a sibling of the module that names it.
    "src/terrain-jobs-worker.ts",
  ],
  // React and the reconciler are optional peers: the game supplies them, and `dist/index.js` must
  // never pull them in, so core stays consumable from React Three Fiber and a game that mounts no
  // React overlay pays nothing.
  external: ["react", "react-reconciler", "react-reconciler/constants.js"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  // Shared chunks, not copies. Two entries that both inline `GPUParticles3D` give the engine two
  // class identities, and `ctx.add` recognises a compute-driven node by identity: the spells
  // subpath built its own copy, so the engine never attached its emitters and no particle drew.
  splitting: true,
  treeshake: true,
});
