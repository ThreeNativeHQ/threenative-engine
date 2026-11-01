import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_TIERS,
  costCommentGaps,
  enabledStages,
  presetLiteralsIn,
  templateNames,
} from "../../../scripts/template-quality.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createProject } from "../src/index.js";

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** Every template on disk, so one added tomorrow is covered the day it ships. */
const names = await templateNames(templatesDir);

interface IQualityModule {
  readonly qualityPreset: (tier: string) => Record<string, unknown>;
  readonly resolveQualityTier: (request?: {
    gpuClass?: string;
    mobile?: boolean;
    software?: boolean;
    tier?: string;
  }) => string;
}

async function load(template: string): Promise<IQualityModule> {
  return (await import(
    path.join(templatesDir, template, "src", "render", "quality.ts")
  )) as IQualityModule;
}

interface IRenderChain {
  readonly perAdapter?: Record<string, { tier?: string }>;
  readonly tier?: string;
}

/** The `renderChain` block of every scenario a template ships, wherever the template keeps it. */
async function renderChains(template: string): Promise<{ chain: IRenderChain; label: string }[]> {
  const found: { chain: IRenderChain; label: string }[] = [];
  for (const dir of [
    path.join(templatesDir, template),
    path.join(templatesDir, "..", "template-playtests", template),
  ]) {
    for (const file of await readdir(dir, { recursive: true }).catch(() => [])) {
      if (!file.endsWith(".playtest.json")) continue;
      const scenario = JSON.parse(await readFile(path.join(dir, file), "utf8")) as {
        assert?: { renderChain?: IRenderChain };
      };
      const chain = scenario.assert?.renderChain;
      if (chain !== undefined) found.push({ chain, label: `${template}/${file}` });
    }
  }
  return found;
}

function scenarioTier(chain: IRenderChain, adapter: string): string | undefined {
  const generic = adapter === "software" ? "software" : "hardware";
  return (chain.perAdapter?.[adapter] ?? chain.perAdapter?.[generic])?.tier ?? chain.tier;
}

describe("template quality tiers", () => {
  it("should find the eight shipped templates rather than an empty list", () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain("starter");
  });

  it("should ship a quality module in every template", async () => {
    const missing: string[] = [];
    for (const name of names) {
      const file = path.join(templatesDir, name, "src", "render", "quality.ts");
      await readFile(file, "utf8").catch(() => missing.push(name));
    }
    expect(missing).toEqual([]);
  });

  it("should leave no preset literal behind in any postprocessing module", async () => {
    const leftovers: string[] = [];
    for (const name of names) {
      const source = await readFile(
        path.join(templatesDir, name, "src", "render", "postprocessing.ts"),
        "utf8",
      );
      if (presetLiteralsIn(source).length > 0) leftovers.push(name);
    }
    expect(leftovers).toEqual([]);
  });

  it("should read the quality module from every postprocessing module", async () => {
    const unwired: string[] = [];
    for (const name of names) {
      const source = await readFile(
        path.join(templatesDir, name, "src", "render", "postprocessing.ts"),
        "utf8",
      );
      if (!source.includes('from "./quality.js"')) unwired.push(name);
    }
    expect(unwired).toEqual([]);
  });

  it("should throw when the tier is not a known name", async () => {
    const { resolveQualityTier } = await load("starter");
    expect(() => resolveQualityTier({ tier: "ultra" })).toThrow(/"ultra"/u);
  });

  it("should throw from qualityPreset too, rather than returning the default", async () => {
    const { qualityPreset } = await load("starter");
    expect(() => qualityPreset("ultra")).toThrow(/"ultra"/u);
  });

  it("should resolve low when the platform is mobile and no tier is given", async () => {
    const { resolveQualityTier } = await load("starter");
    expect(resolveQualityTier({ mobile: true })).toBe("low");
    expect(resolveQualityTier({ mobile: false })).toBe("high");
    expect(resolveQualityTier()).toBe("high");
  });

  it("should let an explicit tier override the platform", async () => {
    const { resolveQualityTier } = await load("starter");
    expect(resolveQualityTier({ mobile: true, tier: "high" })).toBe("high");
    expect(resolveQualityTier({ mobile: false, tier: "low" })).toBe("low");
  });

  // Run 36821800527, `template-nonvisual (starter, 2/3)`: a SwiftShader adapter reported
  // `swiftshader/google`, the game took `high`, one frame cost 2,649.9 ms at 4.6 s uptime and the
  // device was gone. The engine reads the adapter; what a software rasteriser gets to look at is
  // this game's own answer, and it has to be one of the tiers the game already declares.
  it("should take the cheap tier on a named software adapter in every template", async () => {
    for (const name of names) {
      const { resolveQualityTier } = await load(name);
      expect(
        resolveQualityTier({ software: true }),
        `${name}: software adapter at the desktop tier`,
      ).toBe("low");
    }
  });

  it("should still let a named tier override a software adapter", async () => {
    for (const name of names) {
      const { resolveQualityTier } = await load(name);
      expect(
        resolveQualityTier({ software: true, tier: "high" }),
        `${name}: override ignored`,
      ).toBe("high");
      expect(
        () => resolveQualityTier({ tier: "ultra", software: true }),
        `${name}: unknown name`,
      ).toThrow(/"ultra"/u);
    }
  });

  // The actual flow, not the resolver: `setupPost` is where the environment reaches
  // `resolveQualityTier`, and ten of eleven call sites read `mobile` and `tier` while dropping
  // `software`. Every assertion above calls the resolver directly and every one of them stayed
  // green with the fact discarded, so this drives each template's own `setupPost` and reads the
  // tier it reported for itself. On the old call sites these report `high`.
  it("should take the cheap tier through each template's own setupPost on a software adapter", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const generatedRoot = await makeTempDir("template-quality-setup-post-");
      for (const name of names) {
        const { target } = await createProject(
          { install: false, target: name, template: name },
          generatedRoot,
        );
        // Generate the canonical render sources that the installed kit receives.
        for (const [dependency, source] of [
          ["@threenative/core", path.resolve("packages/core")],
          ["three", path.resolve("packages/create-threenative/node_modules/three")],
        ] as const) {
          const link = path.join(target, "node_modules", dependency);
          await mkdir(path.dirname(link), { recursive: true });
          await symlink(source, link, "dir");
        }
        const post = (await import(path.join(target, "src", "render", "postprocessing.ts"))) as {
          setupPost: (
            renderer: unknown,
            scene: unknown,
            camera: unknown,
            environment?: {
              gpuClass?: string;
              mobile?: boolean;
              software?: boolean;
              tier?: string;
            },
          ) => { dispose?: () => void };
        };
        const renderer = {
          kind: "webgpu",
          raw: {},
          // A working chain runs what it was asked for; a kit that fails closed when its own
          // stage is missing (rain) must see it applied, as it would on a real renderer.
          createRenderChain: (options?: { request?: { stages?: readonly string[] } }) => ({
            applied: { dropped: [], stages: [...(options?.request?.stages ?? [])] },
            dispose() {},
          }),
        };
        const reported = (environment: Parameters<typeof post.setupPost>[3]): string => {
          info.mockClear();
          post.setupPost(renderer, new Scene(), new PerspectiveCamera(), environment);
          // The chain prints its own report after the tier line, so pick that line out.
          return (
            info.mock.calls
              .map((call) => String(call[0]))
              .find((line) => line.startsWith("TN_QUALITY_TIER")) ?? ""
          );
        };

        expect(reported({ mobile: false, software: true }), `${name}: software adapter`).toContain(
          "TN_QUALITY_TIER low",
        );
        // The tier the game pinned still wins over the adapter fact, or the pin is not a pin.
        expect(
          reported({ mobile: false, software: true, tier: "high" }),
          `${name}: override`,
        ).toContain("TN_QUALITY_TIER high");
        expect(reported({ mobile: false, software: false }), `${name}: hardware`).toContain(
          "TN_QUALITY_TIER high",
        );
        expect(reported({ mobile: true, software: false }), `${name}: phone`).toContain(
          "TN_QUALITY_TIER low",
        );
        // PRD-563: the family the renderer named reaches the resolver through each call site.
        expect(reported({ gpuClass: "integrated", mobile: false }), `${name}: iGPU`).toContain(
          "TN_QUALITY_TIER medium",
        );
        expect(reported({ gpuClass: "discrete", mobile: false }), `${name}: card`).toContain(
          "TN_QUALITY_TIER high",
        );
        expect(reported({ gpuClass: "unknown", mobile: true }), `${name}: unknown`).toContain(
          "TN_QUALITY_TIER low",
        );
      }
    } finally {
      info.mockRestore();
    }
  });

  it("should keep the desktop tier when no adapter was named", async () => {
    for (const name of names) {
      const { resolveQualityTier } = await load(name);
      expect(resolveQualityTier({ software: false }), `${name}: reads absence as hardware`).toBe(
        "high",
      );
    }
  });

  // PRD-563: the renderer names a GPU family and the game maps it to a start tier. `unknown` is
  // every adapter no rule matched (Apple Silicon, a new vendor), so it must give today's answer.
  it("should resolve an unknown or absent GPU family exactly as before in every template", async () => {
    for (const name of names) {
      const { resolveQualityTier } = await load(name);
      for (const base of [
        {},
        { mobile: true },
        { mobile: false },
        { software: true },
        { mobile: true, tier: "medium" },
      ]) {
        const before = resolveQualityTier(base);
        expect(resolveQualityTier({ ...base, gpuClass: "unknown" }), `${name} unknown`).toBe(
          before,
        );
        expect(resolveQualityTier({ ...base, gpuClass: undefined }), `${name} absent`).toBe(before);
      }
    }
  });

  it("should start each GPU family on the tier the game names for it in every template", async () => {
    const expected: Record<string, string> = {
      discrete: "high",
      integrated: "medium",
      "mobile-high": "medium",
      "mobile-low": "low",
      "mobile-mid": "low",
      software: "low",
    };
    for (const name of names) {
      const { resolveQualityTier } = await load(name);
      for (const [gpuClass, tier] of Object.entries(expected)) {
        expect(resolveQualityTier({ gpuClass }), `${name} ${gpuClass}`).toBe(tier);
        // A family is a start: the explicit tier and the software fact keep outranking it.
        expect(resolveQualityTier({ gpuClass, tier: "high" }), `${name} ${gpuClass} pinned`).toBe(
          "high",
        );
      }
      expect(resolveQualityTier({ gpuClass: "discrete", software: true }), `${name}`).toBe("low");
    }
  });

  // A scenario's flat `renderChain.tier` is held by every adapter its `perAdapter` rows do not name.
  // A template that starts a GPU family on another tier than that flat one fails the scenario on
  // that machine unless the family has a row, and a row that disagrees with the game fails it the
  // other way. Both are read off the template's own table, never typed twice by hand, and every
  // scenario that asserts a chain is read — web, native and look, with or without `perAdapter`.
  it("should name the start tier of every adapter a template scenario would otherwise miss", async () => {
    const adapters: [string, { gpuClass?: string; software?: boolean }][] = [
      ["discrete", { gpuClass: "discrete" }],
      ["integrated", { gpuClass: "integrated" }],
      ["mobile-high", { gpuClass: "mobile-high" }],
      ["mobile-low", { gpuClass: "mobile-low" }],
      ["mobile-mid", { gpuClass: "mobile-mid" }],
      ["software", { software: true }],
    ];
    const read: string[] = [];
    for (const name of names) {
      const { qualityPreset, resolveQualityTier } = await load(name);
      for (const { chain, label } of await renderChains(name)) {
        read.push(label);
        for (const [adapter, request] of adapters) {
          const asserted = scenarioTier(chain, adapter);
          if (asserted === undefined) continue;
          const tier = resolveQualityTier(request);
          expect(asserted, `${label}: ${adapter} row`).toBe(
            name === "runner" ? qualityPreset(tier).renderChainTier : tier,
          );
        }
      }
    }
    expect(read, "no template scenario asserted a render chain to check").not.toHaveLength(0);
    expect(read, "the scan missed a native scenario").toContain(
      "rain/native-playtests/boot.playtest.json",
    );
  });

  // The tier the game picks and the tier the renderer's chain runs at are two separate settings, and
  // a preset that names only the first leaves the chain at its own `high` default. Found by a real
  // forced-SwiftShader run on `minimal`: TN_QUALITY_TIER said `low`, and the run still reported
  // `renderChain.tier: "high"`, because no template but `starter` set `renderChainTier` — so the low
  // preset paid for the high chain's denoise and slice counts. Every fixture asserting
  // `perAdapter.software: {tier: "low"}` was green anyway, because those are read off the tier the
  // game chose rather than off the chain that ran. The same gap sat in `medium` for ten kits: the
  // game resolved `medium` for an integrated or mobile-high GPU while the chain stayed on `high`.
  it.each(QUALITY_TIERS)(
    "Runner keeps SSR off at %s without changing its core curve or meter",
    async (tier) => {
      const { qualityPreset } = await load("runner");
      expect(qualityPreset(tier)).toMatchObject({
        ssrEnabled: false,
        tonemapMode: "filmic",
        autoExposureEnabled: true,
        gtaoRadius: 0.35,
        samples: 4,
      });
    },
  );

  it("Runner's measured cap preserves every non-overridden core medium option", async () => {
    const { qualityPreset, resolveQualityTier } = await load("runner");
    const core = await import("@threenative/core");
    const { exposureSettings } = await import(
      path.join(templatesDir, "runner/src/render/exposure.ts")
    );
    expect(resolveQualityTier({ tier: "high" })).toBe("high");
    expect(qualityPreset("high")).toEqual({
      ...core.qualityPreset("medium"),
      ssrEnabled: false,
      gtaoRadius: 0.35,
      samples: 4,
      exposurePolicy: exposureSettings,
    });
  });

  it("should request the chain tier it names in every template's preset", async () => {
    for (const name of names) {
      const { qualityPreset } = await load(name);
      for (const tier of QUALITY_TIERS) {
        // The chain falls back to `high` when a preset names no `renderChainTier`.
        expect(
          qualityPreset(tier).renderChainTier ?? "high",
          `${name}: ${tier} preset leaves the render chain on another tier`,
        ).toBe(name === "runner" && tier === "high" ? "medium" : tier);
      }
    }
  });

  it("should differ between low and high in at least one enabled stage", async () => {
    for (const name of names) {
      const { qualityPreset } = await load(name);
      expect(
        qualityPreset("low"),
        `${name}: low and high render the same thing, so the switch is three names for one look`,
      ).not.toEqual(qualityPreset("high"));
    }
  });

  it("should give medium its own look, between the other two", async () => {
    for (const name of names) {
      const { qualityPreset } = await load(name);
      if (name === "runner")
        expect(qualityPreset("high"), "Runner's measured high-to-medium cap").toEqual(
          qualityPreset("medium"),
        );
      else
        expect(qualityPreset("medium"), `${name}: medium equals high`).not.toEqual(
          qualityPreset("high"),
        );
      expect(qualityPreset("medium"), `${name}: medium equals low`).not.toEqual(
        qualityPreset("low"),
      );
    }
  });

  it("should never enable at a cheaper tier a stage the tier above leaves off", async () => {
    for (const name of names) {
      const { qualityPreset } = await load(name);
      const high = enabledStages(qualityPreset("high"));
      const medium = enabledStages(qualityPreset("medium"));
      const low = enabledStages(qualityPreset("low"));
      expect(
        medium.filter((stage) => !high.includes(stage)),
        `${name}: medium over high`,
      ).toEqual([]);
      expect(
        low.filter((stage) => !medium.includes(stage)),
        `${name}: low over medium`,
      ).toEqual([]);
    }
  });

  it("should carry a cost comment for every stage the high tier enables", async () => {
    for (const name of names) {
      const source = await readFile(
        path.join(templatesDir, name, "src", "render", "quality.ts"),
        "utf8",
      );
      expect(
        costCommentGaps(source),
        `${name}: stages enabled with no measured cost beside them`,
      ).toEqual([]);
    }
  });

  it("should keep sailing's SSGI and SSR off at every tier", async () => {
    const { qualityPreset } = await load("sailing");
    for (const tier of QUALITY_TIERS) {
      expect(qualityPreset(tier).ssrEnabled, `sailing ${tier}`).toBe(false);
      expect(qualityPreset(tier).ssgiEnabled, `sailing ${tier}`).toBe(false);
    }
  });

  it("should document the tiers and the override in every template's AGENTS.md", async () => {
    const undocumented: string[] = [];
    for (const name of names) {
      const doc = await readFile(path.join(templatesDir, name, "AGENTS.md"), "utf8");
      const documented =
        doc.includes("quality.ts") &&
        QUALITY_TIERS.every((tier) => doc.includes(`\`${tier}\``)) &&
        doc.includes('tier: "low"');
      if (!documented) undocumented.push(name);
    }
    expect(undocumented).toEqual([]);
  });

  it("should list every template directory, not a hard-coded eight", async () => {
    const onDisk = (await readdir(templatesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(onDisk);
  });
});

/**
 * The runtime half of the switch: PRD-362 phase 1.
 *
 * `resolveQualityTier` decides once, at boot, from the platform. That decision cannot see an
 * overloaded desktop GPU, a scene that got expensive, or a phone that is throttling. These
 * exercise the policy that reads completed frame-budget windows and moves the tier, and they are
 * written against the starter because the starter is the template PRD-362 delivers end to end.
 */

/** The window shape the policy reads, in the same field names `IFrameBudgetWindow` uses. */
interface ITestWindow {
  readonly window: number;
  readonly frames: number;
  readonly fps: number;
  readonly presented: { readonly p95: number };
  readonly frame: { readonly p95: number };
  readonly gpuMs?: number;
  readonly gpuAgeFrames?: number;
  readonly gpu?: { readonly samples: number; readonly p50: number };
  readonly surface?: { readonly compiling?: boolean };
}

interface ITestDecision {
  readonly tier: string;
  readonly changed: boolean;
  readonly meter: string;
  readonly reason: string;
  readonly budgetMs: number;
  readonly overloadBudgetMs: number;
  readonly gpuMs?: number;
  readonly cpuMs?: number;
  readonly costMs?: number;
}

interface IAdaptiveQuality {
  readonly tier: string;
  readonly pinned: boolean;
  observe(window: ITestWindow): ITestDecision;
}

interface IAdaptiveModule {
  readonly createAdaptiveQuality: (
    request?: { mobile?: boolean; tier?: string },
    options?: Record<string, unknown>,
  ) => IAdaptiveQuality;
  readonly formatQualityAdaptation: (decision: ITestDecision) => string;
}

async function loadAdaptive(template: string): Promise<IAdaptiveModule> {
  return (await import(
    path.join(templatesDir, template, "src/render/adaptiveQuality.ts")
  )) as IAdaptiveModule;
}

/**
 * A healthy 60 fps window: 16.7 ms between presents, a 5.5 ms frame callback, 8 ms of GPU.
 *
 * The CPU number is deliberately cheap in every window below. PRD-287's motivating measurement is
 * CPU 5.5 ms against GPU 14.7 ms — a frame that misses its budget with the callback idle — so a
 * policy that reads the frame callback would call every one of these windows healthy.
 */
function frameWindow(index: number, overrides: Partial<ITestWindow> = {}): ITestWindow {
  return {
    frame: { p95: 5.5 },
    fps: 60,
    frames: 60,
    gpuMs: 8,
    gpuAgeFrames: 1,
    presented: { p95: 16.7 },
    window: index,
    ...overrides,
  };
}

/** Feeds `count` windows starting at `start`, and returns the last decision. */
function feed(
  policy: IAdaptiveQuality,
  start: number,
  count: number,
  overrides: Partial<ITestWindow> = {},
): ITestDecision {
  let last = policy.observe(frameWindow(start, overrides));
  for (let index = 1; index < count; index += 1) {
    last = policy.observe(frameWindow(start + index, overrides));
  }
  return last;
}

describe("starter adaptive quality", () => {
  /** A clock the test moves by hand, so the cooldown is asserted rather than waited out. */
  function clockAt(start: number): { now: () => number; advance: (ms: number) => void } {
    let value = start;
    return {
      advance: (ms: number) => {
        value += ms;
      },
      now: () => value,
    };
  }

  it("should step down when the GPU is over budget and the CPU frame is cheap", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const clock = clockAt(0);
    const policy = createAdaptiveQuality({ mobile: false }, { now: clock.now, startupWindows: 1 });
    expect(policy.tier).toBe("high");
    // Window 1 is startup and is discarded; 2 and 3 are the two overloaded windows.
    policy.observe(frameWindow(1, { gpuMs: 22 }));
    const first = policy.observe(frameWindow(2, { gpuMs: 22 }));
    expect(first.changed, "one overloaded window is not evidence").toBe(false);
    expect(first.tier).toBe("high");
    const stepped = policy.observe(frameWindow(3, { gpuMs: 22 }));
    expect(stepped.changed).toBe(true);
    expect(stepped.tier).toBe("medium");
    expect(stepped.reason).toBe("overloaded");
    // The finding is the GPU, and it must say so while the CPU frame was under budget.
    expect(stepped.meter).toBe("gpu");
    expect(stepped.costMs).toBe(22);
    expect(stepped.cpuMs).toBe(5.5);
    expect(stepped.budgetMs).toBeCloseTo(1000 / 60, 5);
    expect(stepped.overloadBudgetMs).toBeCloseTo(1000 / 60, 5);
  });

  it("should refuse a second step inside the cooldown", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const clock = clockAt(0);
    const policy = createAdaptiveQuality(
      { mobile: false },
      { cooldownMs: 5000, now: clock.now, startupWindows: 0 },
    );
    expect(feed(policy, 1, 2, { gpuMs: 22 }).tier).toBe("medium");
    clock.advance(1000);
    const held = feed(policy, 3, 2, { gpuMs: 22 });
    expect(held.changed).toBe(false);
    expect(held.reason).toBe("cooldown");
    expect(held.tier).toBe("medium");
    clock.advance(4001);
    const dropped = feed(policy, 5, 2, { gpuMs: 22 });
    expect(dropped.tier).toBe("low");
    expect(dropped.reason).toBe("overloaded");
  });

  it("should need five healthy windows with headroom before stepping back up", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const clock = clockAt(0);
    const policy = createAdaptiveQuality(
      { mobile: true },
      { cooldownMs: 5000, now: clock.now, startupWindows: 0 },
    );
    expect(policy.tier).toBe("low");
    clock.advance(6000);
    // 13.3 ms is exactly the 20% headroom line; 8 ms clears it.
    const four = feed(policy, 1, 4, { gpuMs: 8 });
    expect(four.changed, "four healthy windows are not five").toBe(false);
    const fifth = policy.observe(frameWindow(5, { gpuMs: 8 }));
    expect(fifth.changed).toBe(true);
    expect(fifth.tier).toBe("medium");
    expect(fifth.reason).toBe("headroom");
    // 14 ms is under budget but inside the deadband: healthy enough to stay, not to step up.
    clock.advance(6000);
    const deadband = feed(policy, 6, 6, { gpuMs: 14 });
    expect(deadband.changed).toBe(false);
    expect(deadband.reason).toBe("steady");
    expect(deadband.tier).toBe("medium");
  });

  it("should keep an explicit tier pinned and still observe it", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false, tier: "high" }, { startupWindows: 0 });
    expect(policy.pinned).toBe(true);
    const decision = feed(policy, 1, 6, { gpuMs: 40 });
    expect(decision.tier).toBe("high");
    expect(decision.changed).toBe(false);
    expect(decision.reason).toBe("pinned");
    // Pinned is not silent: the measurement that would have moved an unpinned game is reported.
    expect(decision.meter).toBe("gpu");
    expect(decision.costMs).toBe(40);
  });

  it("should ignore startup, compiling and invalid windows rather than count them", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false }, { startupWindows: 2 });
    expect(policy.observe(frameWindow(1, { gpuMs: 60 })).reason).toBe("startup");
    expect(policy.observe(frameWindow(2, { gpuMs: 60 })).reason).toBe("startup");
    const compiling = policy.observe(frameWindow(3, { gpuMs: 60, surface: { compiling: true } }));
    expect(compiling.reason).toBe("compiling");
    const short = policy.observe(frameWindow(4, { frames: 3, gpuMs: 60 }));
    expect(short.reason).toBe("invalid");
    const broken = policy.observe(frameWindow(5, { fps: Number.NaN, gpuMs: 60 }));
    expect(broken.reason).toBe("invalid");
    // Five overloaded-looking windows, none of them evidence: the tier has not moved.
    expect(policy.tier).toBe("high");
    expect(feed(policy, 6, 2, { gpuMs: 60 }).tier).toBe("medium");
  });

  it("does not let a malformed window identifier block later valid observations", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({}, { startupWindows: 0 });
    expect(policy.observe(frameWindow(Number.POSITIVE_INFINITY, { gpuMs: 40 })).reason).toBe(
      "invalid",
    );
    expect(feed(policy, 1, 2, { gpuMs: 40 }).tier).toBe("medium");
  });

  it("waits for actual readiness and discards the first clean window afterward", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    let ready = false;
    const policy = createAdaptiveQuality({}, { ready: () => ready });
    expect(feed(policy, 1, 10, { gpuMs: 40 }).reason).toBe("startup");
    expect(policy.tier).toBe("high");
    ready = true;
    expect(policy.observe(frameWindow(11, { gpuMs: 40 })).reason).toBe("startup");
    expect(policy.observe(frameWindow(12, { gpuMs: 40 })).changed).toBe(false);
    expect(policy.observe(frameWindow(13, { gpuMs: 40 })).tier).toBe("medium");
  });

  it("rejects fractional window counts and names unobservable GPU timing", async () => {
    const { createAdaptiveQuality, formatQualityAdaptation } = await loadAdaptive("starter");
    expect(() => createAdaptiveQuality({}, { overloadedWindows: 1.5 })).toThrow(
      /overloadedWindows/u,
    );
    const policy = createAdaptiveQuality({}, { startupWindows: 0 });
    const decision = policy.observe(frameWindow(1, { gpuAgeFrames: undefined }));
    expect(decision.meter).toBe("presented");
    expect(formatQualityAdaptation(decision)).toContain("fallback=gpu-age-unavailable");
  });

  it("should keep identical fresh GPU timings and fall back when their frame age becomes stale", async () => {
    const { createAdaptiveQuality, formatQualityAdaptation } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality(
      { mobile: false },
      { maxGpuAgeFrames: 4, startupWindows: 0 },
    );
    // Identical values can be fresh; only the successful query's frame identity proves its age.
    for (let index = 1; index <= 3; index += 1) {
      const fresh = policy.observe(frameWindow(index, { gpuMs: 9.125, gpuAgeFrames: 1 }));
      expect(fresh.meter).toBe("gpu");
    }
    policy.observe(frameWindow(4, { gpuMs: 9.125, gpuAgeFrames: 60, presented: { p95: 33 } }));
    const stale = policy.observe(
      frameWindow(5, { gpuMs: 9.125, gpuAgeFrames: 120, presented: { p95: 33 } }),
    );
    expect(stale.meter).toBe("presented");
    expect(stale.costMs).toBe(33);
    expect(stale.tier).toBe("medium");
    expect(formatQualityAdaptation(stale)).toContain("meter=presented");
  });

  it("should detect overload on presentation timing when no GPU sample exists", async () => {
    const { createAdaptiveQuality, formatQualityAdaptation } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false }, { startupWindows: 0 });
    const overloaded = feed(policy, 1, 2, {
      fps: 30,
      gpuMs: undefined,
      presented: { p95: 33 },
    });
    expect(overloaded.meter).toBe("presented");
    expect(overloaded.tier).toBe("medium");
    expect(overloaded.reason).toBe("overloaded");
    expect(overloaded.overloadBudgetMs).toBeCloseTo((1000 / 60) * 1.05, 5);
    // The limitation is named where a reader will meet it, not left to a code comment alone.
    expect(formatQualityAdaptation(overloaded)).toContain("meter=presented");
    expect(formatQualityAdaptation(overloaded)).toContain("overloadBudgetMs=17.5");
  });

  it("should keep a healthy 60 Hz presentation fallback at high quality", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const clock = clockAt(0);
    const policy = createAdaptiveQuality(
      { mobile: false },
      { now: clock.now, startupWindows: 0, cooldownMs: 5000 },
    );
    const fallback = { gpuMs: undefined, presented: { p95: 16.7 } };
    const firstWindows = feed(policy, 1, 3, fallback);
    expect(firstWindows.meter).toBe("presented");
    expect(firstWindows.tier).toBe("high");
    expect(firstWindows.overloadBudgetMs).toBeCloseTo((1000 / 60) * 1.05, 5);

    clock.advance(6000);
    const laterWindows = feed(policy, 4, 3, fallback);
    expect(laterWindows.tier).toBe("high");
    expect(laterWindows.changed).toBe(false);
  });

  it("should keep high on the completed GPU series when a stale age hides fresh work behind a host gap", async () => {
    const { createAdaptiveQuality, formatQualityAdaptation } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality(
      { mobile: false },
      { maxGpuAgeFrames: 4, startupWindows: 0 },
    );
    const window = {
      frame: { p95: 3.7 },
      gpu: { p50: 16.61, samples: 37 },
      gpuAgeFrames: 10,
      gpuMs: 15.48,
      presented: { p95: 54.7 },
    };
    const decision = feed(policy, 1, 3, window);
    expect(decision.meter).toBe("work");
    expect(decision.costMs).toBeCloseTo(16.61, 5);
    expect(decision.tier).toBe("high");
    expect(decision.reason).toBe("steady");
    expect(formatQualityAdaptation(decision)).toContain("meter=work");
  });

  it("should still downgrade on a stale window whose completed GPU series is over budget", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality(
      { mobile: false },
      { maxGpuAgeFrames: 4, startupWindows: 0 },
    );
    const decision = feed(policy, 1, 2, {
      frame: { p95: 3.7 },
      gpu: { p50: 39, samples: 37 },
      gpuAgeFrames: 10,
      gpuMs: 39,
      presented: { p95: 16.7 },
    });
    expect(decision.meter).toBe("work");
    expect(decision.costMs).toBeCloseTo(39, 5);
    expect(decision.tier).toBe("medium");
    expect(decision.reason).toBe("overloaded");
  });

  it("should downgrade when the completed GPU series is cheap but the own CPU frame is over budget", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality(
      { mobile: false },
      { maxGpuAgeFrames: 4, startupWindows: 0 },
    );
    const decision = feed(policy, 1, 2, {
      frame: { p95: 30 },
      gpu: { p50: 10, samples: 37 },
      gpuAgeFrames: 10,
      gpuMs: 10,
      presented: { p95: 16.7 },
    });
    expect(decision.meter).toBe("work");
    expect(decision.costMs).toBeCloseTo(30, 5);
    expect(decision.tier).toBe("medium");
    expect(decision.reason).toBe("overloaded");
  });

  it("should still step down on a fresh GPU sample above the strict budget", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false }, { startupWindows: 0 });
    const decision = feed(policy, 1, 2, { gpuMs: 17, presented: { p95: 16.7 } });
    expect(decision.tier).toBe("medium");
    expect(decision.reason).toBe("overloaded");
    expect(decision.overloadBudgetMs).toBeCloseTo(1000 / 60, 5);
  });

  it("should allow a strict presentation fallback override", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality(
      { mobile: false },
      { presentationTolerance: 0, startupWindows: 0 },
    );
    const decision = feed(policy, 1, 2, { gpuMs: undefined, presented: { p95: 16.7 } });
    expect(decision.tier).toBe("medium");
    expect(decision.overloadBudgetMs).toBeCloseTo(1000 / 60, 5);
  });

  it("should keep quality reports safe for JSON recorders", async () => {
    const { createAdaptiveQuality, formatQualityAdaptation } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({}, { startupWindows: 0 });
    const fresh = policy.observe(frameWindow(1, { gpuMs: 9, gpuAgeFrames: 1 }));
    const absent = policy.observe(frameWindow(2, { gpuMs: undefined }));
    const invalid = policy.observe(
      frameWindow(3, {
        gpuMs: Number.NaN,
        frame: { p95: Number.NaN },
        presented: { p95: Number.POSITIVE_INFINITY },
      }),
    );

    for (const report of [fresh, absent, invalid]) {
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    }
    expect(Object.hasOwn(fresh, "fallback")).toBe(false);
    expect(Object.hasOwn(absent, "gpuMs")).toBe(false);
    expect(Object.hasOwn(invalid, "gpuMs")).toBe(false);
    expect(Object.hasOwn(invalid, "cpuMs")).toBe(false);
    expect(Object.hasOwn(invalid, "costMs")).toBe(false);
    expect(formatQualityAdaptation(invalid)).toContain("costMs=unavailable");
  });

  it("should report at-floor rather than stepping below the cheapest tier", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ tier: undefined, mobile: true }, { startupWindows: 0 });
    const floored = feed(policy, 1, 4, { gpuMs: 40 });
    expect(floored.tier).toBe("low");
    expect(floored.changed).toBe(false);
    expect(floored.reason).toBe("at-floor");
  });

  it("should not move on alternating overloaded and healthy windows", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false }, { startupWindows: 0 });
    let last = policy.observe(frameWindow(1, { gpuMs: 22 }));
    for (let index = 2; index <= 12; index += 1) {
      last = policy.observe(frameWindow(index, { gpuMs: index % 2 === 0 ? 8 : 22 }));
    }
    expect(last.tier).toBe("high");
    expect(last.changed).toBe(false);
  });

  it("should throw on a target frame rate that cannot produce a budget", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    expect(() => createAdaptiveQuality({}, { targetFps: 0 })).toThrow(/targetFps/u);
    expect(() => createAdaptiveQuality({}, { headroom: 1.5 })).toThrow(/headroom/u);
    expect(() => createAdaptiveQuality({}, { presentationTolerance: -0.1 })).toThrow(
      /presentationTolerance/u,
    );
    expect(() => createAdaptiveQuality({}, { presentationTolerance: Number.NaN })).toThrow(
      /presentationTolerance/u,
    );
    expect(() => createAdaptiveQuality({}, { presentationTolerance: 1 })).toThrow(
      /presentationTolerance/u,
    );
  });

  it("should derive the budget from the configured frame rate", async () => {
    const { createAdaptiveQuality } = await loadAdaptive("starter");
    const policy = createAdaptiveQuality({ mobile: false }, { startupWindows: 0, targetFps: 30 });
    // 22 ms of GPU is an overload at 60 fps and comfortable at 30.
    const decision = feed(policy, 1, 6, { fps: 30, gpuMs: 22, presented: { p95: 33 } });
    expect(decision.budgetMs).toBeCloseTo(1000 / 30, 5);
    expect(decision.tier).toBe("high");
  });
});

describe("starter postprocessing lifecycle", () => {
  it("replaces GPU and fallback observations without retaining stale optional fields", async () => {
    const post = await import("../templates/starter/src/render/postprocessing.js");
    const controller = post.setupPost(
      {
        kind: "webgpu",
        raw: {},
        createRenderChain: () => ({ applied: { stages: [], dropped: [] }, dispose() {} }),
      },
      new Scene(),
      new PerspectiveCamera(),
      { mobile: false, startupWindows: 0 },
    );

    post.observeQualityWindow(frameWindow(1, { gpuMs: undefined }));
    const absent = controller.debug();
    expect(absent).toMatchObject({ fallback: "gpu-unavailable", meter: "presented", window: 1 });
    expect(Object.hasOwn(absent, "gpuMs")).toBe(false);
    // No temporal provider is installed, so the key must be absent: `undefined` is not JSON-safe and
    // the playtest bridge rejects the whole quality component with it.
    expect(Object.hasOwn(absent, "temporal")).toBe(false);

    post.observeQualityWindow(frameWindow(2, { gpuMs: 8 }));
    const fresh = controller.debug();
    expect(fresh).toMatchObject({ gpuMs: 8, meter: "gpu", window: 2 });
    expect(Object.hasOwn(fresh, "fallback")).toBe(false);

    post.observeQualityWindow(frameWindow(3, { gpuMs: undefined }));
    const missing = controller.debug();
    expect(missing).toMatchObject({ fallback: "gpu-unavailable", meter: "presented", window: 3 });
    expect(Object.hasOwn(missing, "gpuMs")).toBe(false);
    controller.dispose();
  });

  it("reports the engine's live temporal state while the chain's own temporal AA runs", async () => {
    // No shipped tier anti-aliases temporally since core's sharp AA (4x MSAA, owner 2026-10-28), so `high` opts into
    // the named `temporalAA: true` override here, which is how a kit turns the engine's traa stage back on.
    const qualityPath = "../templates/starter/src/render/quality.js";
    vi.resetModules();
    vi.doMock(qualityPath, async () => {
      const actual =
        await vi.importActual<typeof import("../templates/starter/src/render/quality.js")>(
          qualityPath,
        );
      return {
        ...actual,
        qualityPreset: (tier: string) => ({
          ...actual.qualityPreset(tier),
          ...(tier === "high" ? { temporalAA: true } : {}),
        }),
      };
    });
    const post = await import("../templates/starter/src/render/postprocessing.js");
    const temporal = { active: true, frame: 7, historyValid: true, jitter: [0.25, -0.25] };
    const owned = {
      kind: "webgpu",
      raw: { info: { engine: { samples: 1, temporal } } },
      createRenderChain: () => ({ applied: { stages: [], dropped: [] }, dispose() {} }),
    } as Parameters<typeof post.setupPost>[0];
    // `high` anti-aliases temporally, so the report is the engine's own, named for the method.
    const high = post.setupPost(owned, new Scene(), new PerspectiveCamera(), {
      mobile: false,
      startupWindows: 0,
      tier: "high",
    });
    expect(high.debug().temporal).toEqual({ method: "traa", ...temporal });
    high.dispose();
    // `low` keeps SMAA, so there is no temporal state to report and the key stays absent.
    const low = post.setupPost(owned, new Scene(), new PerspectiveCamera(), {
      mobile: false,
      startupWindows: 0,
      tier: "low",
    });
    expect(Object.hasOwn(low.debug(), "temporal")).toBe(false);
    low.dispose();
    vi.doUnmock(qualityPath);
    vi.resetModules();
  });

  it("replaces only changed graphs and stops consuming windows after scene disposal", async () => {
    const post = await import("../templates/starter/src/render/postprocessing.js");
    const built: string[] = [];
    let live = 0;
    let disposed = 0;
    let disposedPasses = 0;
    const renderer = {
      kind: "webgpu",
      raw: {},
      createRenderChain(options: {
        request?: { tier?: string; stages?: readonly string[] };
        worldPass?: unknown;
      }) {
        const worldPass = options.worldPass as { dispose(): void } | undefined;
        if (worldPass !== undefined) {
          const disposePass = worldPass.dispose.bind(worldPass);
          worldPass.dispose = () => {
            disposedPasses += 1;
            disposePass();
          };
        }
        built.push(options.request?.tier ?? "missing");
        live += 1;
        let dead = false;
        return {
          applied: { dropped: [], stages: options.request?.stages ?? [] },
          dispose() {
            if (dead) return;
            dead = true;
            live -= 1;
            disposed += 1;
          },
        };
      },
    };
    let time = 0;
    const controller = post.setupPost(renderer, new Scene(), new PerspectiveCamera(), {
      mobile: false,
      targetFps: 60,
      startupWindows: 0,
      now: () => time,
    });
    expect(built).toEqual(["high"]);
    post.observeQualityWindow(frameWindow(1, { gpuMs: 22 }));
    expect(built).toEqual(["high"]);
    post.observeQualityWindow(frameWindow(2, { gpuMs: 22 }));
    expect(built).toEqual(["high", "medium"]);
    expect(live).toBe(1);
    expect(disposed).toBe(1);
    expect(disposedPasses).toBe(1);
    time = 6000;
    post.observeQualityWindow(frameWindow(3, { gpuMs: 22 }));
    post.observeQualityWindow(frameWindow(4, { gpuMs: 22 }));
    expect(built).toEqual(["high", "medium", "low"]);
    expect(live).toBe(1);
    controller.dispose();
    expect(live).toBe(0);
    time = 12000;
    for (let index = 5; index <= 12; index += 1) post.observeQualityWindow(frameWindow(index));
    expect(built).toHaveLength(3);
  });
});
