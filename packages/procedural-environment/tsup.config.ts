import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/stylized.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  splitting: false,
  // A watch rebuild must not empty dist: the asset library imports it while tsup writes.
  clean: !process.argv.includes("--watch"),
  treeshake: true,
});
