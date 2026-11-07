// The two build-plumbing files every kit held a copy of, generated from one source plus the kit's
// own delta. `vite.config.ts` is still per kit (its plugin list and worker entry differ); this module
// owns `tsconfig.json` first, because it is the file whose copies disagree for no reason at all.
//
// The delta is derived, not listed: whether a kit ships React is whether its manifest depends on it.
// A kit without React needs neither `jsx` nor the `.tsx` glob, and one that gains React needs both —
// editing package.json is then enough, with no second list to remember.
import { readFileSync } from "node:fs";
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
