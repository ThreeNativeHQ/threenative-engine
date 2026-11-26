import { defineConfig } from "tsup";

export default defineConfig({
  // Two tiers in one package: `.` is the browser client and owns no dependency; `./cloudflare`
  // is the server handler and must never be reachable from a game's browser build.
  entry: ["src/client.ts", "src/cloudflare.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
});
