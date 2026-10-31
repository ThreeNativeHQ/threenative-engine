import { defineConfig } from "tsup";

export default defineConfig({
  // `bridge` is the whole package: `@threenative/assets` and `doctor` import it, and there is no
  // stdio server left to build beside it.
  entry: ["src/bridge.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
});
