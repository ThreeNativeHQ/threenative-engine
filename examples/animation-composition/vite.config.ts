import { defineConfig } from "vite";

const benchmark = process.env.TN_ANIMATION_BENCHMARK ?? "none";
if (!["none", "baseline", "candidate"].includes(benchmark))
  throw new Error("TN_ANIMATION_BENCHMARK requires none, baseline or candidate.");

export default defineConfig({
  define: { __TN_ANIMATION_BENCHMARK__: JSON.stringify(benchmark) },
  resolve: { dedupe: ["three"] },
});
