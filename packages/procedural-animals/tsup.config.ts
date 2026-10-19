import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts", "src/build.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  splitting: false,
  clean: true,
  treeshake: true,
});
