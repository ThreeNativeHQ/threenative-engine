// The two build-plumbing files every kit held a copy of, generated from one source plus the kit's
// own delta. `vite.config.ts` is still per kit (its plugin list and worker entry differ); this module
// owns `tsconfig.json` first, because it is the file whose copies disagree for no reason at all.
//
// The delta is derived, not listed: whether a kit ships React is whether its manifest depends on it.
// A kit without React needs neither `jsx` nor the `.tsx` glob, and one that gains React needs both —
// editing package.json is then enough, with no second list to remember.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** What a kit's `tsconfig.json` depends on. */
export interface IPlumbingDelta {
  /** Whether the kit ships React: its manifest depends on it. */
  readonly react: boolean;
}

/** The options both variants share, in the order the file lists them. */
const COMPILER_OPTIONS = [
  ['"target"', '"ES2022"'],
  ['"lib"', '["ES2022", "DOM", "DOM.Iterable"]'],
  ['"module"', '"ESNext"'],
  ['"moduleResolution"', '"bundler"'],
] as const;

/**
 * The `tsconfig.json` a kit ships.
 *
 * A `tests` glob is in every kit even where no `tests/` directory exists yet: a glob that matches
 * nothing costs nothing, and seven kits carried a variant without it for no recorded reason.
 */
export function tsconfigText(delta: IPlumbingDelta): string {
  const compiler = [
    ...COMPILER_OPTIONS.map(([name, value]) => `    ${name}: ${value},`),
    ...(delta.react ? ['    "jsx": "react-jsx",'] : []),
    '    "types": ["vite/client"],',
    '    "strict": true,',
    '    "noUncheckedIndexedAccess": true,',
    '    "noEmit": true,',
    '    "skipLibCheck": true,',
    '    "verbatimModuleSyntax": true,',
    '    "isolatedModules": true',
    "  },",
  ];
  const include = delta.react
    ? '  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "*.ts"]'
    : '  "include": ["src/**/*.ts", "tests/**/*.ts", "*.ts"]';
  return `${["{", '  "compilerOptions": {', ...compiler, include, "}", ""].join("\n")}`;
}

/** The delta a kit's own manifest declares: React is a dependency, not a flag somebody maintains. */
export function kitPlumbingDelta(kit: string, root: string): IPlumbingDelta {
  const manifest = JSON.parse(readFileSync(path.join(root, kit, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const react = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
    (block) => block?.react !== undefined,
  );
  return { react };
}

/** The width `biome.json` formats to: the generator wraps an array the same way it would. */
const FORMAT_WIDTH = 100;

/** What a kit's `vite.config.ts` depends on, each derived from the kit itself. */
export interface IVitePlumbingDelta extends IPlumbingDelta {
  /** Whether the kit depends on `@tailwindcss/vite`. */
  readonly tailwind: boolean;
  /** Whether the kit ships a second HTML entry, `main.html`, that runs the game on the page thread. */
  readonly workerEntry: boolean;
}

/**
 * The `vite.config.ts` a kit ships.
 *
 * Three things vary, and each is read from the kit rather than listed: React and Tailwind are
 * dependencies of its manifest, and the second entry exists when `main.html` does. Everything else —
 * the freshness probe, the brand plugin, the asset watch that compiles `assets/` into `public/`, the
 * server's polling watch — is the same in all sixteen and belongs in one place.
 */
export function viteConfigText(delta: IVitePlumbingDelta): string {
  const imports = [
    ...(delta.tailwind ? ['import tailwindcss from "@tailwindcss/vite";'] : []),
    'import { watchAssets } from "@threenative/assets";',
    ...(delta.react ? ['import react from "@vitejs/plugin-react";'] : []),
    "import {",
    // PRD-829's catalog plugin: every kit serves the engine catalog in dev, so it is plumbing.
    "  createEngineCatalogPlugin,",
    "  createEngineFreshnessPlugin,",
    "  createWebBrandPlugin,",
    "  webRuntimeDecoders,",
    '} from "create-threenative";',
    'import { defineConfig } from "vite";',
    'import type { Plugin } from "vite";',
    'import config from "./threenative.config.js";',
  ];
  const pluginNames = [
    "createEngineFreshnessPlugin()",
    "createWebBrandPlugin()",
    "createEngineCatalogPlugin()",
    ...(delta.react ? ["react()"] : []),
    ...(delta.tailwind ? ["tailwindcss()"] : []),
    "assetsWatchPlugin()",
  ];
  // The formatter keeps the array on one line while it fits and wraps it after that, so the
  // generator has to do the same or `stamp --check` and `biome format` would disagree forever.
  const inline = `  plugins: [${pluginNames.join(", ")}],`;
  const plugins =
    inline.length <= FORMAT_WIDTH
      ? [inline]
      : ["  plugins: [", ...pluginNames.map((name) => `    ${name},`), "  ],"];
  const build = delta.workerEntry
    ? [
        "  // `index.html` runs the game in a worker (the default); `main.html` runs it on the page thread.",
        '  build: { rollupOptions: { input: { index: "index.html", main: "main.html" } } },',
      ]
    : [];
  return `${[
    ...imports,
    "",
    "/**",
    " * Recompiles assets/ into public/ while the dev server runs, so editing a texture does not",
    " * need a rebuild. Serve-only by declaration: builds compile through `threenative build`.",
    " */",
    "function assetsWatchPlugin(): Plugin {",
    "  return {",
    '    name: "threenative-assets-watch",',
    '    apply: "serve",',
    "    async configureServer(server) {",
    "      const handle = watchAssets({",
    "        config: config.assets,",
    "        cwd: server.config.root,",
    "        runtimeDecoders: webRuntimeDecoders(config),",
    "      });",
    '      server.httpServer?.once("close", () => handle.close());',
    "      // Nothing is served before the first cook settles: until it does, `public/` has no",
    "      // `assets.manifest.json` and every asset answers from its source fallback.",
    "      await handle.ready;",
    "    },",
    "  };",
    "}",
    "",
    "export default defineConfig({",
    ...plugins,
    ...build,
    "  server: {",
    "    watch: {",
    '      ignored: ["**/artifacts/**", "**/screenshots/**", "**/playtests/**"],',
    "      usePolling: true,",
    "    },",
    "  },",
    "});",
    "",
  ].join("\n")}`;
}

/** The Vite delta a kit declares: React and Tailwind by dependency, the second entry by `main.html`. */
export function kitViteDelta(kit: string, root: string): IVitePlumbingDelta {
  const manifest = JSON.parse(readFileSync(path.join(root, kit, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependsOn = (name: string): boolean =>
    manifest.dependencies?.[name] !== undefined || manifest.devDependencies?.[name] !== undefined;
  return {
    react: kitPlumbingDelta(kit, root).react,
    tailwind: dependsOn("@tailwindcss/vite"),
    workerEntry: existsSync(path.join(root, kit, "main.html")),
  };
}

/** The `src/main.ts` variants: a game that mounts React, and one that mounts the canvas itself. */
export interface IMainPlumbingDelta extends IPlumbingDelta {
  /**
   * A kit whose entry carries a statement of its own (a key binding, a pre-mount hook) keeps its
   * file: a restamp that cannot express that statement must not overwrite it.
   */
  readonly handWritten: boolean;
}

/**
 * The `src/main.ts` a kit ships, or `undefined` when the kit keeps its own.
 *
 * The React variant mounts the game's `App` through `#root` and keeps the root across hot updates;
 * the plain one mounts the canvas itself and turns a failed start into a visible, labelled failure
 * element rather than an empty page.
 */
export function mainText(delta: IMainPlumbingDelta): string | undefined {
  if (delta.handWritten) return undefined;
  const hot = ["import.meta.hot?.accept();", "acceptHotUpdate(game, import.meta.hot);"];
  if (delta.react) {
    return `${[
      'import { acceptHotUpdate } from "@threenative/core/hot";',
      'import { createElement } from "react";',
      'import { createRoot } from "react-dom/client";',
      'import game from "./game.js";',
      'import { App } from "./ui/App.js";',
      'import "./style.css";',
      "",
      ...hot,
      'const root = document.getElementById("root");',
      'if (root === null) throw new Error("Missing #root element.");',
      "const appRoot = root as typeof root & { __threenativeRoot?: ReturnType<typeof createRoot> };",
      "const reactRoot = appRoot.__threenativeRoot ?? createRoot(appRoot);",
      "appRoot.__threenativeRoot = reactRoot;",
      "reactRoot.render(createElement(App, { game }));",
      "",
    ].join("\n")}`;
  }
  return `${[
    'import { acceptHotUpdate } from "@threenative/core/hot";',
    'import game from "./game.js";',
    'import "./style.css";',
    "",
    'const app = document.querySelector<HTMLElement>("#app");',
    'if (app === null) throw new Error("Missing #app element.");',
    "",
    "// No DOM readout here: the first frame is the scene alone. A HUD you add belongs in one layer —",
    "// drawn in the scene so it survives on native, never a DOM copy of the same numbers on top of it.",
    "",
    ...hot,
    "void game",
    "  .start()",
    "  .then(() => {",
    "    const canvas = game.ctx?.renderer.domElement;",
    "    if (canvas !== undefined) app.prepend(canvas);",
    "  })",
    "  .catch((error: unknown) => {",
    '    const failure = document.createElement("div");',
    '    failure.id = "threenative-canvas-error";',
    '    failure.dataset.threenativeCanvasError = "true";',
    '    failure.setAttribute("role", "alert");',
    "    failure.textContent = error instanceof Error ? error.message : String(error);",
    "    app.replaceChildren(failure);",
    "  });",
    "",
  ].join("\n")}`;
}

/** The main delta a kit declares. Only `adventure` sets `handWritten`, with its reason in kit.json. */
export function kitMainDelta(kit: string, root: string): IMainPlumbingDelta {
  const manifest = JSON.parse(readFileSync(path.join(root, kit, "kit.json"), "utf8")) as {
    scaffold?: { mainHandWritten?: boolean };
  };
  return {
    handWritten: manifest.scaffold?.mainHandWritten === true,
    react: kitPlumbingDelta(kit, root).react,
  };
}
