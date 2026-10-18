import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DataUtils, HalfFloatType, RGBAFormat } from "three";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readWaterProofMode } from "../src/render/waterProof.js";
import {
  WaterProofProbe,
  installWaterProof,
  sampleActiveWaterProof,
} from "../src/render/waterProof.js";

// The package script runs vitest from the package directory with `--root ../..`, so cwd is not the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const verifyOcean = resolve(repoRoot, "examples/strata-terrain-preview/scripts/verify-ocean.mjs");
const strataPackage = resolve(repoRoot, "examples/strata-terrain-preview/package.json");
const ROI = { x: 0, y: 0, width: 280, height: 100 };
const half = (value: number): number => DataUtils.toHalfFloat(value);
const flush = (): Promise<void> => new Promise((settle) => setTimeout(settle, 0));

it("runs the canonical terrain proof against the production Vite build", () => {
  const manifest = JSON.parse(readFileSync(strataPackage, "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = manifest.scripts["test:terrain:web"];

  expect(command).toMatch(
    /^pnpm build && node \.\.\/\.\.\/packages\/playtest\/dist\/runner\/cli\.js playtests\/terrain\.playtest\.json /,
  );
  expect(command).toContain("--url 'http://127.0.0.1:5196/?showcase=1&waterproof=1'");
  expect(command).toContain(
    "--server-command 'pnpm exec vite preview --host 127.0.0.1 --port 5196 --strictPort'",
  );
  expect(command).toContain("--browser-recipe webgpu --headed --artifacts artifacts/playtest/web");
  expect(command).toContain(
    "&& node scripts/verify-ocean.mjs artifacts/playtest/web --proof=water",
  );
  expect(command).not.toContain("pnpm dev");

  const controlCommand = manifest.scripts["test:terrain:web:control"];
  expect(controlCommand).toMatch(
    /^pnpm build && node \.\.\/\.\.\/packages\/playtest\/dist\/runner\/cli\.js playtests\/terrain\.playtest\.json /,
  );
  expect(controlCommand).toContain("--url 'http://127.0.0.1:5196/?showcase=1&waterproof=foam'");
  expect(controlCommand).toContain(
    "--server-command 'pnpm exec vite preview --host 127.0.0.1 --port 5196 --strictPort'",
  );
  expect(controlCommand).toContain(
    "--browser-recipe webgpu --headed --artifacts artifacts/playtest/water-control",
  );
  expect(controlCommand).toContain(
    "&& node scripts/verify-ocean.mjs artifacts/playtest/water-control --proof=foam",
  );
  expect(controlCommand).not.toContain("pnpm dev");
});

// The exact three r185 copyTextureToBuffer layout: every row but the last padded to 256 bytes.
function padded(make: (x: number, y: number) => [number, number]): Uint16Array {
  const stride = (Math.ceil((ROI.width * 8) / 256) * 256) / 2;
  const data = new Uint16Array((ROI.height - 1) * stride + ROI.width * 4);
  for (let y = 0; y < ROI.height; y++)
    for (let x = 0; x < ROI.width; x++) {
      const base = y * stride + x * 4;
      const [r, g] = make(x, y);
      data[base] = half(r);
      data[base + 1] = half(g);
      data[base + 2] = half(0);
      data[base + 3] = half(1);
    }
  return data;
}
const fullPool = (): Uint16Array => padded(() => [1, 1]);

function fakeWorld() {
  const listeners = new Set<(event: { type: string }) => void>();
  const texture = (name: string) => ({
    name,
    format: RGBAFormat,
    type: HalfFloatType,
    colorSpace: "",
  });
  const textures = [texture("output"), texture("normal"), texture("diagnostic")];
  const renderTarget = {
    width: 1280,
    height: 720,
    samples: 4,
    texture: textures[0],
    textures,
    addEventListener: (type: string, listener: (event: { type: string }) => void) => {
      if (type === "dispose") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: { type: string }) => void) => {
      if (type === "dispose") listeners.delete(listener);
    },
    emitDispose: () => {
      for (const listener of [...listeners]) listener({ type: "dispose" });
    },
  };
  return {
    renderTarget,
    updateBefore(frame: unknown) {
      return frame;
    },
    getMRT: () => ({ outputNodes: { output: 1, normal: 1, diagnostic: 1 } }),
  };
}
const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] } };

function makeProbe(world: ReturnType<typeof fakeWorld>, renderer: unknown) {
  const probe = new WaterProofProbe({
    world,
    worldName: "coastal",
    mode: "water",
    renderer,
    camera,
    texture: world.renderTarget.textures[2],
  } as never);
  world.renderTarget.addEventListener("dispose", probe.onRenderTargetDispose);
  return probe;
}
function deferredRenderer() {
  const calls: Array<{ x: number; y: number; width: number; height: number; index: number }> = [];
  const renderer = {
    device: { limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32 } },
    readRenderTargetPixelsAsync(
      _t: unknown,
      x: number,
      y: number,
      width: number,
      height: number,
      index: number,
    ) {
      calls.push({ x, y, width, height, index });
      return new Promise((settle, fail) => {
        (renderer as never as { settle: (v: Uint16Array) => void }).settle = settle as never;
        (renderer as never as { fail: (e: Error) => void }).fail = fail as never;
      });
    },
  };
  return { renderer, calls };
}

afterEach(async () => {
  await flush();
  await flush();
});

// One request and one copy stay open until they settle: a second ask joins the same request.
it("issues one copy until the readback settles and shares one observation", async () => {
  const world = fakeWorld();
  const { renderer, calls } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  try {
    const first = probe.sample("horizon-sea");
    const second = probe.sample("horizon-sea");
    probe.afterWorldPass();
    probe.afterWorldPass();
    expect(calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ x: 940, y: 600, width: 280, height: 100 });
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(fullPool());
    const [a, b] = await Promise.all([first, second]);
    expect((a.waterProof as { available: boolean }).available).toBe(true);
    expect((a.waterProof as { label: string }).label).toBe("horizon-sea");
    expect(b.waterProof).toBe(a.waterProof);
  } finally {
    probe.dispose();
  }
});

// A resize (dispose on the same render target) rejects every waiter and ignores the late copy.
it("rejects every waiter stale on a resize and ignores the late copy", async () => {
  const world = fakeWorld();
  const { renderer } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  try {
    const first = probe.sample("horizon-sea");
    const second = probe.sample("horizon-sea");
    probe.afterWorldPass();
    world.renderTarget.emitDispose();
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(fullPool());
    await expect(first).rejects.toThrow(/TN_WATER_PROOF_STALE/);
    await expect(second).rejects.toThrow(/TN_WATER_PROOF_STALE/);
  } finally {
    probe.dispose();
  }
});

// The one physical copy stays busy across a resize until the original readback settles.
it("keeps one physical copy busy until the original readback settles", async () => {
  const world = fakeWorld();
  const { renderer, calls } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  try {
    const first = probe.sample("horizon-sea");
    probe.afterWorldPass();
    expect(calls.length).toBe(1);
    world.renderTarget.emitDispose();
    await expect(first).rejects.toThrow(/TN_WATER_PROOF_STALE/);
    const second = probe.sample("horizon-sea");
    probe.afterWorldPass();
    expect(calls.length).toBe(1);
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(fullPool());
    await flush();
    probe.afterWorldPass();
    expect(calls.length).toBe(2);
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(fullPool());
    await expect(second).resolves.toMatchObject({ waterProof: { available: true } });
  } finally {
    probe.dispose();
  }
});

// The timeout spans the whole operation: a copy that never settles still rejects its waiters.
it("rejects every waiter with a timeout when the copy never settles", async () => {
  vi.useFakeTimers();
  const world = fakeWorld();
  const { renderer } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  try {
    const first = probe.sample("horizon-sea");
    const second = probe.sample("horizon-sea");
    probe.afterWorldPass();
    vi.advanceTimersByTime(5_000);
    await expect(first).rejects.toThrow(/TN_WATER_PROOF_TIMEOUT/);
    await expect(second).rejects.toThrow(/TN_WATER_PROOF_TIMEOUT/);
  } finally {
    vi.useRealTimers();
    probe.dispose();
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(fullPool());
  }
});

// Disposal settles the open waiter; a later sample is rejected, never left hanging.
it("settles the open waiter on dispose and rejects later samples", async () => {
  const world = fakeWorld();
  const { renderer } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  const first = probe.sample("horizon-sea");
  probe.dispose();
  await expect(first).rejects.toThrow(/TN_WATER_PROOF_DISPOSED/);
  await expect(probe.sample()).rejects.toThrow(/TN_WATER_PROOF_DISPOSED/);
});

// A malformed resolved buffer rejects every waiter and leaves no unhandled rejection.
it("rejects every waiter on a malformed readback without an unhandled rejection", async () => {
  let unhandled = 0;
  const count = (): void => {
    unhandled += 1;
  };
  process.on("unhandledRejection", count);
  const world = fakeWorld();
  const { renderer } = deferredRenderer();
  const probe = makeProbe(world, renderer);
  try {
    const first = probe.sample("horizon-sea");
    const second = probe.sample("horizon-sea");
    probe.afterWorldPass();
    (renderer as never as { settle: (v: Uint16Array) => void }).settle(new Uint16Array(3));
    await expect(first).rejects.toThrow(/TN_WATER_PROOF_LENGTH/);
    await expect(second).rejects.toThrow(/TN_WATER_PROOF_LENGTH/);
    await flush();
    await flush();
    expect(unhandled).toBe(0);
  } finally {
    process.off("unhandledRejection", count);
    probe.dispose();
  }
});

// --- Whole CLI: run the real verify-ocean.mjs as the runner calls it -----------------------------
const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) {
    try {
      // Fixtures land under the process TMPDIR (the owned scratch) and are removed here.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function observation(statistics?: Record<string, unknown>) {
  return {
    available: true,
    requestId: 1,
    label: "horizon-sea",
    mode: "foam",
    world: "coastal",
    frame: 1,
    time: 0,
    camera: { matrixWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1], position: [5, 6, 7] },
    format: { color: "RGBA16F", samples: 4, attachments: 3 },
    dimensions: { width: 1280, height: 720 },
    limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32 },
    roi: { x: 940, y: 600, width: 280, height: 100, scale: 1, referenceWidth: 1280 },
    statistics: statistics ?? {
      area: 100,
      considered: 100,
      fraction: 0,
      passes: false,
      qualifying: 0,
      threshold: 0.5,
      minFraction: 0.7,
    },
    frozen: true,
  };
}
function fixtureDirectory(observations: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wp-cli-"));
  fixtureDirs.push(dir);
  writeFileSync(
    join(dir, "console.json"),
    JSON.stringify(
      observations.map((entry) => ({ text: `TN_WATER_PROOF:${JSON.stringify(entry)}` })),
    ),
  );
  return dir;
}
function runCli(dir: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [verifyOcean, dir, "--proof=foam"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? error),
    };
  }
}

it("CLI: an empty proof fails on a missing witness, never a temporal-dead-zone error", () => {
  const { code, stderr } = runCli(fixtureDirectory([]));
  expect(code).not.toBe(0);
  expect(stderr).not.toMatch(/before initialization/i);
  expect(stderr).toMatch(/expected exactly one observation/);
});

it("CLI: the forced-foam control cleanly fails the water gate with fraction 0", () => {
  const { code, stdout } = runCli(fixtureDirectory([observation()]));
  expect(code).toBe(0);
  expect(stdout).toContain('"oceanVisual":"forced-foam-control"');
});

it("CLI: the forced-foam numeric gate is inclusive at exactly minFraction", () => {
  const atGate = runCli(
    fixtureDirectory([
      observation({
        area: 100,
        considered: 100,
        fraction: 0.7,
        passes: true,
        qualifying: 70,
        threshold: 0.5,
        minFraction: 0.7,
      }),
    ]),
  );
  expect(atGate.code).not.toBe(0);
  expect(atGate.stderr).toMatch(/forced-foam control passed the water gate/);

  const belowGate = runCli(
    fixtureDirectory([
      observation({
        area: 100,
        considered: 100,
        fraction: 0.69,
        passes: false,
        qualifying: 69,
        threshold: 0.5,
        minFraction: 0.7,
      }),
    ]),
  );
  expect(belowGate.code).toBe(0);
  expect(belowGate.stdout).toContain('"oceanVisual":"forced-foam-control"');
});

it("does not wait for a water readback during unrelated readiness observations", () => {
  const world = fakeWorld();
  const { renderer, calls } = deferredRenderer();
  const cleanup = installWaterProof({
    world,
    worldName: "coastal",
    mode: "water",
    renderer,
    camera,
    texture: world.renderTarget.textures[2],
  } as never);
  try {
    const observation = sampleActiveWaterProof({ label: "enter-coastal" });
    expect(observation).not.toBeInstanceOf(Promise);
    world.updateBefore(null);
    expect(calls).toHaveLength(0);
  } finally {
    cleanup();
  }
});

it.each([
  [1171, 659],
  [1382, 778],
])("CLI: accepts independently rounded 16:9 dimensions %ix%i", (width, height) => {
  const entry = observation();
  entry.dimensions = { width, height };
  const scale = width / 1280;
  entry.roi = {
    x: Math.round(940 * scale),
    y: Math.round(600 * scale),
    width: Math.round(280 * scale),
    height: Math.round(100 * scale),
    scale,
    referenceWidth: 1280,
  };
  expect(runCli(fixtureDirectory([entry])).code).toBe(0);
});

it("CLI: rejects a stretched render target", () => {
  const entry = observation();
  entry.dimensions = { width: 1280, height: 700 };
  const result = runCli(fixtureDirectory([entry]));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("not the shared 16:9 frame");
});

it("CLI: rejects a fraction inconsistent with its measured water weights", () => {
  const entry = observation();
  entry.statistics.fraction = 0.1;
  entry.statistics.qualifying = 99;
  const result = runCli(fixtureDirectory([entry]));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("does not match the measured weights");
});

it("CLI: rejects water area exceeding the considered pixels", () => {
  const entry = observation();
  entry.statistics.area = 101;
  const result = runCli(fixtureDirectory([entry]));
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("water area exceeds the considered pixels");
});

it("uses the installed launch flags to opt into native water and forced foam", () => {
  vi.stubEnv("TN_DEBUG_WATERPROOF", "0");
  vi.stubEnv("TN_DEBUG_WATERPROOF_FOAM", "0");
  try {
    expect(readWaterProofMode(undefined)).toBe("off");
    vi.stubEnv("TN_DEBUG_WATERPROOF", "1");
    expect(readWaterProofMode(undefined)).toBe("water");
    vi.stubEnv("TN_DEBUG_WATERPROOF_FOAM", "1");
    expect(readWaterProofMode(undefined)).toBe("foam");
  } finally {
    vi.unstubAllEnvs();
  }
});
