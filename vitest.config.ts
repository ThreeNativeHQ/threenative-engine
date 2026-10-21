import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [
    {
      // Root scripts and the harness overlays under scripts/ import `three`, which only the packages install.
      // Resolve it from core, the way scripts/unreal-look/compare.ts does.
      name: "scripts-resolve-three-from-core",
      enforce: "pre",
      async resolveId(
        this: { resolve(source: string, importer: string, options: object): Promise<unknown> },
        source: string,
        importer: string | undefined,
        options: object,
      ) {
        if (!/^three(\/|$)/.test(source) || !importer?.startsWith(path.join(root, "scripts/")))
          return null;
        return this.resolve(source, path.join(root, "packages/core/package.json"), {
          ...options,
          skipSelf: true,
        });
      },
    },
  ],
  test: {
    environment: "node",
    include: [
      "scripts/**/*.spec.ts",
      "packages/**/__tests__/**/*.spec.ts",
      "packages/**/__tests__/**/*.spec.tsx",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "examples/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "./artifacts/coverage",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts"],
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
    // A test that needs 6s of real work on an idle 16-core box gets 30s. That is generous here
    // and tight on a two-core runner under 4x oversubscription, which is where
    // `make-sandbox` (6.3s measured) and `template-runtime-cost` (2.1s measured) both hit
    // "Test timed out in 30000ms". The budget is a hang detector, not a schedule.
    testTimeout: 60_000,
    // Hooks are mostly temp-tree cleanup, and the 10s default is the same hang detector set for
    // an idle box. On a loaded tn-local runner `rm` of a temp tree passed 10s in
    // three-patch-upgrade, cpu-bench-cli and make-sandbox (main runs 39217177505, 39226537203)
    // with every test green, so hooks get the test budget.
    hookTimeout: 60_000,
    // Several specs drive real headless Chromium plus dev servers (generated-shooter-input,
    // e2e-runner, golden-path). Uncapped worker pools on large machines starve their input
    // timing and fail them nondeterministically; a ceiling keeps those runs honest.
    //
    // The ceiling was a flat 8, which is right on a developer's machine and wrong on the hosted
    // runner: two cores running eight workers is 4x oversubscription, and every heavy spec on
    // that lane pays for it. Scale to the machine and keep 8 as the cap, so a big box behaves
    // exactly as before and a small one stops fighting itself.
    maxWorkers: Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1)),
  },
});
