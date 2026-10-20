import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every Vite plugin a template imports must actually be in its `plugins` array.
 *
 * `react()` and `tailwindcss()` were dropped from all six React templates by a commit that meant
 * to remove a third plugin from the same line. Nothing failed: the imports stayed, so the file
 * still type-checked, Vite still built, and `@import "tailwindcss"` still produced a stylesheet —
 * the theme and preflight, with an empty `@layer utilities`. Every class name in `src/ui/` became
 * an inert string. The scaffolded HUD rendered unstyled on web, desktop and Android alike for as
 * long as that stood, and the only symptom was a screenshot nobody diffed.
 *
 * An unused import is the signature of the mistake, so that is what this checks.
 */
const TEMPLATE_ROOT = path.resolve("packages/create-threenative/templates");

/** Plugin factories, by the identifier a template imports them under. */
const PLUGIN_IMPORT = /^import\s+(\w+)\s+from\s+"(@tailwindcss\/vite|@vitejs\/plugin-react)";$/gm;

const templates = async (): Promise<readonly string[]> =>
  (await readdir(TEMPLATE_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe("template vite configs", () => {
  it("wires every plugin the template imports", async () => {
    const unwired: string[] = [];
    for (const template of await templates()) {
      const file = path.join(TEMPLATE_ROOT, template, "vite.config.ts");
      const source = await readFile(file, "utf8").catch(() => null);
      if (source === null) continue;
      const plugins = /plugins:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "";
      for (const [, identifier] of source.matchAll(PLUGIN_IMPORT)) {
        if (!plugins.includes(`${identifier}(`)) unwired.push(`${template}: ${identifier}`);
      }
    }
    expect(unwired).toEqual([]);
  });

  it("gives every template with a React UI both the React and Tailwind plugins", async () => {
    const missing: string[] = [];
    for (const template of await templates()) {
      const hasReactUi = await readdir(path.join(TEMPLATE_ROOT, template, "src", "ui"))
        .then((entries) => entries.some((entry) => entry.endsWith(".tsx")))
        .catch(() => false);
      if (!hasReactUi) continue;
      const source = await readFile(path.join(TEMPLATE_ROOT, template, "vite.config.ts"), "utf8");
      const plugins = /plugins:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? "";
      // Named rather than inferred: a React UI that Tailwind never scanned still builds, and
      // ships a stylesheet with no utilities in it.
      if (!plugins.includes("react(")) missing.push(`${template}: react()`);
      if (!plugins.includes("tailwindcss(")) missing.push(`${template}: tailwindcss()`);
    }
    expect(missing).toEqual([]);
  });

  it("guards every template's dev server with the engine freshness plugin", async () => {
    // Sandbox games install the engine from a tarball whose filename never changes, and a dev
    // server booted before a reinstall serves the old build from memory — reported 2026-08-27
    // as a regression of a fix that had already landed. Every template wires the guard, so the
    // generated project's agent sees the stale build called out at boot instead of debugging
    // yesterday's engine.
    const unwired: string[] = [];
    for (const template of await templates()) {
      const source = await readFile(path.join(TEMPLATE_ROOT, template, "vite.config.ts"), "utf8");
      if (!source.includes("createEngineFreshnessPlugin("))
        unwired.push(`${template}: createEngineFreshnessPlugin()`);
    }
    expect(unwired).toEqual([]);
  });

  it("holds every dev server that cooks assets until the first cook settles", async () => {
    // A fresh scaffold's `public/` holds only the icon and favicon, so until the dev pipeline
    // cooks `assets/` into it every request answers from the source fallback and
    // `/assets.manifest.json` 404s. The cook is ~19 s on a cold project, and Vite was ready in
    // 431 ms, so the page loaded inside the cook window and the `via` marker read "source" for
    // every resource — a manifest assertion failing on a boot race, reported 2026-10-01 on
    // template-nonvisual (starter 1/3) with every other assertion in the scenario green.
    const ungated: string[] = [];
    for (const root of [TEMPLATE_ROOT, path.resolve("examples")]) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root, entry.name, "vite.config.ts");
        const source = await readFile(file, "utf8").catch(() => null);
        if (source === null || !source.includes("watchAssets(")) continue;
        const gated =
          /async configureServer\(server\)/.test(source) && source.includes("await handle.ready");
        if (!gated) ungated.push(path.relative(process.cwd(), file));
      }
    }
    expect(ungated).toEqual([]);
  });

  it("passes the project asset config to every dev asset watcher", async () => {
    const unconfigured: string[] = [];
    for (const template of await templates()) {
      const source = await readFile(path.join(TEMPLATE_ROOT, template, "vite.config.ts"), "utf8");
      if (!source.includes('import config from "./threenative.config.js";')) {
        unconfigured.push(`${template}: config import`);
      }
      if (!/watchAssets\(\{\s*config:\s*config\.assets,/.test(source)) {
        unconfigured.push(`${template}: watch config`);
      }
    }
    expect(unconfigured).toEqual([]);
  });
});

describe("template stylesheets", () => {
  it("never paints a background on body, in a stylesheet the UI layer imports", async () => {
    const painted: string[] = [];
    for (const template of await templates()) {
      const stylesheet = path.join(TEMPLATE_ROOT, template, "src", "style.css");
      const source = await readFile(stylesheet, "utf8").catch(() => null);
      if (source === null) continue;
      const uiEntry = path.join(TEMPLATE_ROOT, template, "src", "ui", "main.tsx");
      const ui = await readFile(uiEntry, "utf8").catch(() => null);
      if (ui === null || !ui.includes("style.css")) continue;
      // `src/ui/main.tsx` is what the platform's transparent web view loads over the game. A
      // `body` background in a stylesheet it imports is an opaque sheet over the rendered frame —
      // and it stayed invisible for as long as `@theme` went unprocessed and left the custom
      // property undefined, so the first thing that fixed Tailwind blacked out every native game.
      const body = /^body \{([^}]*)\}/m.exec(source)?.[1] ?? "";
      if (/(^|[\s;])background(-color)?\s*:/.test(body)) painted.push(template);
    }
    expect(painted).toEqual([]);
  });
});

describe("template dependencies", () => {
  it("gives every template on Vite 8 its own esbuild", async () => {
    const missing: string[] = [];
    for (const template of await templates()) {
      const manifest = await readFile(
        path.join(TEMPLATE_ROOT, template, "package.json"),
        "utf8",
      ).catch(() => null);
      if (manifest === null) continue;
      const parsed = JSON.parse(manifest) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const all = { ...parsed.dependencies, ...parsed.devDependencies };
      // Vite 8 builds with rolldown and no longer carries esbuild, which is what the framework's
      // TypeScript config loader transpiles `threenative.config.ts` with. Three templates shipped
      // without it: their scaffolds could not load their own config at all, and said so as a
      // missing transpiler, which reads like a broken install rather than a missing dependency.
      if (all.vite === undefined) continue;
      if (all.esbuild === undefined) missing.push(template);
    }
    expect(missing).toEqual([]);
  });
});
