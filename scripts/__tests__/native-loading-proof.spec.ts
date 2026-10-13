import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const source = readFileSync(path.join(repo, "examples/native-smoke/src/game.ts"), "utf8");

function loadingFixture() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; call: () => void }>();
  const frames = new Map<number, () => void>();
  const constants = [...source.matchAll(/^const LOADING_PROOF_COMPILE_[A-Z_]+ = [\d_]+;$/gmu)]
    .map((match) => match[0])
    .join("\n");
  // Evaluate the actual fixture expression, not a second implementation. Three.js construction
  // is the only stub; frame scheduling and wall time are independently controlled below.
  const start = source.indexOf("const loadingProofRenderer =");
  const end = source.indexOf("\nconst game:", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const code = ts.transpileModule(
    `${constants}\n${source.slice(start, end)}\nloadingProofRenderer;`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    },
  ).outputText;
  const renderer = runInNewContext(code, {
    __TN_LOADING_PROOF__: true,
    WebGPURenderer: class {},
    performance: { now: () => now },
    console: { info: () => undefined },
    setTimeout: (call: () => void, delay: number) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, call });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (call: () => void) => {
      const id = ++nextId;
      frames.set(id, call);
      return id;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  }) as {
    webgpuFactory: (canvas: object, options: object) => { compileAsync: () => Promise<void> };
  };
  let settled = false;
  let error = "";
  const promise = renderer
    .webgpuFactory({}, {})
    .compileAsync()
    .then(
      () => {
        settled = true;
      },
      (failure: Error) => {
        settled = true;
        error = failure.message;
      },
    );
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const advance = async (milliseconds: number, frameCount = 0) => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.call();
      }
    }
    for (let index = 0; index < frameCount; index += 1) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const call of callbacks) call();
    }
    await flush();
  };
  return { advance, promise, timers, frames, state: () => ({ settled, error }) };
}

describe("native loading stall fixture", () => {
  it("ships the empty manifest requested during procedural smoke startup", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repo, "examples/native-smoke/assets.manifest.json"), "utf8"),
    );
    expect(manifest).toEqual({ version: 1, entries: {} });
  });

  it("cannot end after three seconds with only 57 frame opportunities", async () => {
    const fixture = loadingFixture();
    await fixture.advance(3_000, 57);
    expect(fixture.state().settled).toBe(false);
    await fixture.advance(0, 4);
    await fixture.promise;
    expect(fixture.state()).toEqual({ settled: true, error: "" });
    expect(fixture.timers.size).toBe(0);
    expect(fixture.frames.size).toBe(0);
  });

  it("retains the minimum stall duration even with a fast frame pump", async () => {
    const fixture = loadingFixture();
    await fixture.advance(500, 120);
    expect(fixture.state().settled).toBe(false);
    await fixture.advance(2_500, 1);
    await fixture.promise;
    expect(fixture.state()).toEqual({ settled: true, error: "" });
  });

  it("fails within a bounded window and cancels observation if frames stop", async () => {
    const fixture = loadingFixture();
    await fixture.advance(10_000);
    await fixture.promise;
    expect(fixture.state().error).toContain("TN_LOADING_PROOF_FRAME_TIMEOUT");
    expect(fixture.timers.size).toBe(0);
    expect(fixture.frames.size).toBe(0);
  });

  it("keeps the independent native-present verifier at 60 frames", () => {
    const verifier = readFileSync(
      path.join(repo, "packages/runtime-native/scripts/verify-desktop-loading.mjs"),
      "utf8",
    );
    expect(verifier).toContain(
      'Number(JSON.parse(line.slice("TN_PRESENTS_TICK:".length)).frames) >= 60',
    );
  });
});
