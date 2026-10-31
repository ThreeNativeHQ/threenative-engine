import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { compareRuns, failureReason, launchOrder } = await import(
  new URL(
    "../../packages/runtime-native/scripts/measure-starter-js-frame-pair.mjs",
    import.meta.url,
  ).href
);

function runs() {
  return launchOrder.map((engine: string, index: number) => ({
    engine,
    bundleSha256: "a".repeat(64),
    binarySha256: (engine === "v8" ? "b" : "c").repeat(64),
    log: `[${engine === "v8" ? "V8" : "QuickJS"}] Engine created successfully\n${engine === "v8" ? "[V8] Version: 13.1.201.22\n" : ""}[WebGPU] Adapter: llvmpipe\n[WebGPU] Backend: Vulkan\nTN_WORLD_ENVIRONMENT:{"stages":[{"name":"grade","applied":true}]}`,
    report: {
      pass: true,
      discardedWindows: [1],
      violations: [],
      budgets: [1, 2, 3].map((window) => ({
        window,
        frames: 300,
        frame: {
          mean: 10,
          p50:
            window === 2
              ? 999
              : engine === "v8"
                ? [4, 5, 6][Math.floor(index / 2)]
                : [9, 10, 100][Math.floor(index / 2)],
          p95: 120,
        },
        surface: {
          drawingBufferWidth: 1280,
          drawingBufferHeight: 720,
          resolutionScale: 1,
          sampleCount: 1,
          compiling: false,
        },
      })),
    },
  }));
}

describe("starter paired JS frame proof", () => {
  it("names why a launch failed when the perf reader wrote its verdict to stdout and nothing to stderr", () => {
    const reason = failureReason({
      status: 1,
      stderr: "",
      stdout: '{"violations":[{"code":"TN_PERF_WINDOWS_MISSING"}]}',
    });
    expect(reason).toContain("exit 1");
    expect(reason).toContain("TN_PERF_WINDOWS_MISSING");
    expect(failureReason({ status: null, signal: "SIGTERM", stderr: "", stdout: "" })).toBe(
      "exit none signal SIGTERM",
    );
  });

  it("uses alternating pairs and strict median of sampled run p50s, rejecting incomplete or incomparable evidence", () => {
    expect(launchOrder).toEqual(["quickjs", "v8", "v8", "quickjs", "quickjs", "v8"]);
    expect(compareRuns(runs())).toMatchObject({ pass: true, quickjsMedianMs: 10, v8MedianMs: 5 });
    for (const corrupt of [
      (r: ReturnType<typeof runs>) => r.pop(),
      (r: ReturnType<typeof runs>) => {
        r[0].report.budgets.pop();
      },
      (r: ReturnType<typeof runs>) => {
        r[0].report.budgets[1].frame.p50 = Number.NaN;
      },
      (r: ReturnType<typeof runs>) => {
        Reflect.deleteProperty(r[0].report.budgets[1], "frame");
      },
      (r: ReturnType<typeof runs>) => {
        r[0].report.pass = false;
      },
      (r: ReturnType<typeof runs>) => {
        r[0].log = "[V8] Engine created successfully";
      },
      (r: ReturnType<typeof runs>) => {
        r[1].log = r[1].log.replace("13.1.201.22", "13.0.1");
      },
      (r: ReturnType<typeof runs>) => {
        r[0].bundleSha256 = "d".repeat(64);
      },
      (r: ReturnType<typeof runs>) => {
        r[0].report.budgets[1].surface.resolutionScale = 0.5;
      },
      (r: ReturnType<typeof runs>) => {
        Reflect.deleteProperty(r[0].report.budgets[1].surface, "compiling");
      },
      (r: ReturnType<typeof runs>) => {
        r[0].report.budgets[1].surface.compiling = true;
      },
      (r: ReturnType<typeof runs>) => {
        r[0].log = r[0].log.replace('"applied":true', '"applied":false');
      },
    ]) {
      const invalid = runs();
      corrupt(invalid);
      expect(() => compareRuns(invalid)).toThrow();
    }
    const tied = runs();
    for (const run of tied) for (const window of run.report.budgets) window.frame.p50 = 10;
    expect(compareRuns(tied)).toMatchObject({ pass: false, quickjsMedianMs: 10, v8MedianMs: 10 });
  });
});

it("captures two fixed-step starter poses per engine using the same measured bundle before restoration", () => {
  const workflow = readFileSync(".github/workflows/native-platforms.yml", "utf8");
  const step = workflow.slice(
    workflow.indexOf("- name: Compare paired starter JS"),
    workflow.indexOf("- name: Upload paired starter JS"),
  );
  expect(step).toContain("trap restore_v8 EXIT");
  expect(step).toContain("for engine in quickjs v8; do");
  expect(step).toContain("for capture in 1 2; do");
  expect(step).toContain('"$target/native-playtests/render-chain.playtest.json" --target desktop');
  expect(step).toContain('--project "$target/public" --executable "$binary"');
  expect(step).toContain('--host-arg run --host-arg "$target/dist-native/perf-game.js"');
  expect(step).toContain('--host-arg --ui --host-arg "$target/dist-native/ui"');
  expect(step).toContain('--artifacts "$evidence/same-pose/$engine-$capture"');
  expect(step.indexOf('"$target/dist-native/perf-game.js" "$evidence"')).toBeLessThan(
    step.indexOf("for engine in quickjs v8"),
  );
  expect(step).not.toContain("--live-clock");
  const helper = readFileSync(
    "packages/runtime-native/scripts/measure-starter-js-frame-pair.mjs",
    "utf8",
  );
  expect(helper).not.toContain("--screenshot");
  expect(helper).toContain("V8 median JS frame duration must be strictly lower");
});

it("executes the installed QuickJS cook before freezing its canonical bundle and asset manifest", () => {
  const workflow = readFileSync(".github/workflows/native-platforms.yml", "utf8");
  const step = workflow.slice(
    workflow.indexOf("- name: Compare paired starter JS"),
    workflow.indexOf("- name: Upload paired starter JS"),
  );
  const start = step.indexOf("          THREENATIVE_RUNTIME_BINARY=");
  const end = step.indexOf(
    '          cp "$target/threenative.config.ts" "$evidence/paired-config.ts"',
    start,
  );
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const root = makeTempDirSync("starter-paired-cook-");
  for (const path of ["project/dist-native", "project/public", "evidence"])
    mkdirSync(join(root, path), { recursive: true });
  const script = join(root, "cook.sh");
  writeFileSync(
    script,
    `set -eu
runtime="$1/runtime"
target="$1/project"
evidence="$1/evidence"
pnpm() {
  test "$THREENATIVE_RUNTIME_BINARY" = "$runtime/build/tn-linux/mystral"
  test "$*" = "--dir $target exec threenative build --target desktop"
  mkdir -p "$target/.threenative/build"
  printf shared-native-bundle > "$target/.threenative/build/game.js"
  printf cooked-native-assets > "$target/public/assets.manifest.json"
}
${step.slice(start, end)}
`,
  );
  const run = spawnSync("bash", [script, root], { encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  expect(readFileSync(join(root, "project/dist-native/perf-game.js"), "utf8")).toBe(
    "shared-native-bundle",
  );
  expect(readFileSync(join(root, "evidence/assets.manifest.json"), "utf8")).toBe(
    "cooked-native-assets",
  );
  expect(
    step.indexOf('cp "$runtime/build/tn-linux/CMakeCache.txt" "$evidence/quickjs-CMakeCache.txt"'),
  ).toBeLessThan(start);
  expect(end).toBeLessThan(
    step.indexOf('sh scripts/xvfb.sh node "$runtime/scripts/measure-starter-js-frame-pair.mjs"'),
  );
  expect(step).not.toContain('node "$runtime/scripts/bundle.mjs"');
});

for (const failPair of [false, true]) {
  it(`restores the verified consumer after the actual paired step ${failPair ? "fails" : "succeeds"}`, () => {
    const workflow = readFileSync(".github/workflows/native-platforms.yml", "utf8");
    const step = workflow.slice(
      workflow.indexOf("- name: Compare paired starter JS"),
      workflow.indexOf("- name: Upload paired starter JS"),
    );
    const shell = step
      .slice(step.indexOf("          set -euo pipefail"))
      .split("\n")
      .map((line) => line.replace(/^ {10}/u, ""))
      .join("\n");
    const root = makeTempDirSync("starter-paired-restore-");
    const target = join(root, "threenative-starter-native");
    const runtime = join(root, "packages/runtime-native");
    const evidence = join(runtime, "artifacts/starter-linux-arm64/js-frame-pair");
    for (const path of [
      join(runtime, "build/tn-linux"),
      join(target, "dist-native"),
      join(target, "public"),
    ])
      mkdirSync(path, { recursive: true });
    const consumer = join(target, "dist-native/threenative-starter-native");
    writeFileSync(consumer, "verified consumer bytes");
    chmodSync(consumer, 0o751);
    writeFileSync(join(runtime, "build/tn-linux/mystral"), "verified V8 host");
    writeFileSync(join(runtime, "build/tn-linux/CMakeCache.txt"), "TN_ENABLE_CANVAS2D:BOOL=ON\n");
    writeFileSync(join(target, "threenative.config.ts"), 'resolutionScale: "auto"');
    const stubs = `
cmake() {
  case "$*" in
    *--build*) printf quickjs-host > "$runtime/build/tn-linux/mystral" ;;
  esac
}
pnpm() {
  mkdir -p "$target/.threenative/build"
  printf changed-consumer > "$target/dist-native/threenative-starter-native"
  chmod 600 "$target/dist-native/threenative-starter-native"
  printf shared-native-bundle > "$target/.threenative/build/game.js"
  printf cooked-native-assets > "$target/public/assets.manifest.json"
}
sh() {
  case "$*" in
    *measure-starter-js-frame-pair.mjs*) return "$FAIL_PAIR" ;;
    *) printf '{"pass":true}\\n'; printf runner-diagnostic >&2 ;;
  esac
}
`;
    const run = spawnSync("bash", ["-c", stubs + shell], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: root, FAIL_PAIR: failPair ? "23" : "0" },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(run.status, run.stderr).toBe(failPair ? 23 : 0);
    expect(readFileSync(consumer, "utf8")).toBe("verified consumer bytes");
    expect(statSync(consumer).mode & 0o777).toBe(0o751);
    expect(readFileSync(join(runtime, "build/tn-linux/mystral"), "utf8")).toBe("verified V8 host");
    expect(readFileSync(join(target, "threenative.config.ts"), "utf8")).toBe(
      'resolutionScale: "auto"',
    );
    if (!failPair)
      for (const arm of ["quickjs-1", "quickjs-2", "v8-1", "v8-2"]) {
        expect(
          JSON.parse(readFileSync(join(evidence, "same-pose", arm, "report.json"), "utf8")),
        ).toEqual({ pass: true });
        expect(readFileSync(join(evidence, "same-pose", arm, "runner.stderr.log"), "utf8")).toBe(
          "runner-diagnostic",
        );
      }
  });
}
