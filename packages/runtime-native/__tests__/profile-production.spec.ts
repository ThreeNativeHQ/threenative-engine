import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const STAGING_DIRECTORY = ".threenative-profile-production";

type Instrumentation = {
  /** The primary checkout that owns a checkout or linked worktree at `cwd`. */
  owningCheckout(cwd: string): string;
  /** The temporary staging parent for that checkout: outside every workspace, same volume. */
  stagingParentDirectory(
    primaryCheckout: string,
    workspaceExists?: (path: string) => boolean,
  ): string;
  webFrameInstrumentation(
    control: string | undefined,
    warmupFrames?: number,
    paceTicks?: boolean,
    liveClock?: boolean,
  ): string;
  nativeFrameInstrumentation(
    control: string | undefined,
    warmupFrames?: number,
    paceTicks?: boolean,
  ): string;
  productionExecutionHold(paceTicks?: boolean): string;
  nativeLaunchesExternalBundle(
    artifactPath: string,
    options: { prebuiltArtifact?: string },
  ): boolean;
  setNativeProfileEntry(
    project: string,
    entry: string,
    renderSize?: { height: number; width: number },
  ): Promise<void>;
};

async function instrumentation(): Promise<Instrumentation> {
  return (await import(
    new URL("../scripts/profile-production.mjs", import.meta.url).href
  )) as Instrumentation;
}

type FrameSample = { frameMs: number; presentationMs?: number };

interface SandboxHarness {
  bridge: { advance(ticks: number): Promise<unknown>; sample(): unknown };
  /** Wall milliseconds the sandbox clock has moved since the instrumentation was evaluated. */
  elapsedMs(): number;
  /** Every line the instrumentation reported; the web arm reports over the console, not a fetch. */
  lines: string[];
  /** The delay of every `setTimeout` the instrumentation itself scheduled, in request order. */
  timers: number[];
  /** Registers a consumer callback through the wrapper the instrumentation installed. */
  register(callback: () => void): void;
  /** Fires every scheduled callback once with one shared presentation timestamp. */
  present(timestamp: number): void;
}

/**
 * @param clockConsumingAdvance Model the live clock's `wallClockAdvance`, which spends the span its
 *   ticks name before it returns. A fixed-step `advance` returns at once.
 */
function createSandbox(source: string, { clockConsumingAdvance = false } = {}): SandboxHarness {
  const scheduled: Array<(timestamp: number) => void> = [];
  const timers: number[] = [];
  const lines: string[] = [];
  const origin = 1_000;
  let clock = origin;
  const bridge = {
    advance: async (ticks: number) => {
      if (clockConsumingAdvance) clock += (1_000 / 60) * ticks;
      return { clock: { mode: "fixed-step", tick: ticks }, ticks };
    },
    sample: () => ({}),
  };
  const sandbox: Record<string, unknown> = {
    Date,
    JSON,
    Number,
    Object,
    Promise,
    console: { log: (line: string) => lines.push(line) },
    performance: { now: () => clock },
    requestAnimationFrame: (callback: (timestamp: number) => void) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      timers.push(milliseconds);
      clock += milliseconds;
      callback();
      return timers.length;
    },
    __THREENATIVE_PLAYTEST_BRIDGE__: bridge,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox);
  return {
    bridge,
    elapsedMs: () => clock - origin,
    lines,
    register: (callback) => {
      (sandbox.requestAnimationFrame as (callback: () => void) => number)(callback);
    },
    present: (timestamp) => {
      clock = timestamp;
      for (const callback of scheduled) callback(timestamp);
    },
    timers,
  };
}

describe("production profile frame sampling", () => {
  it("should count one frame per requestAnimationFrame presentation, not per callback", async () => {
    const { webFrameInstrumentation } = await instrumentation();
    const harness = createSandbox(webFrameInstrumentation(undefined, 0));
    // Two consumers registered for the same presentation: the game loop and a second callback.
    harness.register(() => {});
    harness.register(() => {});
    for (let index = 0; index < 31; index += 1) {
      harness.present(1_000 + (index + 1) * (1_000 / 60));
    }
    const prefix = "TN_PROD_FRAME_SAMPLES:";
    const batch = harness.lines.find((line) => line.startsWith(prefix));
    const samples: FrameSample[] = JSON.parse((batch ?? `${prefix}[]`).slice(prefix.length));
    expect(samples).toHaveLength(30);
    expect(samples.every(({ frameMs }) => frameMs > 0)).toBe(true);
    const presentations = samples.map(({ presentationMs }) => presentationMs as number);
    expect(
      presentations.every((value, index) => index === 0 || value > (presentations[index - 1] ?? 0)),
    ).toBe(true);
  });

  it("should spend one tick interval per tick on either clock, and none on the default", async () => {
    const { webFrameInstrumentation } = await instrumentation();
    const perTenTicks = (1_000 / 60) * 10;
    // A live-clock `advance` already waited the span its ticks name, so the pacer's own deadline is
    // met when it reads it: the run must cost one interval per tick, not the two that a second wait
    // would add, and the pacer must not even schedule that second wait.
    const live = createSandbox(webFrameInstrumentation(undefined, 0, true, true), {
      clockConsumingAdvance: true,
    });
    await live.bridge.advance(10);
    expect(live.elapsedMs()).toBeCloseTo(perTenTicks, 3);
    expect(live.timers).toEqual([]);
    // A fixed-step `advance` returns at once, so the wait is the whole of the tick budget the run
    // asked for — the host's frame pump runs inside it and the frames exist to be measured.
    const paced = createSandbox(webFrameInstrumentation(undefined, 0, true));
    await paced.bridge.advance(10);
    expect(paced.elapsedMs()).toBeCloseTo(perTenTicks, 3);
    expect(paced.timers).toEqual([expect.closeTo(perTenTicks, 0.01)]);
    // The default run is untouched: it authors its own timing, so nothing here is wrapped.
    const plain = createSandbox(webFrameInstrumentation(undefined, 0));
    await plain.bridge.advance(10);
    expect(plain.elapsedMs()).toBe(0);
    expect(plain.timers).toEqual([]);
  });

  it("should compile the native instrumentation with the same hold", async () => {
    const { nativeFrameInstrumentation, productionExecutionHold } = await instrumentation();
    expect(() => createSandbox(nativeFrameInstrumentation("slow-native", 0, true))).not.toThrow();
    expect(productionExecutionHold(true)).toContain("tnProductionPaceEnabled = true");
    expect(productionExecutionHold()).toContain("tnProductionPaceEnabled = false");
  });

  it("should pass an external bundle only to the bare prebuilt runtime", async () => {
    const { nativeLaunchesExternalBundle } = await instrumentation();
    const runtime = "/runtime/threenative";
    const packagedGame = "/project/dist-native/game";
    expect(nativeLaunchesExternalBundle(runtime, { prebuiltArtifact: runtime })).toBe(true);
    expect(nativeLaunchesExternalBundle(packagedGame, { prebuiltArtifact: runtime })).toBe(false);
    expect(nativeLaunchesExternalBundle(packagedGame, {})).toBe(false);
  });
});

/**
 * Git's own linked-checkout layout, built in a throwaway directory: a `.git` file naming an admin
 * directory whose `commondir` is the primary `.git`. No worktree is created in any real repository.
 */
function linkedCheckoutLayout(): { linked: string; primary: string; root: string } {
  const root = realpathSync(makeTempDirSync("tn-prod-staging-"));
  const primary = join(root, "primary");
  execFileSync("git", ["init", "--quiet", primary]);
  writeFileSync(join(primary, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const admin = join(primary, ".git", "worktrees", "linked");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/linked\n");
  writeFileSync(join(admin, "commondir"), "../..\n");
  const linked = join(primary, ".worktrees", "linked");
  mkdirSync(linked, { recursive: true });
  writeFileSync(join(linked, ".git"), `gitdir: ${admin}\n`);
  return { linked, primary, root };
}

function primaryCheckoutLayout(): { primary: string; root: string } {
  const root = realpathSync(makeTempDirSync("tn-prod-staging-"));
  const primary = join(root, "primary");
  execFileSync("git", ["init", "--quiet", primary]);
  writeFileSync(join(primary, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  return { primary, root };
}

describe("production profile native entry", () => {
  const CONFIG =
    'const config = {\n  app: { id: "com.x" },\n  nativeEntry: "src/game.ts",\n  window: { width: 1280, height: 720 },\n};\nexport default config;\n';

  async function project(configSource: string, packageSource = '{"name":"game"}\n') {
    const root = realpathSync(makeTempDirSync("tn-prod-entry-"));
    writeFileSync(join(root, "threenative.config.ts"), configSource);
    writeFileSync(join(root, "package.json"), packageSource);
    return root;
  }

  it("should declare the native entry in exactly one file when the config already names it", async () => {
    const { setNativeProfileEntry } = await instrumentation();
    const entry = "src/profile-native-entry.ts";
    const root = await project(CONFIG.replace("src/game.ts", entry));
    try {
      await setNativeProfileEntry(root, entry, { height: 1080, width: 1920 });
      // Both files declaring it is the state the config layer refuses with TN_CONFIG_CONFLICT, so
      // the profile command could never run a second time against a project it had already staged.
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(packageJson.threenative?.nativeEntry).toBeUndefined();
      expect(readFileSync(join(root, "threenative.config.ts"), "utf8")).toContain(
        `nativeEntry: "${entry}"`,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("should fall back to package.json only for a config that declares no native entry", async () => {
    const { setNativeProfileEntry } = await instrumentation();
    const entry = "src/profile-native-entry.ts";
    const root = await project(
      'const config = {\n  app: { id: "com.x" },\n  window: { width: 1280, height: 720 },\n};\nexport default config;\n',
    );
    try {
      await setNativeProfileEntry(root, entry, { height: 1080, width: 1920 });
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(packageJson.threenative.nativeEntry).toBe(entry);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("should repair a project already declaring the entry in both files", async () => {
    const { setNativeProfileEntry } = await instrumentation();
    const entry = "src/profile-native-entry.ts";
    const root = await project(
      CONFIG.replace("src/game.ts", entry),
      `${JSON.stringify({ name: "game", threenative: { nativeEntry: entry } }, null, 2)}\n`,
    );
    try {
      await setNativeProfileEntry(root, entry, { height: 1080, width: 1920 });
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(packageJson.threenative).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("production profile staging", () => {
  it("should stage a linked checkout outside the owning workspace, where a real install lands in the game", async () => {
    const { owningCheckout, stagingParentDirectory } = await instrumentation();
    const { linked, primary, root } = linkedCheckoutLayout();
    try {
      expect(owningCheckout(linked)).toBe(primary);
      const parent = stagingParentDirectory(owningCheckout(linked));
      // Beside the primary checkout, never beside the linked one: `primary/.worktrees` is still
      // inside the primary workspace, where pnpm installs into the workspace root instead.
      expect(parent).toBe(join(root, STAGING_DIRECTORY));
      expect(relative(primary, parent).startsWith("..")).toBe(true);
      const game = join(parent, "threenative-production-test", "platformer");
      mkdirSync(game, { recursive: true });
      writeFileSync(
        join(game, "package.json"),
        '{"name":"platformer","private":true,"version":"0.0.0"}\n',
      );
      execFileSync("pnpm", ["install", "--ignore-scripts", "--offline", "--reporter=silent"], {
        cwd: game,
      });
      expect(existsSync(join(game, "node_modules"))).toBe(true);
      expect(existsSync(join(primary, "node_modules"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("should stage the primary checkout outside its own workspace", async () => {
    const { owningCheckout, stagingParentDirectory } = await instrumentation();
    const { primary, root } = primaryCheckoutLayout();
    try {
      expect(owningCheckout(primary)).toBe(primary);
      const parent = stagingParentDirectory(owningCheckout(primary));
      expect(parent).toBe(join(root, STAGING_DIRECTORY));
      for (
        let directory = parent;
        directory !== dirname(directory);
        directory = dirname(directory)
      ) {
        expect(existsSync(join(directory, "pnpm-workspace.yaml"))).toBe(false);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("should keep climbing while an ancestor is itself a workspace", async () => {
    const { stagingParentDirectory } = await instrumentation();
    const workspaces = new Set(["/w/pnpm-workspace.yaml", "/w/inner/pnpm-workspace.yaml"]);
    expect(stagingParentDirectory("/w/inner/checkout", (path) => workspaces.has(path))).toBe(
      join("/", STAGING_DIRECTORY),
    );
  });
});

describe("production package flags", () => {
  // The macOS desktop-core collector refused threenative-animation-mcp with
  // TN_PROD_PACKAGE_FLAG_UNSUPPORTED: its copy of the flag rule named two MCP packages by hand.
  it("passes every workspace package to the scaffolder under the shared flag rule", async () => {
    const { packageSourceFlag } = (await import(
      new URL("../scripts/profile-production.mjs", import.meta.url).href
    )) as { packageSourceFlag(name: string): string };
    const { workspacePackages, workspacePackageSourceFlag } = await import(
      "../../../scripts/workspace-packages.js"
    );
    const names = workspacePackages().map(({ name }) => name);
    expect(names).toContain("threenative-animation-mcp");
    for (const name of names)
      expect(packageSourceFlag(name), name).toBe(workspacePackageSourceFlag(name));
  });
});
