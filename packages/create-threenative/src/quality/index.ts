import { readFileSync } from "node:fs";
import path from "node:path";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import type { Linter } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import { hotCallbackAllocation } from "./hotCallbackAllocation.js";

export interface IQualityOptions {
  /** The project root: where `tsconfig.json` lives and the typed rules resolve from. */
  readonly root: string;
}

type Plugin = NonNullable<Linter.Config["plugins"]>[string];
// The plugins ship their own rule typings, which differ from ESLint's flat-config `Plugin`.
const asPlugin = (plugin: object): Plugin => plugin as Plugin;

const SOURCE = ["src/**/*.ts", "src/**/*.tsx"];

/** React is optional per template, so the hook rules follow what the project declares. Resolving
 * `react` would also find pnpm's hoisted copy and turn the rules on for a React-free project. */
function hasReact(root: string): boolean {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  return ["dependencies", "devDependencies"].some((field) => manifest[field]?.react !== undefined);
}

/** The default correctness gate for a generated game: TypeScript-aware async rules, React hook
 * rules when React is installed, scoped suppressions, and one advisory frame-callback warning.
 * Formatting is Biome's job, not this config's. */
export function qualityConfig({ root }: IQualityOptions): Linter.Config[] {
  const tnPlugin = { rules: { "hot-callback-allocation": hotCallbackAllocation } };
  const config: Linter.Config[] = [
    { ignores: ["**/node_modules/**", "**/dist/**", "**/.threenative/**", "**/dist-native/**"] },
    {
      files: SOURCE,
      languageOptions: {
        parser: tsParser as Linter.Parser,
        parserOptions: { projectService: true, tsconfigRootDir: root },
      },
      linterOptions: { reportUnusedDisableDirectives: "error" },
      plugins: {
        "@eslint-community/eslint-comments": eslintComments,
        "@typescript-eslint": asPlugin(tsPlugin),
        threenative: tnPlugin,
      },
      rules: {
        "no-debugger": "error",
        "no-dupe-keys": "error",
        "no-unreachable": "error",
        "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
        "@typescript-eslint/no-misused-promises": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
        ],
        "@eslint-community/eslint-comments/require-description": "error",
        "threenative/hot-callback-allocation": "warn",
      },
    },
  ];
  if (hasReact(root)) {
    config.push({
      files: ["src/**/*.tsx"],
      plugins: {
        "react-hooks": asPlugin(reactHooks),
      },
      rules: { "react-hooks/exhaustive-deps": "error", "react-hooks/rules-of-hooks": "error" },
    });
  }
  return config;
}
