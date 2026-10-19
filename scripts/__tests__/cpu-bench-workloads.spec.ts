import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { labsChildEnv, runBoundedProcess } from "../performance-regression/cpu.js";
import {
  LOOP_CASES,
  LOOP_FRAMES,
  LOOP_SMALL,
  createLoopWorkload,
} from "../performance-regression/labs/workloads/loop-workload.js";
import {
  STATE_CASES,
  STATE_ONE,
  createStateWorkload,
} from "../performance-regression/labs/workloads/state-workload.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function benchEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TN_CPU_BENCH_SOURCE: process.env.TN_CPU_BENCH_SOURCE ?? repoRoot,
    ...overrides,
  };
}

async function stubCheckout(files: Record<string, string>): Promise<string> {
  const directory = await makeTempDir("tn-cpu-source-");
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return directory;
}

describe("loop", () => {
  it("runs the selected checkout's fixed-step dispatch for 0, 32 and 256 callbacks", async () => {
    for (const loopCase of LOOP_CASES) {
      const workload = await createLoopWorkload(loopCase, benchEnv());
      try {
        expect(workload.run()).toBe(LOOP_FRAMES);
        expect(() => workload.verify()).not.toThrow();
      } finally {
        workload.dispose();
      }
    }
  });

  it("fails when the selected checkout never dispatches after physics", async () => {
    const stub = await stubCheckout({ "packages/core/src/loop.ts": WRONG_LOOP });
    const workload = await createLoopWorkload(LOOP_SMALL, {
      ...process.env,
      TN_CPU_BENCH_SOURCE: stub,
    });
    try {
      workload.run();
      expect(() => workload.verify()).toThrow();
    } finally {
      workload.dispose();
    }
  });
});

describe("state", () => {
  it("measures the selected checkout's coalesced writes for 0, 1 and 32 subscribers", async () => {
    for (const stateCase of STATE_CASES) {
      const workload = await createStateWorkload(stateCase, benchEnv());
      try {
        workload.run();
        expect(() => workload.verify()).not.toThrow();
      } finally {
        workload.dispose();
      }
    }
  });

  it("fails when the selected checkout never publishes coalesced writes", async () => {
    const stub = await stubCheckout({ "packages/core/src/state.ts": WRONG_STATE });
    const workload = await createStateWorkload(STATE_ONE, {
      ...process.env,
      TN_CPU_BENCH_SOURCE: stub,
    });
    try {
      workload.run();
      expect(() => workload.verify()).toThrow();
    } finally {
      workload.dispose();
    }
  });
});

describe("child environment", () => {
  it("keeps runtime basics and drops credentials, hooks and sentinels", () => {
    const env = labsChildEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/dev",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        TN_CPU_BENCH_BLOCKS: "2",
        TN_CPU_BENCH_SOURCE: "/repo",
        AWS_SECRET_ACCESS_KEY: "secret",
        GITHUB_TOKEN: "secret",
        NODE_OPTIONS: "--require /tmp/evil.cjs",
        NPM_TOKEN: "secret",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        TN_CPU_BENCH_SENTINEL: "secret",
      },
      { TN_CPU_BENCH_RESULTS_DIR: "labs/results", TN_CPU_BENCH_SOURCE: "/repo" },
    );
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env.TMPDIR).toBe("/tmp");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TN_CPU_BENCH_BLOCKS).toBe("2");
    expect(env.TN_CPU_BENCH_SOURCE).toBe("/repo");
    expect(env.TN_CPU_BENCH_RESULTS_DIR).toBe("labs/results");
    for (const key of [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "NPM_TOKEN",
      "SSH_AUTH_SOCK",
      "TN_CPU_BENCH_SENTINEL",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});

const WRONG_LOOP = [
  "export function createAfterPhysicsPhase() {",
  "  const callbacks = new Set();",
  "  return {",
  "    clear() { callbacks.clear(); },",
  "    register(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },",
  "    run(dt) {",
  '      if (!Number.isFinite(dt) || dt <= 0) throw new Error("bad dt");',
  "      for (const callback of callbacks) callback(dt);",
  "    },",
  "  };",
  "}",
  "",
  "export class FixedStepLoop {",
  "  constructor(options) { this.options = options; this.ticks = 0; }",
  "  tick() { return this.ticks; }",
  "  start() {}",
  "  stop() {}",
  "  stepFrame() {",
  "    this.ticks += 1;",
  "    this.options.onUpdate(this.options.step);",
  "    return 1;",
  "  }",
  "}",
  "",
].join("\n");

const WRONG_STATE = [
  "export function createGameStore(initial) {",
  "  const state = { ...initial };",
  "  return {",
  "    flush() {},",
  "    getPublishedState() { return state; },",
  "    getState() { return state; },",
  "    set() {},",
  "    stop() {},",
  "    subscribe() { return () => {}; },",
  "  };",
  "}",
  "",
].join("\n");

describe("real child environment", () => {
  it("drops injected secrets and hooks before spawning Node", async () => {
    const env = labsChildEnv({
      ...process.env,
      NODE_OPTIONS: "--invalid-hook",
      NPM_TOKEN: "secret",
      SSH_AUTH_SOCK: "/tmp/agent",
      TN_CPU_BENCH_SENTINEL: "secret",
    });
    const result = await runBoundedProcess({
      command: process.execPath,
      args: [
        "--eval",
        "console.log(JSON.stringify([process.env.NODE_OPTIONS, process.env.NPM_TOKEN, process.env.SSH_AUTH_SOCK, process.env.TN_CPU_BENCH_SENTINEL]))",
      ],
      cwd: repoRoot,
      env,
      timeoutMs: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual([null, null, null, null]);
  });
});
