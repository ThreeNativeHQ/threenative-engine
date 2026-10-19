/**
 * Compatibility check for the CSS a `ui.renderer: "native-css"` game ships.
 *
 * The native engine (Stylo + Taffy + vello_cpu) parses all of CSS but paints and lays out only the
 * Core HUD profile (docs/guides/native-css-support.md). Everything outside it that is *active* in
 * the shipped stylesheet is a build failure, not a quiet no-op: a HUD that builds and then silently
 * drops its blur, mask or keyframes is the failure the profile exists to prevent.
 *
 * The list below is the profile's "separate future profile" column, as data. It is a denylist
 * because the Core surface is "whatever the corpus proves", which the engine, not this file, owns;
 * a property absent here is not thereby supported, it is merely not known to be unsupported. A
 * `@supports` condition is never trusted: Stylo answers it by parse-ability, not by what the engine
 * paints, so a denylisted feature fails the build even inside an `@supports` branch.
 *
 * Locations are in the emitted stylesheet (line:column). The build adds the authored
 * `file:line:column` where the stylesheet's own verified map proves one; a build with no map, or
 * with a map it cannot verify, reports the emitted position only.
 */

export interface INativeCssFinding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The property, at-rule or selector construct that is outside the Core profile. */
  readonly what: string;
  readonly why: string;
  /** The authored `file:line:column` this emitted position came from, when a map proves it. */
  readonly authored?: string;
}

/** Properties whose any active value is outside Core. */
const UNSUPPORTED_PROPERTIES: Readonly<Record<string, string>> = {
  filter: "filters are not in the Core paint profile",
  "backdrop-filter": "backdrop blur is not in the Core paint profile",
  "-webkit-backdrop-filter": "backdrop blur is not in the Core paint profile",
  mask: "masks are not in the Core paint profile",
  "mask-image": "masks are not in the Core paint profile",
  "mask-size": "masks are not in the Core paint profile",
  "mask-position": "masks are not in the Core paint profile",
  "mask-repeat": "masks are not in the Core paint profile",
  "-webkit-mask": "masks are not in the Core paint profile",
  "-webkit-mask-image": "masks are not in the Core paint profile",
  "mix-blend-mode": "blend modes are not in the Core paint profile",
  "background-blend-mode": "blend modes are not in the Core paint profile",
  "clip-path": "clip-path (SVG shapes) is not in the Core paint profile",
  "shape-outside": "floats and shapes are not in the Core layout profile",
  columns: "multicolumn layout is not in the Core layout profile",
  "column-count": "multicolumn layout is not in the Core layout profile",
  "column-width": "multicolumn layout is not in the Core layout profile",
  perspective: "3D transforms are not in the Core paint profile",
  "scroll-snap-type": "scroll snapping is not in the Core interaction profile",
  "scroll-snap-align": "scroll snapping is not in the Core interaction profile",
};

/** Properties that are unsupported only for some values: [property, value test, reason]. */
const UNSUPPORTED_VALUES: readonly (readonly [string, RegExp, string])[] = [
  ["float", /^(?!none\b)/u, "floats are not in the Core layout profile"],
  ["position", /^sticky\b/u, "sticky positioning is not in the Core layout profile"],
  ["display", /^(table|inline-table|table-)/u, "tables are not in the Core layout profile"],
  [
    "writing-mode",
    /^(?!horizontal-tb\b)/u,
    "alternate writing modes are not in the Core layout profile",
  ],
  ["transform-style", /preserve-3d/u, "3D transforms are not in the Core paint profile"],
  [
    "transform",
    /\b(translate3d|translatez|rotate3d|rotatex|rotatey|rotatez|scale3d|scalez|matrix3d|perspective)\s*\(/u,
    "3D transforms are not in the Core paint profile",
  ],
  [
    "animation",
    /^(?!none\b)/u,
    "keyframe animations are not in the Core motion profile (transitions are)",
  ],
  [
    "animation-name",
    /^(?!none\b)/u,
    "keyframe animations are not in the Core motion profile (transitions are)",
  ],
  [
    "grid-template-columns",
    /\bsubgrid\b|\bmasonry\b/u,
    "subgrid and masonry are not in the Core layout profile",
  ],
  [
    "grid-template-rows",
    /\bsubgrid\b|\bmasonry\b/u,
    "subgrid and masonry are not in the Core layout profile",
  ],
];

const UNSUPPORTED_AT_RULES: Readonly<Record<string, string>> = {
  keyframes: "keyframe animations are not in the Core motion profile (transitions are)",
  "-webkit-keyframes": "keyframe animations are not in the Core motion profile (transitions are)",
  container: "container queries are not in the Core profile",
  page: "@page is not part of a HUD",
  namespace: "@namespace is not part of a HUD",
  "counter-style": "@counter-style is not in the Core profile",
};

const UNSUPPORTED_SELECTORS: readonly (readonly [RegExp, string, string])[] = [
  [/:has\(/u, ":has()", ":has() is not in the Core selector profile"],
];

interface IPosition {
  readonly line: number;
  readonly column: number;
}

function locate(css: string, offset: number): IPosition {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i++) {
    if (css.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: offset - last };
}

/** Blank out comments and string contents without changing any offset, so scanning stays honest. */
function mask(css: string): string {
  return css
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (m) => m.replaceAll(/[^\n]/gu, " "))
    .replaceAll(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/gu, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

/**
 * Every Core-profile violation in one stylesheet, in source order.
 *
 * A small block scanner, not a CSS parser: it tracks `{`/`}` nesting, reads a prelude (selector or
 * at-rule) before each block, and a declaration before each `;` or `}` inside it.
 */
export function findNativeCssViolations(file: string, css: string): INativeCssFinding[] {
  const source = mask(css);
  const findings: INativeCssFinding[] = [];
  const add = (offset: number, what: string, why: string): void => {
    findings.push({ file, ...locate(css, offset), what, why });
  };
  // Each open block remembers whether it holds declarations (a style rule) or more rules (a group).
  const stack: { declarations: boolean }[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      const prelude = source.slice(start, i).trim();
      const at = /^@([-\w]+)/u.exec(prelude);
      const offset =
        start + (source.slice(start, i).length - source.slice(start, i).trimStart().length);
      if (at) {
        const reason = UNSUPPORTED_AT_RULES[at[1]?.toLowerCase() ?? ""];
        if (reason !== undefined) add(offset, `@${at[1]}`, reason);
        stack.push({ declarations: /^@(font-face|page|property|counter-style)\b/u.test(prelude) });
      } else {
        for (const [pattern, what, why] of UNSUPPORTED_SELECTORS) {
          if (pattern.test(prelude)) add(offset, what, why);
        }
        stack.push({ declarations: true });
      }
      start = i + 1;
    } else if (ch === ";" || ch === "}") {
      const top = stack[stack.length - 1];
      if (top?.declarations) {
        const declaration = source.slice(start, i);
        const colon = declaration.indexOf(":");
        if (colon > 0) {
          const property = declaration.slice(0, colon).trim().toLowerCase();
          const value = declaration
            .slice(colon + 1)
            .trim()
            .toLowerCase()
            .replace(/\s*!important$/u, "");
          const offset = start + (declaration.length - declaration.trimStart().length);
          if (!property.startsWith("--")) {
            const reason = UNSUPPORTED_PROPERTIES[property];
            if (reason !== undefined) add(offset, property, reason);
            for (const [name, test, why] of UNSUPPORTED_VALUES) {
              if (name === property && test.test(value)) add(offset, `${property}: ${value}`, why);
            }
          }
        }
      }
      if (ch === "}") stack.pop();
      start = i + 1;
    }
  }
  return findings;
}

/** The build-failure text for a set of findings; one line each, with both locations. */
export function describeNativeCssFindings(findings: readonly INativeCssFinding[]): string {
  return findings
    .map(
      (f) =>
        `  ${f.file}:${f.line}:${f.column}${f.authored === undefined ? "" : `  authored ${f.authored}`}  ${f.what} — ${f.why}`,
    )
    .join("\n");
}
