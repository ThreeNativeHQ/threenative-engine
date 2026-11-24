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

/** What a kit's `vite.config.ts` depends on, each derived from the kit itself. */
export interface IVitePlumbingDelta extends IPlumbingDelta {
  /** Whether the kit depends on `@tailwindcss/vite`. */
  readonly tailwind: boolean;
}

/**
 * The `vite.config.ts` a kit ships: `threenative()` plus what is the kit's own.
 *
 * Every piece of plumbing the sixteen kits share — engine freshness, brand and web engine, the
 * engine catalog, the Asset Library, the asset watch, the polling watch and the `main.html` entry —
 * lives in `threenative()` (`src/kit-plugins.ts`), so a new one ships without restamping a kit.
 * What varies is read from the kit: React and Tailwind are dependencies of its manifest.
 */
export function viteConfigText(delta: IVitePlumbingDelta): string {
  const imports = [
    ...(delta.tailwind ? ['import tailwindcss from "@tailwindcss/vite";'] : []),
    ...(delta.react ? ['import react from "@vitejs/plugin-react";'] : []),
    'import { threenative } from "create-threenative";',
    'import { defineConfig } from "vite";',
  ];
  const pluginNames = [
    "threenative()",
    ...(delta.react ? ["react()"] : []),
    ...(delta.tailwind ? ["tailwindcss()"] : []),
  ];
  return `${[
    ...imports,
    "",
    "// `threenative()` is every plugin the kits share; add the game's own after it.",
    "export default defineConfig({",
    `  plugins: [${pluginNames.join(", ")}],`,
    "});",
    "",
  ].join("\n")}`;
}

/** The Vite delta a kit declares: React and Tailwind, by dependency. */
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
