// Isolated config for the pinned @pmndrs/labs CPU tool. The wrapper runs the installed `labs`
// executable with this directory as its cwd, and Labs discovers `labs.config.ts` here or in
// `benches/`. `benchDir`, `resultsDir` and the tuning values are environment-overridable so a
// capture writes into a run-local artifact directory instead of the tool's own `.labs` state.
import { fileURLToPath } from "node:url";
import { defineConfig } from "@pmndrs/labs";

function numberFromEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const blocks = numberFromEnv("TN_CPU_BENCH_BLOCKS");
const blockTime = numberFromEnv("TN_CPU_BENCH_BLOCK_TIME");
const minSamples = numberFromEnv("TN_CPU_BENCH_MIN_SAMPLES");

export default defineConfig({
  benchDir:
    process.env.TN_CPU_BENCH_BENCH_DIR ?? fileURLToPath(new URL("./benches", import.meta.url)),
  benchMatch: "**/*.bench.ts",
  resultsDir: process.env.TN_CPU_BENCH_RESULTS_DIR ?? ".labs",
  ...(blocks === undefined ? {} : { blocks }),
  ...(blockTime === undefined ? {} : { blockTime }),
  ...(minSamples === undefined ? {} : { minSamples }),
});
