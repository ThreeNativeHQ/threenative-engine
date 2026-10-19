import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { allTemplates } from "../../test-support/templates.js";
import {
  ALREADY_BOOTED_TEMPLATES,
  TEMPLATE_PLAYTEST_NAMES,
  assertTemplatePlaytestsPassed,
  auditTemplatePlaytests,
  runTemplatePlaytests,
  verifyTemplatePlaytests,
} from "../verify-template-playtests.js";

async function writeScenario(
  root: string,
  template: string,
  name: string,
  scenario: Record<string, unknown>,
): Promise<void> {
  const directory = path.join(root, template, "playtests");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${name}.playtest.json`),
    JSON.stringify({ name, schemaVersion: 1, ...scenario }),
  );
}

describe("template playtest matrix", () => {
  it("selects every template outside the existing golden-path boot matrix", () => {
    // Derived from disk, not listed here. This assertion named six templates and went red the day
    // `puzzle` and `runner` shipped — while the code under test was already reading the directory
    // and was therefore correct. A kit is covered the day it ships a directory, and a hardcoded
    // list here only ever records how many kits existed when someone last edited it.
    expect(TEMPLATE_PLAYTEST_NAMES).toEqual(
      allTemplates().filter((name) => !ALREADY_BOOTED_TEMPLATES.has(name)),
    );
    // ...and the split is real: neither side is empty, so a discovery that silently returned
    // nothing cannot pass this.
    expect(TEMPLATE_PLAYTEST_NAMES.length).toBeGreaterThan(0);
    expect(ALREADY_BOOTED_TEMPLATES.size).toBeGreaterThan(0);
  });

  it("reports every template and continues after a failing template", async () => {
    const root = await makeTempDir("threenative-template-matrix-");
    const calls: string[] = [];
    let alphaRuns = 0;
    try {
      const results = await runTemplatePlaytests(
        ["alpha", "beta"],
        root,
        { "create-threenative": "/tmp/create-threenative.tgz" },
        {
          createProject: async ({ target, template }) => {
            const selectedTemplate = template ?? "unknown";
            calls.push(`scaffold:${selectedTemplate}`);
            await mkdir(target, { recursive: true });
            return { installed: true, target, template: selectedTemplate };
          },
          run: async (_command, _args, cwd) => {
            const template = path.basename(cwd);
            calls.push(`test:${template}`);
            if (template === "alpha" && alphaRuns++ === 0) throw new Error("alpha test failed");
          },
        },
      );

      expect(results).toEqual([
        { error: "alpha test failed", pass: false, template: "alpha" },
        { pass: true, template: "beta" },
      ]);
      expect(calls).toEqual([
        "scaffold:alpha",
        "test:alpha",
        "test:alpha",
        "scaffold:beta",
        "test:beta",
        "test:beta",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs Sailing's live-clock render-motion scenario after its boot smoke", async () => {
    const root = await makeTempDir("threenative-sailing-motion-qualification-");
    const extras = await makeTempDir("threenative-sailing-motion-extras-");
    const invocations: string[][] = [];
    try {
      await runTemplatePlaytests(
        ["sailing"],
        root,
        { "create-threenative": "/tmp/create-threenative.tgz" },
        {
          templatePlaytestRoot: extras,
          createProject: async ({ target, template }) => {
            await mkdir(target, { recursive: true });
            return { installed: true, target, template: template ?? "unknown" };
          },
          run: async (_command, args) => {
            invocations.push([...args]);
          },
        },
      );

      expect(invocations[0]).toEqual(["test"]);
      expect(invocations[1]).toContain(".threenative-template-boot.playtest.json");
      expect(invocations[2]).toEqual([
        "exec",
        "threenative-playtest",
        "--scenario",
        "playtests/live/render-motion.playtest.json",
        "--live-clock",
        "--browser-recipe",
        "webgpu",
        "--headed",
        "--server-command",
        "pnpm dev --host 127.0.0.1 --port $PORT --strictPort",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(extras, { force: true, recursive: true });
    }
  });

  it("fails release qualification when Sailing motion fails and still runs later templates", async () => {
    const root = await makeTempDir("threenative-sailing-motion-failure-");
    const extras = await makeTempDir("threenative-sailing-motion-failure-extras-");
    const invocations: string[] = [];
    try {
      const results = await runTemplatePlaytests(
        ["sailing", "alpha"],
        root,
        { "create-threenative": "/tmp/create-threenative.tgz" },
        {
          templatePlaytestRoot: extras,
          createProject: async ({ target, template }) => {
            await mkdir(target, { recursive: true });
            return { installed: true, target, template: template ?? "unknown" };
          },
          run: async (_command, args, cwd) => {
            const template = path.basename(cwd);
            const invocation = args.includes("playtests/live/render-motion.playtest.json")
              ? "motion"
              : args.includes(".threenative-template-boot.playtest.json")
                ? "boot"
                : "test";
            invocations.push(`${template}:${invocation}`);
            if (template === "sailing" && invocation === "motion") {
              throw new Error("render-motion failed");
            }
          },
        },
      );

      expect(results).toEqual([
        { error: "render-motion failed", pass: false, template: "sailing" },
        { pass: true, template: "alpha" },
      ]);
      expect(invocations).toEqual([
        "sailing:test",
        "sailing:boot",
        "sailing:motion",
        "alpha:test",
        "alpha:boot",
      ]);
      expect(() => assertTemplatePlaytestsPassed(results)).toThrow(
        "TN_TEMPLATE_PLAYTESTS_FAILED: sailing: render-motion failed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(extras, { force: true, recursive: true });
    }
  });

  it("copies a template's engine-only guards in before pnpm test runs", async () => {
    const root = await makeTempDir("threenative-template-extras-");
    const extras = await makeTempDir("threenative-template-extras-source-");
    const seen: string[][] = [];
    try {
      // A starter scaffold ships three scenarios; the other 21 are the engine's own regression
      // guards and live outside the template. The sweep still has to run all of them, so they
      // land in `<target>/playtests/` before the glob in the template's `test` script is read.
      await mkdir(path.join(extras, "alpha"), { recursive: true });
      await writeFile(
        path.join(extras, "alpha", "coyote.playtest.json"),
        JSON.stringify({ name: "coyote", schemaVersion: 1 }),
      );
      await writeFile(path.join(extras, "alpha", "models-baseline.png"), "png");

      await runTemplatePlaytests(
        ["alpha"],
        root,
        { "create-threenative": "/tmp/create-threenative.tgz" },
        {
          templatePlaytestRoot: extras,
          createProject: async ({ target }) => {
            await mkdir(path.join(target, "playtests"), { recursive: true });
            await writeFile(path.join(target, "playtests", "survives.playtest.json"), "{}");
            return { installed: true, target, template: "alpha" };
          },
          run: async (_command, args, cwd) => {
            if (args[0] !== "test") return;
            expect((await readdir(path.join(cwd, "playtests"))).sort()).toEqual([
              "coyote.playtest.json",
              "models-baseline.png",
              "survives.playtest.json",
            ]);
            seen.push([...args]);
          },
        },
      );

      expect(seen).toEqual([["test"]]);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(extras, { force: true, recursive: true });
    }
  });

  it("does not count schema-invalid setup.scene as an explicit play-state entry", async () => {
    const root = await makeTempDir("threenative-template-audit-");
    try {
      await writeScenario(root, "alpha", "assumes-play", {
        steps: [{ kind: "wait", waitTicks: 1 }],
      });
      await writeScenario(root, "alpha", "enters-play", {
        steps: [{ kind: "input", label: "start-game", press: "Enter" }],
      });
      await mkdir(path.join(root, "alpha", "native-playtests"), { recursive: true });
      await writeFile(
        path.join(root, "alpha", "native-playtests", "touch.playtest.json"),
        JSON.stringify({ name: "touch", schemaVersion: 1, target: "android", steps: [] }),
      );
      await writeScenario(root, "beta", "declares-scene", {
        setup: { scene: "play" },
        steps: [{ kind: "wait", waitTicks: 1 }],
      });

      await expect(auditTemplatePlaytests(root, ["alpha", "beta"])).resolves.toEqual([
        { assumesStartInPlay: 2, explicitStart: 1, scenarioCount: 3, template: "alpha" },
        { assumesStartInPlay: 1, explicitStart: 0, scenarioCount: 1, template: "beta" },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails once after all template results have been reported", () => {
    expect(() =>
      assertTemplatePlaytestsPassed([
        { error: "alpha test failed", pass: false, template: "alpha" },
        { pass: true, template: "beta" },
      ]),
    ).toThrow("TN_TEMPLATE_PLAYTESTS_FAILED: alpha: alpha test failed");
  });

  it("reports an audit failure after every template still runs", async () => {
    const root = await makeTempDir("threenative-template-audit-matrix-");
    const calls: string[] = [];
    try {
      const malformedDirectory = path.join(root, "alpha", "playtests");
      await mkdir(malformedDirectory, { recursive: true });
      await writeFile(
        path.join(malformedDirectory, "malformed.playtest.json"),
        "{ malformed scenario",
      );
      await writeScenario(root, "beta", "valid", {
        steps: [{ kind: "wait", waitTicks: 1 }],
      });

      await expect(
        verifyTemplatePlaytests(
          ["alpha", "beta"],
          root,
          { "create-threenative": "/tmp/create-threenative.tgz" },
          {
            auditRoot: root,
            createProject: async ({ target, template }) => {
              const selectedTemplate = template ?? "unknown";
              calls.push(`scaffold:${selectedTemplate}`);
              await mkdir(target, { recursive: true });
              return { installed: true, target, template: selectedTemplate };
            },
            run: async (_command, _args, cwd) => {
              calls.push(`test:${path.basename(cwd)}`);
            },
          },
        ),
      ).rejects.toThrow("TN_TEMPLATE_PLAYTESTS_FAILED: alpha: TN_TEMPLATE_PLAYTEST_AUDIT_INVALID");
      expect(calls).toEqual([
        "scaffold:alpha",
        "test:alpha",
        "test:alpha",
        "scaffold:beta",
        "test:beta",
        "test:beta",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports a structural failure and still executes every template", async () => {
    const root = await makeTempDir("threenative-template-structure-matrix-");
    const calls: string[] = [];
    try {
      const dependencies = {
        auditRoot: root,
        inspectTemplates: () => [
          {
            errors: ["alpha: missing src/render/sky.ts"],
            files: [],
            template: "alpha",
          },
          { errors: [], files: [], template: "beta" },
        ],
        createProject: async ({ target, template }: { target: string; template?: string }) => {
          const selectedTemplate = template ?? "unknown";
          calls.push(`scaffold:${selectedTemplate}`);
          await mkdir(target, { recursive: true });
          return { installed: true, target, template: selectedTemplate };
        },
        run: async (_command: string, _args: readonly string[], cwd: string) => {
          calls.push(`test:${path.basename(cwd)}`);
        },
      };

      await expect(
        verifyTemplatePlaytests(
          ["alpha", "beta"],
          root,
          { "create-threenative": "/tmp/create-threenative.tgz" },
          dependencies,
        ),
      ).rejects.toThrow(
        "TN_TEMPLATE_PLAYTESTS_FAILED: alpha: TN_VISUAL_STRUCTURE_FAILED:\nalpha: missing src/render/sky.ts",
      );
      expect(calls).toEqual([
        "scaffold:alpha",
        "test:alpha",
        "test:alpha",
        "scaffold:beta",
        "test:beta",
        "test:beta",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
