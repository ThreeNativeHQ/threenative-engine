#!/usr/bin/env node
/**
 * Tailwind parity meter: the denominator comes from Tailwind, the scene is one React component, and
 * both renderers (pinned headless Chromium and the native CSS engine) draw the same panels from it.
 *
 * ## The unit (the denominator)
 *
 * Tailwind 4.3.3's own design system lists every class it can emit (`getClassList()`) and every
 * variant (`getVariants()`). A **utility unit** is one `(root, emitted property set, at-rule)`
 * triple: `root` is the class name with a leading `-` removed up to its first `-` (`bg-red-500` and
 * `bg-linear-to-r` are both root `bg`, and they land in different units because they emit different
 * properties), the property set is every declaration property name in the emitted rule, and the
 * at-rule set is the enclosing at-rules. A **variant unit** is one variant. Nothing here is a
 * hand-written list: a Tailwind upgrade that adds a utility or a variant adds a unit, and `--check`
 * fails until the scene has a cell for it.
 *
 * ## The cell
 *
 * Every unit gets one cell: a labelled 320x240 box whose probe carries the unit's class **over a
 * contrast class** (`m-4 m-0`, `hover:bg-red-500` over `bg-blue-500`), so the class always has a
 * different value to win against and a declaration the engine silently dropped is visible. The
 * wrapper is the smallest one the unit needs (a flex row for a flex child, a table for
 * `table-layout`, a scroller for `sticky`, a text run for `line-clamp`). Cells are grouped into
 * 12-cell 1280x720 panels; a panel never mixes two owner families, and a cell that needs a device
 * state of its own gets a panel to itself.
 *
 * `src/ui/TailwindParity.tsx` renders a panel from the generated `src/ui/tailwind-parity.scene.json`;
 * the browser page (`src/parity-web.tsx`) and the native entry mount that same component.
 *
 * ## The bars (the corpus's own, not relaxed)
 *
 * - geometry: every element's border box within 1 CSS px on each edge (`shared.mjs` `edgeMisses`);
 * - pixels: the cell crop's luminance SSIM >= 0.99, or 0.98 when the cell draws glyphs (`ssim`);
 * - state: a cell that describes a device state (`hover`, `focus`, `active`, a media variant) is
 *   captured after the input steps that reach that state, and those steps are one list executed by
 *   both subjects — Playwright input on the browser, the `oracle` example's `drive.json` on the
 *   engine — at coordinates measured in Chromium and handed to both.
 * - vacuity: with the contrast class still on, dropping the unit class must change the cell's crop.
 *   A cell that cannot be staged yet names its exemption and the PRD that removes it.
 *
 * ## Usage
 *
 *   node corpus/tailwind-parity.mjs                 # score the crate subject, keeping the scene current
 *   node corpus/tailwind-parity.mjs --host          # the real desktop host as the subject
 *   node corpus/tailwind-parity.mjs --write         # regenerate the scene only
 *   node corpus/tailwind-parity.mjs --check         # denominator, ownership, freshness, vacuity
 *   node corpus/tailwind-parity.mjs --family PRD-844 [--group mask]
 *   node corpus/tailwind-parity.mjs --sheet PRD-844 # contact sheets for a fresh visual judge
 *   node corpus/tailwind-parity.mjs --ratchet       # fail below the committed floor
 *   node corpus/tailwind-parity.mjs --floor         # rewrite the floor from a measured run
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { PNG } from "pngjs";
import { build } from "vite";
import { hostPanel, prepareHostOut } from "./host.mjs";
import {
  CHROMIUM_ARGS,
  EDGE_PX,
  SSIM_MIN,
  SSIM_MIN_GLYPHS,
  edgeMisses,
  example,
  here,
  luminance,
  number,
  ops,
  ssim,
  stageAssets,
} from "./shared.mjs";

// -------------------------------------------------------------------------------------------------
// What a cell is. Identical on both renderers: the moment either grows a renderer-specific tweak,
// the comparison stops measuring parity.
// -------------------------------------------------------------------------------------------------

const FONT_CSS = `
@font-face{font-family:Noto;font-weight:400;src:url(NotoSans-Regular.ttf)}
@font-face{font-family:Noto;font-weight:700;src:url(NotoSans-Bold.ttf)}
html,body{margin:0;padding:0;overflow:hidden;background:#18181b;color:#e4e4e7;font-family:Noto;font-size:16px;line-height:24px}
`;

/** The panel grid: 4 x 3 cells fill 1280x720 exactly, so no cell is a different size. */
const CELL_W = 320;
const CELL_H = 240;
const COLS = 4;
const ROWS = 3;
const CELLS_PER_PANEL = COLS * ROWS;
const PANEL_W = CELL_W * COLS;
const PANEL_H = CELL_H * ROWS;

/**
 * The cell furniture. `.probe` gives every unit something visible to change; the contrast class a
 * cell carries overrides it, and the unit's own rule is emitted last so the unit wins.
 */
const PANEL_CSS = `
.panel{display:grid;grid-template-columns:repeat(${COLS},${CELL_W}px);grid-template-rows:repeat(${ROWS},${CELL_H}px);width:${PANEL_W}px;height:${PANEL_H}px;overflow:hidden;background:#18181b}
.cell{position:relative;width:${CELL_W}px;height:${CELL_H}px;overflow:hidden;border-right:1px solid #27272a;border-bottom:1px solid #27272a;box-sizing:border-box}
.cell-label{height:26px;line-height:26px;padding:0 6px;font-size:13px;color:#a1a1aa;white-space:nowrap;overflow:hidden}
.cell-stage{position:relative;width:${CELL_W - 2}px;height:${CELL_H - 28}px;overflow:hidden;padding:8px;box-sizing:border-box}
.probe{background:#2563eb;color:#fafafa;font-size:14px;line-height:20px;box-sizing:border-box;width:120px;height:40px;padding:2px;
  /* Positioned, so inset, top/right/bottom/left and z-index have a box to act on: a static probe
     would make sixteen units vacuous for a reason that has nothing to do with the engine. */
  position:relative}
.probe-outline{outline:2px solid #52525b}
.stage-row{display:flex;gap:6px;width:100%}
.stage-col{display:flex;flex-direction:column;gap:6px;width:100%}
.stage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%}
.stage-scroll{width:100%;height:${CELL_H - 44}px;overflow:auto}
.stage-scroll-body{height:600px;display:flex;flex-direction:column;gap:44px}
.stage-table{border-collapse:separate;border-spacing:0;width:100%}
.stage-table td,.stage-table th{border:1px solid #52525b;padding:3px 5px;color:#e4e4e7;font-size:13px}
.stage-prose{font-size:14px;line-height:20px;color:#e4e4e7}
.stage-fill{width:120px;height:40px;background:#27272a}
.stage-flex{display:flex}
/* A backdrop filter needs something to filter and something translucent to see it through: a
   saturated band behind the cell and a see-through probe over it. */
.stage-backdrop{width:100%;height:100%;color:#fafafa;font-size:13px;line-height:16px;padding:2px;
  background:repeating-linear-gradient(45deg,#e11d48 0 10px,#2563eb 10px 20px,#22c55e 20px 30px,#f59e0b 30px 40px)}
.probe-translucent{background:rgba(24,24,27,0.35)}
.stage-list{margin:0;padding-left:18px;list-style:disc}
`;

// -------------------------------------------------------------------------------------------------
// The denominator.
// -------------------------------------------------------------------------------------------------

const TAILWIND_CSS = '@import "tailwindcss";';

async function loadDesignSystem() {
  const { __unstable__loadDesignSystem } = await import("@tailwindcss/node");
  return __unstable__loadDesignSystem(TAILWIND_CSS, { base: example });
}

/**
 * The stylesheet one panel needs: Tailwind's own build of the panel's classes, theme variables and
 * all. `candidatesToCss` alone is not enough — a utility that resolves through `var(--spacing)`
 * paints nothing without the `@theme` block a real build emits.
 */
async function buildSheet(classes) {
  const { compile } = await import("@tailwindcss/node");
  const compiler = await compile(TAILWIND_CSS, { base: example, onDependency: () => {} });
  return compiler.build(classes);
}

/** The utility root: the class name without a leading `-`, up to its first `-`. */
const rootOf = (name) => (name.startsWith("-") ? name.slice(1) : name).split("-")[0];

/**
 * Every declaration property name and enclosing at-rule in one compiled rule.
 *
 * A *descriptor* block (`@property --tw-x { syntax: ...; inherits: false }`, `@font-face`) describes
 * a rule; its members are not properties the element paints. Reading them as declarations gave 46
 * units a no-op "contrast" such as `syntax:"<length>"` and changed the unit key, so they are skipped
 * and the descriptor at-rule is not recorded either.
 */
const DESCRIPTOR_AT_RULES = new Set(["property", "font-face", "counter-style", "page"]);

function scan(css) {
  const state = { props: new Set(), atRules: new Set(), values: [], stack: [] };
  for (const raw of css.split("\n")) scanLine(raw.trim(), state);
  return {
    props: [...state.props].sort(),
    atRules: [...state.atRules].sort(),
    values: state.values,
  };
}

/** One trimmed line of a compiled rule, folded into the scan's state. */
function scanLine(line, state) {
  if (line.endsWith("{")) return openBlock(line.slice(0, -1).trim(), state);
  if (line === "}") return void state.stack.pop();
  if (state.stack.at(-1) !== "rule") return undefined;
  const declaration = /^([-a-zA-Z][-a-zA-Z0-9]*)\s*:(.*)$/u.exec(line);
  if (declaration === null) return undefined;
  state.props.add(declaration[1]);
  state.values.push(declaration[2]);
  return undefined;
}

/** A block opens a rule, a group of rules, or a descriptor block whose members are not painted. */
function openBlock(prelude, state) {
  if (!prelude.startsWith("@")) return void state.stack.push("rule");
  const name = /^@([-\w]+)/u.exec(prelude)?.[1].toLowerCase() ?? "";
  if (!DESCRIPTOR_AT_RULES.has(name)) state.atRules.add(prelude);
  // An at-rule nested inside a style rule (`@container`, the `@supports` Tailwind emits for
  // gradient interpolation) still declares properties of that rule.
  const kind = DESCRIPTOR_AT_RULES.has(name)
    ? "descriptor"
    : state.stack.at(-1) === "rule"
      ? "rule"
      : "group";
  state.stack.push(kind);
}

/** The value a rule gives one property, or `undefined` when it does not declare it. */
function declaredValue(css, property) {
  const escaped = property.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?:^|[{;\\s])${escaped}\\s*:\\s*([^;}]+)`, "u");
  const match = pattern.exec(css);
  return match === null ? undefined : match[1].trim();
}

/**
 * Every unit Tailwind 4.3.3 can emit, with one probe class per unit.
 *
 * The probe is the shortest class of the unit, then the lexicographically first: deterministic, so
 * a regenerated scene is byte-identical and `--check` compares files instead of trusting a run.
 */
export async function deriveUnits() {
  const design = await loadDesignSystem();
  const classes = design.getClassList().map(([name]) => name);
  const compiled = design.candidatesToCss(classes);
  const classCss = new Map();
  const strength = new Map();
  const units = new Map();
  for (const [index, name] of classes.entries()) {
    const css = compiled[index];
    if (css == null || css === "") continue;
    classCss.set(name, css);
    const { props, atRules, values } = scan(css);
    strength.set(name, magnitude(values.join(" ")));
    const root = rootOf(name);
    const key = `${root}|${props.join(",")}|${atRules.join(";")}`;
    const unit = units.get(key);
    if (unit === undefined) {
      units.set(key, { key, root, props, atRules, classes: [name], probe: name });
      continue;
    }
    unit.classes.push(name);
    if (
      stronger(
        name,
        css,
        strength.get(name),
        unit.probe,
        classCss.get(unit.probe) ?? "",
        strength.get(unit.probe),
      )
    ) {
      unit.probe = name;
    }
  }
  const variants = design.getVariants().map((variant) => ({
    name: variant.name,
    arbitrary: variant.isArbitrary,
  }));
  return { design, units: [...units.values()], variants, classCss, classCount: classes.length };
}

/**
 * The largest px-equivalent number a rule *declares*, or 0 when it declares none.
 *
 * From the declaration values only: a `@property` descriptor's `initial-value` or `syntax` is not
 * something the unit paints, and reading it made every ring and shadow class look identical.
 */
function magnitude(values) {
  let largest = 0;
  for (const match of values.matchAll(/(-?[\d.]+)(px|rem|em|%)?/gu)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const scale = match[2] === "rem" || match[2] === "em" ? 16 : 1;
    largest = Math.max(largest, Math.abs(value) * scale);
  }
  return largest;
}

/**
 * Which class of a unit should be its probe.
 *
 * Not the shortest name. Two reasons: `ring` is a 1 px ring and `rounded` a 4 px corner, and a 1 px
 * change on a 120x40 box does not move SSIM past the 0.99 bar, so the cell cannot tell a correct
 * engine from one that dropped the declaration; and `animate-none` or `transition-normal` paints the
 * same frame as no class at all. The probe is the strongest class that is not an identity value and
 * still fits a 320x240 cell — `ring-4`, `rounded-3xl`, `animate-spin`.
 */
const PROBE_STRENGTH_CAP = 40;

const IDENTITY_VALUE = /:\s*(none|normal|auto|visible|0px|0%|0)\s*(!important)?\s*[};]/u;

/** Negative is stronger, so the tuple compares with `<`. */
function probeRank(name, css, strength) {
  return [
    IDENTITY_VALUE.test(css) ? 1 : 0,
    -Math.min(strength, PROBE_STRENGTH_CAP),
    name.length,
    name,
  ];
}

function stronger(
  candidate,
  candidateCss,
  candidateStrength,
  current,
  currentCss,
  currentStrength,
) {
  const a = probeRank(candidate, candidateCss, candidateStrength);
  const b = probeRank(current, currentCss, currentStrength);
  for (const [index, value] of a.entries()) {
    if (value === b[index]) continue;
    return value < b[index];
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// Ownership: every unit belongs to exactly one PRD of the batch.
// -------------------------------------------------------------------------------------------------

const P844 = "PRD-844";
const P845 = "PRD-845";
const P846 = "PRD-846";
const P847 = "PRD-847";
const P848 = "PRD-848";
const P849 = "PRD-849";
const P850 = "PRD-850";
const P851 = "PRD-851";

/** Ordered ownership rules for utility units: first match wins, and the fallback is PRD-850. */
const UTILITY_OWNERS = [
  [(u) => u.props.some((p) => /(^|-)filter$/u.test(p) || p === "backdrop-filter"), P844, "filter"],
  [(u) => u.props.some((p) => p.endsWith("blend-mode") || p === "isolation"), P845, "blend"],
  [(u) => u.props.some((p) => /mask/u.test(p)), P845, "mask"],
  [(u) => u.props.includes("clip-path") || u.probe === "sr-only", P845, "clip"],
  [
    (u) =>
      u.props.some(
        (p) =>
          p.startsWith("perspective") || p === "transform-style" || p === "backface-visibility",
      ) ||
      /^(perspective|backface|transform-3d\(|rotate-[xyz]-|translate-z-|scale-z-)/u.test(u.probe),
    P846,
    "transform3d",
  ],
  [
    (u) => u.props.some((p) => p.startsWith("animation") || p === "transition-behavior"),
    P847,
    "motion",
  ],
  [
    (u) =>
      /^(table|inline-table|table-(row|cell|column|caption|row-group|header-group|footer-group|column-group))$/u.test(
        u.probe,
      ) ||
      u.props.includes("table-layout") ||
      u.props.includes("border-collapse") ||
      u.props.includes("border-spacing") ||
      u.props.includes("caption-side") ||
      u.props.includes("empty-cells"),
    P848,
    "flow",
  ],
  [
    (u) =>
      u.props.includes("float") ||
      u.props.includes("clear") ||
      u.props.some((p) => p.startsWith("column")) ||
      u.props.some((p) => p.startsWith("break-")) ||
      u.props.some((p) => p.startsWith("box-decoration")),
    P848,
    "flow",
  ],
  [
    (u) =>
      u.probe === "sticky" ||
      u.props.some((p) => p.startsWith("scroll-snap")) ||
      u.props.some((p) => p.startsWith("overscroll")) ||
      u.props.includes("scroll-behavior") ||
      /^(snap-|scroll-|overscroll-)/u.test(u.probe),
    P848,
    "scroll",
  ],
  [
    (u) =>
      u.props.includes("-webkit-line-clamp") ||
      u.props.includes("container-type") ||
      u.props.some((p) => /subgrid/u.test(p)),
    P848,
    "grid-and-query",
  ],
  [
    (u) =>
      u.props.some((p) => /^(inset|margin|padding|border)-(block|inline)$/u.test(p)) ||
      u.props.some((p) => /^(inset|margin|padding)-(start|end)$/u.test(p)) ||
      u.props.some((p) => /^border-(start|end)-(start|end)-radius$/u.test(p)) ||
      u.props.includes("inline-size") ||
      u.props.includes("block-size") ||
      u.props.some((p) => /^(min|max)-(inline|block)-size$/u.test(p)),
    P848,
    "logical",
  ],
  [(u) => /^(accent|caret|field-sizing|resize|appearance)/u.test(u.probe), P851, "paint"],
];

const matches = (pattern) => (value) => pattern.test(value);

/** The variant units, and the PRD that owns each. */
const VARIANT_OWNERS = [
  [matches(/^(motion-safe|motion-reduce|starting)$/u), P847, "motion"],
  [
    matches(
      /^(placeholder|placeholder-shown|file|autofill|checked|indeterminate|default|required|optional|valid|invalid|user-valid|user-invalid|in-range|out-of-range|read-only)$/u,
    ),
    P851,
    "states",
  ],
  [matches(/^@/u), P848, "grid-and-query"],
];

const TYPE_PROPS = [
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-underline-offset",
  "font-stretch",
  "font-variant-numeric",
  "font-synthesis",
  "font-feature-settings",
  "hyphens",
  "text-indent",
  "text-wrap",
  "word-break",
  "overflow-wrap",
  "tab-size",
  "text-transform",
  "list-style-type",
  "list-style-position",
  "list-style-image",
  "-webkit-font-smoothing",
  "font-size",
  "line-height",
  "letter-spacing",
  "white-space",
  "text-shadow",
  "text-overflow",
  "-webkit-line-clamp",
];
const PAINT_PROPS = [
  "background-image",
  "background-clip",
  "background-size",
  "background-repeat",
  "background-attachment",
  "background-origin",
  "background-position",
  "box-shadow",
  "border-style",
  "outline-style",
  "fill",
  "stroke",
  "stroke-width",
  "cursor",
  "scrollbar-color",
  "scrollbar-width",
  "scrollbar-gutter",
  "visibility",
  "zoom",
  "color-scheme",
  "will-change",
  "contain",
  "pointer-events",
];

function classifyUtility(unit) {
  for (const [test, owner, group] of UTILITY_OWNERS) if (test(unit)) return { owner, group };
  if (unit.props.some((p) => TYPE_PROPS.includes(p))) return { owner: P850, group: "type" };
  if (unit.props.some((p) => PAINT_PROPS.includes(p))) return { owner: P850, group: "paint" };
  return { owner: P850, group: "misc" };
}

const PSEUDO_VARIANTS = [
  "first-letter",
  "first-line",
  "marker",
  "selection",
  "backdrop",
  "details-content",
  "before",
  "after",
  "file",
  "placeholder",
];
const MEDIA_VARIANTS = [
  "contrast-more",
  "contrast-less",
  "forced-colors",
  "inverted-colors",
  "portrait",
  "landscape",
  "ltr",
  "rtl",
  "print",
  "noscript",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
];

function classifyVariant(name) {
  for (const [test, owner, group] of VARIANT_OWNERS) if (test(name)) return { owner, group };
  if (PSEUDO_VARIANTS.includes(name)) return { owner: P849, group: "pseudo" };
  if (MEDIA_VARIANTS.includes(name)) return { owner: P849, group: "media" };
  if (/^(max|min|pointer-|any-pointer-|supports)/u.test(name))
    return { owner: P849, group: "media" };
  return { owner: P849, group: "selectors" };
}

// -------------------------------------------------------------------------------------------------
// The variant stage. Each entry answers: which class proves the variant, over which contrast
// class, in which element position, after which device state, and — when the engine cannot reach
// that state yet — which PRD removes the exemption.
// -------------------------------------------------------------------------------------------------

/** A pointer move to the element's centre, then (for `active`) a press. */
const hover = { t: "pointer", type: "move", at: "probe" };
const press = [
  { t: "pointer", type: "move", at: "probe" },
  { t: "pointer", type: "down", at: "probe" },
];
const tab = [{ t: "key", key: "Tab" }];

/**
 * `class` is the probe's class, `base` the contrast class under it, `tag` the probe element,
 * `attrs` its attributes, `before`/`after` filler siblings, `wrap` an ancestor class, `inner`
 * whether the probe is a box with children, `drive` the input steps, `env` the device state the
 * media variant needs, and `exempt` the reason a cell cannot be staged yet (with its owner).
 */
const VARIANT_STAGE = {
  "*": { class: "*:bg-red-500", inner: 2 },
  "**": { class: "**:bg-red-500", inner: 2 },
  not: { class: "not-first:bg-red-500", before: 1 },
  group: { class: "group-hover:bg-red-500", wrap: "group", drive: [hover] },
  peer: {
    class: "peer-checked:bg-red-500",
    peer: true,
    exempt: {
      owner: P851,
      why: "peer-* needs a checked control, and the engine paints no form controls",
    },
  },
  "first-letter": { class: "first-letter:text-red-400", text: "Abc" },
  "first-line": { class: "first-line:text-red-400", text: "Abc" },
  marker: { class: "marker:text-red-400", list: 2 },
  selection: {
    class: "selection:bg-yellow-300",
    text: "Abc",
    exempt: {
      owner: P851,
      why: "::selection needs a text selection, and the engine has no selection model",
    },
  },
  backdrop: {
    class: "backdrop:bg-black/50",
    exempt: {
      owner: P851,
      why: "::backdrop needs a top-layer dialog, which the engine does not paint",
    },
  },
  "details-content": {
    class: "details-content:text-red-400",
    exempt: {
      owner: P851,
      why: "::details-content needs a <details> element, which the engine does not paint",
    },
  },
  file: {
    class: "file:text-red-400",
    exempt: { owner: P851, why: "::file-selector-button needs a file input" },
  },
  placeholder: {
    class: "placeholder:text-red-400",
    exempt: {
      owner: P851,
      why: "::placeholder needs a text input, which the engine does not paint",
    },
  },
  before: { class: "before:content-['x']" },
  after: { class: "after:content-['x']" },
  first: { class: "first:bg-red-500" },
  last: { class: "last:bg-red-500", after: 2 },
  only: { class: "only:bg-red-500" },
  odd: { class: "odd:bg-red-500" },
  even: { class: "even:bg-red-500", before: 1 },
  "first-of-type": { class: "first-of-type:bg-red-500" },
  "last-of-type": { class: "last-of-type:bg-red-500", after: 2 },
  "only-of-type": { class: "only-of-type:bg-red-500" },
  visited: {
    class: "visited:text-red-400",
    exempt: {
      owner: P849,
      permanent: true,
      why: "the engine has no navigation, so nothing is ever :visited; the batch's own decision is that both sides agree the rule is inactive",
    },
  },
  target: {
    class: "target:bg-red-500",
    exempt: {
      owner: P849,
      permanent: true,
      why: ":target needs a URL fragment, which neither subject sets; both sides agree the rule is inactive",
    },
  },
  open: {
    class: "open:bg-red-500",
    exempt: {
      owner: P851,
      why: "open: needs <details>/<dialog> open state, which the engine does not paint",
    },
  },
  default: {
    class: "default:bg-red-500",
    exempt: { owner: P851, why: "default: needs a checked or default-selected control" },
  },
  checked: {
    class: "checked:bg-red-500",
    exempt: { owner: P851, why: "checked: needs a form control" },
  },
  indeterminate: {
    class: "indeterminate:bg-red-500",
    exempt: { owner: P851, why: "indeterminate: needs a form control" },
  },
  autofill: {
    class: "autofill:bg-red-500",
    exempt: { owner: P851, why: "autofill: needs an autofilled text field" },
  },
  "placeholder-shown": {
    class: "placeholder-shown:bg-red-500",
    exempt: { owner: P851, why: "placeholder-shown: needs a text field" },
  },
  optional: {
    class: "optional:bg-red-500",
    exempt: { owner: P851, why: "optional: needs a form control" },
  },
  required: {
    class: "required:bg-red-500",
    exempt: { owner: P851, why: "required: needs a form control" },
  },
  valid: {
    class: "valid:bg-red-500",
    exempt: { owner: P851, why: "valid: needs a form control with constraints" },
  },
  invalid: {
    class: "invalid:bg-red-500",
    exempt: { owner: P851, why: "invalid: needs a form control with constraints" },
  },
  "user-valid": {
    class: "user-valid:bg-red-500",
    exempt: { owner: P851, why: "user-valid: needs a form control the user has edited" },
  },
  "user-invalid": {
    class: "user-invalid:bg-red-500",
    exempt: { owner: P851, why: "user-invalid: needs a form control the user has edited" },
  },
  "in-range": {
    class: "in-range:bg-red-500",
    exempt: { owner: P851, why: "in-range: needs a range or number control" },
  },
  "out-of-range": {
    class: "out-of-range:bg-red-500",
    exempt: { owner: P851, why: "out-of-range: needs a range or number control" },
  },
  "read-only": {
    class: "read-only:bg-red-500",
    exempt: { owner: P851, why: "read-only: needs a text field" },
  },
  empty: { class: "empty:bg-red-500" },
  "focus-within": { class: "focus-within:bg-red-500", wrap: "fw", inner: 1, drive: tab },
  hover: { class: "hover:bg-red-500", drive: [hover] },
  focus: { class: "focus:bg-red-500", tag: "button", drive: tab },
  "focus-visible": { class: "focus-visible:bg-red-500", tag: "button", drive: tab },
  active: { class: "active:bg-red-500", tag: "button", drive: press },
  enabled: { class: "enabled:bg-red-500", tag: "button" },
  disabled: { class: "disabled:bg-red-500", tag: "button", attrs: { disabled: "" } },
  inert: { class: "inert:bg-red-500", attrs: { inert: "" } },
  in: { class: "in-[.inhost]:bg-red-500", wrap: "inhost" },
  has: { class: "has-[:checked]:bg-red-500", inner: 1, inside: "checked" },
  aria: { class: "aria-expanded:bg-red-500", attrs: { "aria-expanded": "true" } },
  data: { class: "data-[active]:bg-red-500", attrs: { "data-active": "" } },
  nth: { class: "nth-3:bg-red-500", before: 2 },
  "nth-last": { class: "nth-last-2:bg-red-500", after: 1 },
  "nth-of-type": { class: "nth-of-type-2:bg-red-500", before: 1 },
  "nth-last-of-type": { class: "nth-last-of-type-2:bg-red-500", after: 1 },
  supports: { class: "supports-[display:grid]:bg-red-500" },
  "motion-safe": { class: "motion-safe:bg-red-500", env: { reducedMotion: false } },
  "motion-reduce": { class: "motion-reduce:bg-red-500", env: { reducedMotion: true } },
  starting: {
    class: "starting:bg-red-500",
    exempt: {
      owner: P847,
      why: "@starting-style needs a transition to sample, which the motion bar drives",
    },
  },
  "contrast-more": { class: "contrast-more:bg-red-500", env: { contrast: "more" } },
  // `prefers-contrast: less` is a value Playwright's `emulateMedia` does not offer, and the DevTools
  // feature list that does offer it only applies with an empty `media`, which breaks the viewport
  // queries in the same run (measured). The engine answers the query; the reference browser cannot be
  // put in that environment, so the cell is a named exemption.
  "contrast-less": {
    class: "contrast-less:bg-red-500",
    exempt: { owner: P849, why: "Chromium offers no prefers-contrast: less emulation" },
  },
  // Forced colours rewrite every *painted* colour (`Canvas`, `CanvasText`, borders), so a colour
  // utility cannot discriminate in that mode and neither can opacity — the probe and the page become
  // the same colour. The staged unit moves the box instead, which forced colours leave alone: an
  // engine that resolves the query to the wrong value moves nothing.
  "forced-colors": { class: "forced-colors:mt-8", env: { forcedColors: true } },
  // The engine answers `inverted-colors` now, but the reference browser cannot be put in that
  // environment: neither Playwright's `emulateMedia` nor the DevTools media emulation has an
  // `inverted-colors` feature (measured — Chromium ignores it), so there is no "on" arm to compare
  // against and the cell stays a named exemption rather than a pass.
  "inverted-colors": {
    class: "inverted-colors:bg-red-500",
    exempt: {
      owner: P849,
      why: "Chromium has no inverted-colors emulation, so the on arm cannot be compared",
    },
  },
  max: { class: "max-2xl:bg-red-500" },
  sm: { class: "sm:bg-red-500" },
  md: { class: "md:bg-red-500" },
  lg: { class: "lg:bg-red-500" },
  xl: { class: "xl:bg-red-500" },
  "2xl": {
    class: "2xl:bg-red-500",
    viewport: { width: 1600, height: PANEL_H },
  },
  min: { class: "min-xl:bg-red-500" },
  "@max": {
    class: "@max-lg:bg-red-500",
    exempt: {
      owner: P848,
      why: "container queries need a sized container ancestor, which the engine's @container support is proven by PRD-848",
    },
  },
  "@": {
    class: "@lg:bg-red-500",
    exempt: { owner: P848, why: "container queries need a sized container ancestor" },
  },
  "@min": {
    class: "@min-lg:bg-red-500",
    exempt: { owner: P848, why: "container queries need a sized container ancestor" },
  },
  // A portrait viewport is the state `portrait:` describes; the first cell is still in frame.
  portrait: { class: "portrait:bg-red-500", viewport: { width: 720, height: 1280 } },
  landscape: { class: "landscape:bg-red-500" },
  ltr: { class: "ltr:bg-red-500" },
  rtl: { class: "rtl:bg-red-500", attrs: { dir: "rtl" } },
  dark: { class: "dark:bg-red-500", env: { dark: true } },
  print: {
    class: "print:bg-red-500",
    exempt: {
      owner: P849,
      permanent: true,
      why: "a game host never prints; both sides agree the rule is inactive (PRD-849 decision)",
    },
  },
  noscript: {
    class: "noscript:bg-red-500",
    exempt: {
      owner: P849,
      permanent: true,
      why: "a game host always runs script; both sides agree the rule is inactive (PRD-849 decision)",
    },
  },
  "pointer-none": {
    class: "pointer-none:bg-red-500",
    exempt: { owner: P849, why: "the engine reports a mouse or a touch pointer, never none" },
  },
  "pointer-coarse": { class: "pointer-coarse:bg-red-500", env: { touch: true } },
  "pointer-fine": { class: "pointer-fine:bg-red-500" },
  "any-pointer-none": {
    class: "any-pointer-none:bg-red-500",
    exempt: { owner: P849, why: "the engine reports a mouse or a touch pointer, never none" },
  },
  "any-pointer-coarse": { class: "any-pointer-coarse:bg-red-500", env: { touch: true } },
  "any-pointer-fine": { class: "any-pointer-fine:bg-red-500" },
};

// -------------------------------------------------------------------------------------------------
// Probes: the wrapper that gives a utility an effect.
// -------------------------------------------------------------------------------------------------

const el = (tag, attrs = {}, ...children) => ({
  tag,
  attrs,
  children: children.flat().filter((child) => child !== undefined),
});
const text = (value) => ({ text: value });
const fillers = (count) =>
  Array.from({ length: count }, (_, i) => el("div", { class: "stage-fill" }, text(`Row ${i + 1}`)));
const blanks = (count) => Array.from({ length: count }, () => el("div", { class: "stage-fill" }));

const TEXT_PROPS = new Set([
  "color",
  "font-size",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration-line",
  "text-decoration-style",
  "text-decoration-color",
  "text-decoration-thickness",
  "text-underline-offset",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant-numeric",
  "text-transform",
  "text-indent",
  "text-wrap",
  "word-break",
  "overflow-wrap",
  "hyphens",
  "white-space",
  "text-overflow",
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "text-shadow",
  "direction",
  "unicode-bidi",
  "tab-size",
  "list-style-type",
  "list-style-position",
  "list-style-image",
  "vertical-align",
]);
const PROSE_PROPS = new Set([
  "-webkit-line-clamp",
  "-webkit-box-orient",
  "column-count",
  "column-width",
]);

/** Units that only show on a run long enough to wrap, break or be clamped. */
const WRAPPING_PROPS = new Set([
  "text-wrap",
  "word-break",
  "overflow-wrap",
  "white-space",
  "text-overflow",
  "hyphens",
  "text-align",
  "text-indent",
]);

const LOREM =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat";

const IDENTITY =
  /(^|\s)(0|0\.0+|none|auto|normal|visible|initial|inherit|unset|revert|revert-layer|contents)(\s|$)/u;

/** A class that would hide or remove the probe: never a contrast source. */
const HIDING = /display:\s*none|visibility:\s*hidden|opacity:\s*0(?:\.0+)?\s*[;}]|animation:/u;

/**
 * Declarations a *default* needs before some units can show anything at all.
 *
 * A property is often invisible without its context: `position: absolute` with no inset paints in
 * the same place as `static`; `border-color` paints nothing while every border-width is zero; a
 * `background-size` means nothing without a background image to size; `z-index` only orders
 * positioned boxes. Each entry adds that context to the cell's own default, so the unit's
 * declaration is the only thing that changes.
 */
const CONTRAST_EXTRAS = [
  [
    /(^|-)border(-(top|right|bottom|left|x|y|s|e|bs|be|start|end))?-color$/u,
    "border-width:6px;border-style:solid",
  ],
  [/(^|-)outline-color$/u, "outline-width:6px;outline-style:solid"],
  [/^border-color$/u, "border-width:6px;border-style:solid"],
  [/^outline$/u, "outline-width:6px;outline-offset:2px"],
  [
    /^background-(size|position|repeat|attachment|origin|clip)$/u,
    "background-image:repeating-linear-gradient(45deg,#f59e0b 0 6px,#2563eb 6px 12px);background-size:24px 24px",
  ],
  [/^position$/u, "inset:16px"],
  [/^z-index$/u, "position:relative"],
  [
    /^(top|right|bottom|left|inset|inset-(block|inline|s|e|bs|be|start|end))$/u,
    "position:absolute",
  ],
  [/^float$/u, "width:60px"],
  [/^(scale|scale-x|scale-y)$/u, "transform:none"],
];

/** The extra declarations one unit's default needs. */
function contrastExtras(unit) {
  const found = [];
  for (const property of unit.props) {
    for (const [pattern, declarations] of CONTRAST_EXTRAS) {
      if (pattern.test(property) && !found.includes(declarations)) found.push(declarations);
    }
  }
  return found;
}

/** Values a contrast should prefer for one property, best first, because keyword swaps can be invisible. */
const PREFERRED_CONTRAST = {
  display: ["inline", "inline-block", "flow-root", "contents"],
  position: ["absolute", "fixed", "relative"],
};

/**
 * The default the unit's declarations must beat, as a declaration block.
 *
 * It is emitted *before* Tailwind's sheet with a `:where()` scope, so it has a utility class's own
 * specificity and the unit's rule — later in the sheet — always wins. A contrast *class* cannot do
 * this job: Tailwind sorts its own output by property and value, so `m-1` and `m-0` are emitted in
 * an order no caller controls, and half the units would silently lose to their own contrast.
 *
 * The values come from another class that declares the same properties differently, which is what
 * makes `m-0` visible: a zero margin over a 4px default is a declaration the engine can drop.
 */
function contrastDeclarations(unit, classCss, byProperty) {
  const probeCss = classCss.get(unit.probe) ?? "";
  const declarations = [];
  // The classes the values came from are emitted with the panel, so a `var(--spacing)` contrast
  // makes Tailwind define `--spacing` — its build only writes the theme variables a candidate uses.
  const sources = new Set();
  const differs = ([, css], property) => {
    const candidate = declaredValue(css, property);
    return candidate !== undefined && candidate !== declaredValue(probeCss, property);
  };
  const usable = ([, css]) => css !== undefined && css !== probeCss && !HIDING.test(css);
  // The unit's own family first: `m-1` is the smallest honest contrast for `m-0`.
  const family = unit.classes
    .filter((name) => name !== unit.probe)
    .map((name) => [name, classCss.get(name)])
    .filter(usable)
    .sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
  for (const property of unit.props) {
    const options = family
      .filter((candidate) => differs(candidate, property))
      .concat(
        (byProperty.get(property) ?? [])
          .map((name) => [name, classCss.get(name)])
          .filter((candidate) => usable(candidate) && differs(candidate, property)),
      );
    const preferred = PREFERRED_CONTRAST[property] ?? [];
    const rank = (candidate) => {
      const value = declaredValue(candidate[1], property) ?? "";
      const index = preferred.findIndex((want) => value === want);
      return index === -1 ? preferred.length : index;
    };
    const chosen = options.sort(
      (a, b) => rank(a) - rank(b) || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1),
    )[0];
    if (chosen === undefined) continue;
    if (process.env.TN_PARITY_DEBUG === unit.probe) {
      console.error(
        `DEBUG ${property} <- ${chosen[0]} = ${JSON.stringify(declaredValue(chosen[1], property))} (probe ${JSON.stringify(declaredValue(probeCss, property))})`,
      );
    }
    declarations.push(`${property}:${declaredValue(chosen[1], property)}`);
    sources.add(chosen[0]);
  }
  for (const extra of contrastExtras(unit)) declarations.push(extra);
  return { declarations: declarations.join(";"), sources: [...sources] };
}

/**
 * The utility that consumes a custom property a unit only sets.
 *
 * `from-red-500` emits three `--tw-gradient-*` values and no painted property: alone it changes
 * nothing, and that is a fact about Tailwind rather than a gap in the engine. Proving such a unit
 * means staging it with the utility that reads them, which is what this table is.
 */
const COMPANIONS = [
  [/^--tw-gradient-|^--tw-gradient-position/u, "bg-linear-to-r"],
  [/^--tw-inset-shadow/u, "inset-shadow-sm"],
  [/^--tw-shadow/u, "shadow"],
  [/^--tw-inset-ring/u, "inset-ring"],
  [/^--tw-ring-/u, "ring"],
  [
    /^--tw-blur|^--tw-brightness|^--tw-contrast|^--tw-grayscale|^--tw-hue-rotate|^--tw-invert|^--tw-saturate|^--tw-sepia|^--tw-drop-shadow/u,
    "filter",
  ],
  [/^--tw-scale|^--tw-rotate|^--tw-translate|^--tw-skew/u, "transform"],
  [/^--tw-space-/u, "space-x-4"],
  [/^--tw-divide-/u, "divide-x"],
  [/^--tw-border-spacing/u, "border-spacing-1"],
  [/^--tw-ordinal|^--tw-slashed-zero|^--tw-numeric/u, "tabular-nums"],
  [/^--tw-text-shadow/u, "text-shadow-sm"],
  [/^--tw-duration|^--tw-ease|^--tw-delay/u, "transition"],
];
/** The companion classes a unit needs: one per custom-property family it only sets. */
function companionsFor(unit) {
  const found = [];
  for (const property of unit.props) {
    for (const [pattern, companion] of COMPANIONS) {
      if (pattern.test(property) && !found.includes(companion)) found.push(companion);
    }
  }
  return found;
}

/** Which wrapper a utility unit needs. */
function layoutFor(unit) {
  if (unit.props.some((p) => /backdrop-filter/.test(p))) return "backdrop";
  if (unit.props.some((p) => PROSE_PROPS.has(p))) return "prose";
  if (/^(sticky|snap-|scroll-|overscroll-)/u.test(unit.probe)) return "scroll";
  if (unit.props.some((p) => p.startsWith("column"))) return "prose";
  if (unit.props.includes("float") || unit.props.includes("clear")) return "float";
  if (
    unit.props.includes("table-layout") ||
    unit.props.includes("border-collapse") ||
    unit.props.includes("border-spacing") ||
    unit.props.includes("caption-side") ||
    unit.props.includes("empty-cells")
  ) {
    return "table";
  }
  if (/^(flex|items|justify|self|place|order|basis|grow|shrink|gap|content-)/u.test(unit.probe))
    return "row";
  if (/^(grid-cols|grid-rows|col-|row-|auto-cols|auto-rows|grid-flow)/u.test(unit.probe))
    return "grid";
  return "plain";
}

/**
 * Tags `threenative-css-ui`'s closed `TAGS` list does not create (`src/lib.rs`). A stage that needs
 * one gets a panel to itself, so the refusal is one cell's reported failure instead of eleven
 * innocent neighbours reading as parity gaps.
 */
const REFUSED_TAGS = new Set([
  "table",
  "tbody",
  "tr",
  "td",
  "th",
  "caption",
  "textarea",
  "input",
  "select",
  "option",
]);

/** A probe's class list: the marker, the utilities that consume what the unit sets, then the unit. */
const probeClass = (companions, unit) => ["probe", ...companions, unit].join(" ");

// -------------------------------------------------------------------------------------------------
// The scene.
// -------------------------------------------------------------------------------------------------

/** The probe's inner content: the fillers a child-variant needs, a text run, or nothing. */
function probeInner(stage, cell, innerCount) {
  if (innerCount !== undefined) {
    return Array.from({ length: innerCount }, (_, i) =>
      stage.inside === "checked"
        ? el("input", { type: "checkbox", checked: "", class: "stage-fill" })
        : el("div", { class: "stage-fill" }, text(`In ${i + 1}`)),
    );
  }
  if (cell.prose === true) return [text(LOREM)];
  if (stage.text !== undefined) return [text(stage.text)];
  // `false` from the predicate is not a text node: a probe that needs no text gets none.
  if (cell.unit?.props.some((p) => TEXT_PROPS.has(p)) !== true) return [];
  // A wrapping, clamping or breaking unit needs a run long enough to wrap; a numeric variant needs
  // digits to vary (`tabular-nums` on letters is the same frame as `normal-nums`); a tab needs a tab.
  if (cell.unit.props.some((p) => WRAPPING_PROPS.has(p))) return [text(LOREM)];
  if (cell.unit.props.includes("tab-size")) return [text("\tAbc 123")];
  return [text("Abc 123 fgh 456 ooo")];
}

/** The list variant's probe is the `<li>`, so the marker it paints is the one being measured. */
function listStage(count, probe, classes, attrs) {
  const prepared = el(
    "ul",
    { class: "stage-list" },
    el("li", { class: classes, ...attrs }, ...probe.children),
  );
  for (let i = 0; i < count - 1; i++) {
    prepared.children.push(el("li", { class: "stage-fill" }, text(`Item ${i + 2}`)));
  }
  return [prepared];
}

/** The wrapper a layout needs around the probe. */
function layoutStage(cell, probe, classes, before, after) {
  const siblings = [...before, probe, ...after];
  if (cell.layout === "row")
    return [el("div", { class: "stage-row" }, ...siblings, el("div", { class: "stage-fill" }))];
  if (cell.layout === "grid")
    return [el("div", { class: "stage-grid" }, ...siblings, el("div", { class: "stage-fill" }))];
  if (cell.layout === "scroll") {
    return [
      el(
        "div",
        { class: "stage-scroll" },
        el("div", { class: "stage-scroll-body" }, ...siblings, ...fillers(2)),
      ),
    ];
  }
  if (cell.layout === "table") {
    return [
      el(
        "table",
        { class: `stage-table ${classes}` },
        el(
          "tbody",
          {},
          el("tr", {}, el("td", {}, text("Abc")), el("td", {}, text("Def"))),
          el("tr", {}, el("td", {}, text("Ghi")), el("td", {}, text("Jkl"))),
        ),
      ),
    ];
  }
  if (cell.layout === "backdrop") {
    // A backdrop filter needs something to filter and something to see it through: the probe is
    // translucent and the cell behind it is a hard-edged band, because a smooth gradient is
    // unchanged by a blur and a `backdrop-*` unit would then prove nothing.
    probe.attrs.class = `${classes} probe-translucent`;
    return [el("div", { class: "stage-backdrop" }, ...siblings)];
  }
  if (cell.layout === "float")
    return [el("div", { class: "stage-prose" }, ...siblings, text(` ${LOREM}`))];
  if (cell.prose === true) {
    probe.attrs.class = `probe stage-prose ${classes}`;
    return [probe];
  }
  return siblings;
}

/**
 * Properties that act on an element's *children*, not on the element's own box.
 *
 * `justify-end` is `justify-content: flex-end` on a flex container: on the probe as a plain block it
 * is inert, which is why twelve flex and grid units measured "does nothing" — the cell staged the
 * unit on a box that had no children to lay out. A container unit's probe is the container, with two
 * children and the matching display, so dropping the class moves them.
 */
const CONTAINER_PROPS = new Set([
  "justify-content",
  "justify-items",
  "align-items",
  "align-content",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-auto-columns",
  "grid-auto-rows",
  "flex-direction",
  "flex-wrap",
]);

/** A control utility needs a control: `caret-color` on a `div` is not a question. */
const CONTROL_UNIT = /^(accent|caret|appearance|field-sizing|resize)/u;

/** One cell's tree: the label and the staged probe. */
function cellTree(cell) {
  const stage = VARIANT_STAGE[cell.label] ?? {};
  // A container unit's probe carries the display its property needs, so the children the staging
  // gives it are laid out the way the unit is defined to act on them.
  const container = cell.container === undefined ? "" : ` stage-${cell.container}`;
  const classes = probeClass(cell.companions ?? [], cell.class) + container;
  const probe = el(
    stage.tag ?? (CONTROL_UNIT.test(cell.unit?.probe ?? "") ? "textarea" : "div"),
    { class: classes, ...stage.attrs },
    ...probeInner(stage, cell, stage.inner ?? cell.inner),
  );
  let children;
  if (stage.list !== undefined) children = listStage(stage.list, probe, classes, stage.attrs);
  else if (stage.peer === true) {
    children = [el("input", { type: "checkbox", checked: "", class: "stage-fill peer" }), probe];
  } else if (stage.wrap !== undefined) children = [el("div", { class: stage.wrap }, probe)];
  else
    children = layoutStage(
      cell,
      probe,
      classes,
      blanks(stage.before ?? 0),
      blanks(stage.after ?? 0),
    );

  return el(
    "div",
    { class: `cell c${cell.index}` },
    el("div", { class: "cell-label" }, text(cell.label)),
    el("div", { class: "cell-stage" }, ...children),
  );
}

/** Assign Tailwind's numbering and report, per cell, which element ids its subtree owns. */
function numberPanel(tree) {
  const count = number(tree);
  const ranges = [];
  const walk = (node) => {
    if (node.text !== undefined) return 0;
    const isCell = String(node.attrs.class ?? "").startsWith("cell ");
    if (isCell) ranges.push({ first: node.n, last: node.n });
    let end = node.n;
    for (const child of node.children) end = Math.max(end, walk(child));
    if (isCell) ranges[ranges.length - 1].last = end;
    return end;
  };
  for (const root of tree) walk(root);
  return { count, ranges };
}

/** The probe's element id inside a cell, for a driver's coordinates. */
function probeId(cellNode, cell) {
  const stage = VARIANT_STAGE[cell.label] ?? {};
  const stack = [cellNode];
  let found;
  while (stack.length > 0 && found === undefined) {
    const node = stack.shift();
    if (node.text !== undefined) continue;
    const classes = String(node.attrs.class ?? "");
    if (classes.startsWith("probe")) {
      found = node.n;
      break;
    }
    if (stage.peer === true && classes === "stage-fill peer") {
      found = node.n;
      break;
    }
    if (stage.wrap !== undefined && classes === stage.wrap) {
      found = node.n;
      break;
    }
    stack.push(...node.children);
  }
  return found;
}

/** Build the scene: units grouped into (owner, group) panels of 12 cells. */
/** Every class that declares each property, so a unit with no family member can still find contrast. */
function propertyIndex(classCss) {
  const byProperty = new Map();
  for (const [name, css] of classCss) {
    for (const property of scan(css).props) {
      const list = byProperty.get(property) ?? [];
      list.push(name);
      byProperty.set(property, list);
    }
  }
  return byProperty;
}

/** One utility unit's entry in the scene. */
function utilityEntry(unit, classCss, byProperty) {
  const { owner, group } = classifyUtility(unit);
  const layout = layoutFor(unit);
  return {
    id: `${owner}/${group}|${unit.key}`,
    owner,
    group,
    label: unit.probe,
    class: unit.probe,
    contrast: contrastDeclarations(unit, classCss, byProperty),
    companions: companionsFor(unit),
    inner:
      /^(space|divide)$/u.test(unit.root) || unit.props.some((p) => CONTAINER_PROPS.has(p))
        ? 2
        : undefined,
    // A grid container property needs a grid; everything else in `CONTAINER_PROPS` is flex.
    container: unit.props.some((p) => CONTAINER_PROPS.has(p))
      ? /grid|^justify-items/u.test(unit.props.join(" ")) || /^grid-/u.test(unit.probe)
        ? "grid"
        : "flex"
      : undefined,
    layout,
    needsRefusedTag:
      layout === "table" || /^(accent|caret|appearance|field-sizing|resize)/u.test(unit.probe),
    // A multicolumn cell beside a float is the one case the engine does not finish; giving each
    // flow cell its own panel means a slow one costs one cell instead of a whole panel's evidence.
    // One wheel per frame: twelve wheels in one capture is not the same input on the two subjects,
    // because the first one moves the layout under the coordinates the others would aim at.
    alone: layout === "prose" || layout === "float" || layout === "scroll",
    // `scroll-m*`/`scroll-p*`/`snap-*`/`sticky` change nothing until something scrolls, so the cell
    // is captured after one wheel of the same size on both subjects. A caret only paints in a
    // focused field, so a control unit is captured after the Tab that focuses it.
    drive:
      layout === "scroll"
        ? [{ t: "wheel", at: "probe", dy: 140 }]
        : CONTROL_UNIT.test(unit.probe)
          ? [{ t: "key", key: "Tab" }]
          : undefined,
    prose: unit.props.some((p) => PROSE_PROPS.has(p)),
    unit,
  };
}

/** One variant unit's entry in the scene, from its staging row. */
function variantEntry(variant) {
  const { owner, group } = classifyVariant(variant.name);
  const stage = VARIANT_STAGE[variant.name] ?? {};
  const cls = stage.class ?? variantClass(variant.name, variant.arbitrary);
  return {
    id: `${owner}/${group}|variant|${variant.name}`,
    owner,
    group,
    label: cls,
    class: cls,
    contrast: { declarations: stage.contrast ?? "background-color:#3f3f46", sources: [] },
    companions: stage.companions ?? [],
    layout: "plain",
    unit: {
      probe: cls,
      root: "bg",
      props: ["background-color"],
      atRules: [],
      classes: [cls],
      key: `variant|${variant.name}`,
    },
    drive: stage.drive,
    env: stage.env,
    viewport: stage.viewport,
    exempt: stage.exempt,
    alone:
      stage.drive !== undefined ||
      stage.env !== undefined ||
      stage.viewport !== undefined ||
      stage.peer === true ||
      stage.list !== undefined ||
      stage.inside !== undefined,
  };
}

/** A cell that needs the device to itself gets a panel to itself; the rest batch by family. */
function bucketEntries(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    const key =
      entry.alone === true || entry.needsRefusedTag === true
        ? `alone|${entry.id}`
        : `${entry.owner}|${entry.group}`;
    const bucket = buckets.get(key) ?? { owner: entry.owner, group: entry.group, entries: [] };
    bucket.entries.push(entry);
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

/** The classes a panel's sheet must contain, in the order that makes the unit win. */
function sheetClasses(slice) {
  const emitted = [];
  const seen = new Set();
  for (const entry of slice) {
    for (const name of entry.contrast?.sources ?? []) emitted.push(name);
  }
  for (const entry of slice) {
    for (const name of [...(entry.companions ?? []), entry.class]) {
      if (name === undefined || seen.has(name)) continue;
      seen.add(name);
      emitted.push(name);
    }
  }
  return emitted;
}

/** One panel: its tree, its stylesheet, and the cell keys the meter reads boxes by. */
async function makePanel(bucket, slice, index) {
  for (const [cellIndex, entry] of slice.entries()) entry.index = cellIndex;
  const tree = [el("div", { class: "panel" }, ...slice.map(cellTree))];
  const contrast = slice
    .map((entry) => {
      const declarations = entry.contrast?.declarations ?? "";
      return declarations === "" ? "" : `:where(.c${entry.index}) .probe{${declarations}}`;
    })
    .join("\n");
  const { count, ranges } = numberPanel(tree);
  const sheet = await buildSheet(sheetClasses(slice));
  const viewport = slice.find((entry) => entry.viewport !== undefined)?.viewport;
  const panel = {
    index,
    id: `panel-${String(index).padStart(2, "0")}`,
    owner: bucket.owner,
    group: bucket.group,
    width: viewport?.width ?? PANEL_W,
    height: viewport?.height ?? PANEL_H,
    // The furniture and the contrast defaults sit in Tailwind's `base` layer. Tailwind emits its
    // utilities in `@layer utilities`, and a layered rule loses to an unlayered one whatever the
    // source order — so an unlayered `.probe{width:120px}` would beat every `w-*` unit in the sheet,
    // and the scene would be measuring its own furniture instead of Tailwind.
    css: `${FONT_CSS}@layer base{${PANEL_CSS}${contrast}}${sheet}`,
    tree,
    elements: count,
    env: slice.map((entry) => entry.env).find((value) => value !== undefined),
    cells: [],
  };
  for (const [cellIndex, range] of ranges.entries()) {
    const entry = slice[cellIndex];
    panel.cells.push({
      unit: entry.id,
      class: entry.class,
      label: entry.label,
      owner: entry.owner,
      group: entry.group,
      glyphs: probeDrawsGlyphs(tree[0].children[cellIndex], entry),
      drive: entry.drive,
      exempt: entry.exempt,
      probe: probeId(tree[0].children[cellIndex], entry),
      ...range,
    });
  }
  return panel;
}

/** Build the scene: units grouped into (owner, group) panels of 12 cells. */
export async function buildScene({ design, units, variants, classCss }) {
  const byProperty = propertyIndex(classCss);
  const entries = [
    ...units.map((unit) => utilityEntry(unit, classCss, byProperty)),
    ...variants.map(variantEntry),
  ];
  const panels = [];
  for (const bucket of bucketEntries(entries)) {
    for (let offset = 0; offset < bucket.entries.length; offset += CELLS_PER_PANEL) {
      panels.push(
        await makePanel(
          bucket,
          bucket.entries.slice(offset, offset + CELLS_PER_PANEL),
          panels.length,
        ),
      );
    }
  }
  return {
    tailwind: tailwindVersion(),
    version: 1,
    total: entries.length,
    utilityUnits: units.length,
    variantUnits: variants.length,
    owners: [...new Set(entries.map((entry) => entry.owner))].sort(),
    groups: [...new Set(entries.map((entry) => `${entry.owner}/${entry.group}`))].sort(),
    exemptions: entries
      .filter((entry) => entry.exempt !== undefined)
      .map((entry) => ({ unit: entry.id, class: entry.class, ...entry.exempt })),
    panels,
  };
}

const drawsGlyphs = (node) =>
  node.text !== undefined || node.children.some((child) => drawsGlyphs(child));

/**
 * Does the *probe* draw glyphs? The cell's label always does, so asking the cell would put every
 * cell on the 0.98 bar and the 0.99 bar would never apply to anything.
 */
function probeDrawsGlyphs(cellNode, entry) {
  const stack = [cellNode];
  while (stack.length > 0) {
    const node = stack.shift();
    if (node.text !== undefined) continue;
    const classes = String(node.attrs.class ?? "");
    if (classes.startsWith("probe") || classes.includes(` ${entry.class}`))
      return drawsGlyphs(node);
    stack.push(...node.children);
  }
  return false;
}

const tailwindVersion = () =>
  JSON.parse(readFileSync(join(example, "node_modules", "tailwindcss", "package.json"), "utf8"))
    .version;

/** The spelling Tailwind accepts for a variant's probe, or the arbitrary form's fallback. */
function variantClass(name, arbitrary) {
  return arbitrary ? `${name}:[background-color:red]` : `${name}:bg-red-500`;
}

// -------------------------------------------------------------------------------------------------
// Subjects.
// -------------------------------------------------------------------------------------------------

const crate = join(example, "..", "..", "packages", "runtime-native", "native", "css-ui");
const sceneFile = join(example, "src", "ui", "tailwind-parity.scene.json");
const floorFile = join(here, "tailwind-parity.floor.json");
const outRoot = join(here, "out-parity");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Serve the built parity page from one directory.
 *
 * A `file://` origin cannot load a module script, and the web subject is `src/parity-web.tsx` — the
 * real component, built by Vite — so the page needs an origin. This is the smallest one that has it.
 */
async function serveWeb() {
  const { createServer } = await import("node:http");
  const { extname } = await import("node:path");
  const dir = join(outRoot, "web");
  rmSync(dir, { force: true, recursive: true });
  await build({
    root: example,
    base: "./",
    logLevel: "warn",
    plugins: [react()],
    build: {
      outDir: dir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: { parity: join(example, "parity.html") } },
    },
  });
  stageAssets(dir);
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    const file = join(dir, path === "/" ? "parity.html" : path);
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    dir,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** One Playwright action for one step of the corpus's input grammar. */
async function driveStep(page, step) {
  if (step.t === "key") return void (await page.keyboard.press(step.key));
  if (step.t === "advance") return void (await page.waitForTimeout(step.ms));
  if (step.t === "wheel") {
    // A real wheel needs the pointer over the scroller first: Chromium routes it to the element
    // under the cursor, which is how the engine's `wheel` takes its position too.
    await page.mouse.move(step.x, step.y);
    await page.mouse.wheel(step.dx ?? 0, step.dy);
    // Chromium applies a wheel's scroll on the compositor, not in the event's own task: measured on
    // a `.stage-scroll` cell, `scrollTop` is still 0 when the wheel resolves and 140 two animation
    // frames later. The engine scrolls inside the event and re-renders, so a capture taken straight
    // after the wheel compares a scrolled frame against an unscrolled one — which is what the family
    // read as a 140 px wheel-routing difference. Wait for every scroll offset to stop moving.
    return void (await page.evaluate(async () => {
      const offsets = () =>
        [...document.querySelectorAll("*")].map((el) => el.scrollTop + el.scrollLeft).join(",");
      // Stability is only meaningful *after* the scroll has begun: the first two frames after the
      // wheel are both still 0, so a one-frame-stable test returns before anything moved. Four
      // frames of patience, then two consecutive identical reads, is the shortest wait that cannot
      // mistake "not started" for "settled".
      let last = offsets();
      let stable = 0;
      for (let frame = 0; frame < 30; frame += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const next = offsets();
        stable = frame >= 3 && next === last ? stable + 1 : 0;
        last = next;
        if (stable >= 2) return;
      }
    }));
  }
  if (step.t !== "pointer") return undefined;
  if (step.type === "move") return void (await page.mouse.move(step.x, step.y));
  if (step.type === "down") return void (await page.mouse.down());
  if (step.type === "up") return void (await page.mouse.up());
  if (step.type === "cancel") return void (await page.mouse.move(0, 0));
  return undefined;
}

/** Playwright steps for a cell's driver, at coordinates the caller measured on the engine's behalf. */
async function driveWeb(page, steps) {
  for (const step of steps) await driveStep(page, step);
}

/**
 * The motion bar's clock: 0, 25, 50, 75 and 100 % of a one-second animation, in milliseconds.
 *
 * One second is the duration Tailwind's own `animate-*` utilities use (`spin`, `ping` and `bounce`
 * are 1 s; `pulse` is 2 s, so it is sampled at half cycle and at full). The clock is *virtual* on
 * both subjects: the browser's animations are paused and given a `currentTime`, and the engine is
 * advanced by `drive.json`, so the two sides compare the same frame at the same time.
 */
const MOTION_SAMPLES = [0, 250, 500, 750, 1000];

/** The two subjects' handles, so a relaunched browser is the one every capture uses. */
let site;
let browser;

/**
 * One web capture, with one relaunch.
 *
 * A long run paints several hundred page loads, and a browser process that dies part-way through is
 * a flake in the harness rather than a parity finding: it is relaunched and the panel repeated
 * once. Only a second failure reaches the caller.
 */
async function webPanel(panel, options) {
  try {
    return await chromiumPanel(browser, site.base, panel, options);
  } catch (error) {
    console.warn(`tailwind-parity: relaunching Chromium after: ${error.message}`);
    try {
      await browser.close();
    } catch {
      // The process is gone; closing it again is not a new failure.
    }
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    return chromiumPanel(browser, site.base, panel, options);
  }
}

/** One panel in pinned headless Chromium, through the real component, optionally driven. */
async function chromiumPanel(browser, base, panel, { strip = false, drive = [], sample } = {}) {
  const context = await browser.newContext({
    viewport: { width: panel.width, height: panel.height },
    deviceScaleFactor: 1,
    hasTouch: panel.env?.touch === true,
    colorScheme: panel.env?.dark === true ? "dark" : "light",
    reducedMotion: panel.env?.reducedMotion === true ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  await page.goto(`${base}/parity.html?panel=${panel.index}${strip ? "&strip=1" : ""}`);
  // The two axes Playwright models as options are set here, in the same call as the two the context
  // takes, so nothing is applied twice. The DevTools route is deliberately not used: its feature
  // list is only honoured with an empty `media`, and that empty `media` disturbs the viewport
  // queries (`sm:`, `max-2xl:`) — measured, not assumed. The two axes neither interface can set
  // (`prefers-contrast: less`, `inverted-colors`) are named exemptions instead.
  await page.emulateMedia({
    colorScheme: panel.env?.dark === true ? "dark" : "light",
    reducedMotion: panel.env?.reducedMotion === true ? "reduce" : "no-preference",
    contrast: panel.env?.contrast === "more" ? "more" : "no-preference",
    forcedColors: panel.env?.forcedColors === true ? "active" : "none",
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  for (const steps of drive) await driveWeb(page, steps);
  if (sample !== undefined) {
    // A CSS animation is driven by the compositor, not by a JS timer, so the clock is moved through
    // its own interface: pause every animation the document has and pin it to the sample. The pin
    // lands in the style of the *next* frame, so the capture waits for two animation frames: without
    // that wait the screenshot is occasionally one sample stale (measured: the 500 ms capture of
    // `animate-ping` scored 0.5984 on one run and 0.9959 on the next, the first being the 0 ms
    // frame), which reads as an engine difference the engine does not have.
    await page.evaluate(async (at) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = at;
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, sample);
  }
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll("[data-n]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        n: Number(element.dataset.n),
        tag: element.tagName.toLowerCase(),
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      };
    }),
  );
  const png = PNG.sync.read(await page.screenshot());
  await context.close();
  return { boxes, png };
}

/** One panel in the crate's headless example, with the same device state and the same input. */
function cratePanel(panel, dir, { drive = [], sample } = {}) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(join(dir, "ui"), { recursive: true });
  // The same fonts and images the browser page gets, staged flat into `ui/`: without this the
  // engine resolves no `@font-face` and falls back to a system face, so the two subjects would be
  // measured with different text.
  stageAssets(dir);
  const tree = panel.tree;
  const fixture = { name: panel.id, size: [panel.width, panel.height], css: panel.css, tree };
  writeFileSync(join(dir, "batch.json"), JSON.stringify(ops(fixture, number(tree), "")));
  if (panel.env !== undefined) writeFileSync(join(dir, "env.json"), JSON.stringify(panel.env));
  const steps = drive.flat();
  // The engine's animation clock starts at zero in a fresh process, so one absolute advance is the
  // same sample the browser was pinned to.
  const timeline = sample === undefined ? steps : [...steps, { t: "advance", ms: sample }];
  if (timeline.length > 0) writeFileSync(join(dir, "drive.json"), JSON.stringify(timeline));
  const run = spawnSync(
    "cargo",
    [
      "run",
      "--release",
      "--quiet",
      "--example",
      "oracle",
      "--",
      dir,
      String(panel.width),
      String(panel.height),
      "1",
    ],
    // A panel the engine does not finish in two minutes is a result, not a reason to hang the
    // meter: it is reported against the cell's own stage and the run continues to the next panel.
    { cwd: crate, encoding: "utf8", timeout: 120_000 },
  );
  if (run.signal !== null || run.error?.code === "ETIMEDOUT") {
    return { refused: `the engine did not finish ${panel.id} within 120 s` };
  }
  if (run.status !== 0) {
    // A stage the engine refuses to build is a result, not a crash: every cell of this panel is
    // reported against the engine's own words, and the rest of the run still scores.
    return {
      refused: (run.stderr || run.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300),
    };
  }
  const rects = JSON.parse(readFileSync(join(dir, "rects.json"), "utf8"));
  const rgba = readFileSync(join(dir, "frame.rgba"));
  const png = new PNG({ width: panel.width, height: panel.height });
  rgba.copy(png.data);
  return { rects, png };
}

// -------------------------------------------------------------------------------------------------
// Measure.
// -------------------------------------------------------------------------------------------------

/**
 * SSIM per channel, the worst of the three.
 *
 * The corpus's bar is luminance SSIM, and luminance is blind to exactly the families this batch is
 * about: `grayscale(1)` maps `rgb(37,99,235)` to `rgb(96,96,96)`, whose luminance is 95.7 against
 * 95.7 — an identical frame by that measure and an obviously different one to a viewer. The colour
 * channels are measured too, and the *worst* of the four (R, G, B, luminance) is the cell's score.
 */
function channelSsim(a, b, offset) {
  const plane = (png) => {
    const values = new Float64Array(png.width * png.height);
    for (let i = 0; i < values.length; i++) values[i] = png.data[i * 4 + offset];
    return values;
  };
  return ssim(plane(a), plane(b), a.width, a.height);
}

/** The worst of luminance and the three colour channels. */
function matchScore(a, b) {
  let worst = ssim(luminance(a), luminance(b), a.width, a.height);
  for (const offset of [0, 1, 2]) worst = Math.min(worst, channelSsim(a, b, offset));
  return worst;
}

/** One cell's crop of a frame, as a PNG the sheets can show and the SSIM can read. */
function crop(png, box) {
  const width = Math.max(1, Math.round(box.w));
  const height = Math.max(1, Math.round(box.h));
  const left = Math.round(box.x);
  const top = Math.round(box.y);
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = ((top + y) * png.width + (left + x)) * 4;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        out.data[to + channel] = png.data[from + channel] ?? 0;
    }
  }
  return out;
}

/**
 * The region a cell is measured over: the probe's own box plus a margin for what escapes it (a
 * ring, an outline, a shadow), clamped inside the cell.
 *
 * The cell's whole 320x240 crop cannot see a dropped declaration: the probe is about 6 % of it, and
 * a missing 40-level colour change still scores SSIM 0.987 there. The probe's own box is where the
 * unit lands.
 */
const PROBE_PAD = 20;
/** The label band at the top of a cell: the region never reaches into it, so no region holds glyphs. */
const LABEL_H = 26;

function measureRegion(cellBox, probeBox) {
  if (probeBox === undefined) return cellBox;
  // A unit that removes the probe's box — `display: none`, `hidden`, `contents`, `sr-only`'s
  // `clip-path` — reports a zero-area rect at the viewport origin. Cropping that sliver lands in the
  // first cell's label band and compares glyphs, which measured 0.0 for a unit that is right on both
  // subjects. The cell's own stage is what such a unit is measured over.
  if (probeBox.w < 1 || probeBox.h < 1)
    return { x: cellBox.x, y: cellBox.y + LABEL_H, w: cellBox.w, h: cellBox.h - LABEL_H };
  // A probe scrolled out of its cell (`sticky`, `scroll-*`, `snap-*`: the driver's wheel moves it
  // above the cell's own box) leaves a region clamped to a sliver, and an SSIM over one row of
  // pixels is `NaN` — which the report printed as 0.0 for all 31 scroll cells. When nothing of the
  // probe is inside the cell, the cell's stage is what the unit changed.
  const stage = { x: cellBox.x, y: cellBox.y + LABEL_H, w: cellBox.w, h: cellBox.h - LABEL_H };
  const inside =
    probeBox.y + probeBox.h > stage.y &&
    probeBox.y < stage.y + stage.h &&
    probeBox.x + probeBox.w > stage.x &&
    probeBox.x < stage.x + stage.w;
  if (!inside) return stage;
  const left = Math.max(cellBox.x, probeBox.x - PROBE_PAD);
  const top = Math.max(cellBox.y + LABEL_H, probeBox.y - PROBE_PAD);
  const right = Math.min(cellBox.x + cellBox.w, probeBox.x + probeBox.w + PROBE_PAD);
  const bottom = Math.min(cellBox.y + cellBox.h, probeBox.y + probeBox.h + PROBE_PAD);
  return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
}

/** The SSIM of one cell's measured region between the two subjects. */
function cellScore(cell, web, native) {
  const cellBox = web.boxes.find((candidate) => candidate.n === cell.first);
  if (cellBox === undefined) return undefined;
  const probeBox = web.boxes.find((candidate) => candidate.n === cell.probe);
  const region = measureRegion(cellBox, probeBox);
  const west = crop(web.png, region);
  const east = crop(native.png, region);
  return {
    cellBox,
    region,
    score: matchScore(west, east),
  };
}

/**
 * The motion cells that no sample can tell from the class-less arm, with the counterfactual of the
 * sample that came closest.
 */
function blindCells(panel, samples) {
  const blind = new Map();
  for (const cell of panel.cells) {
    const scores = samples.map((sample) => sample.vacuous.get(cell.unit));
    if (scores.some((score) => score === undefined)) continue;
    blind.set(cell.unit, Math.max(...scores.map((score) => score ?? 0)));
  }
  return blind;
}

/**
 * The motion bar: every cell at each step of the clock, on both subjects.
 *
 * A keyframe animation cannot be proven by one frame — two renderers can agree at rest and disagree
 * halfway — so a motion panel is captured at 0, 25, 50, 75 and 100 % and a cell passes only when
 * every sample passes both bars. The report keeps the *worst* sample, which is the one to read.
 *
 * The vacuity arm is the exception to "every sample": whether a cell can distinguish a dropped
 * declaration at all is a fact about the clock, not about one instant. `animate-ping` rests at the
 * probe's own look at 0 % — its `from` keyframe is the element's style — and is only visibly
 * scaled and faded part-way through, so a per-sample test would fail every keyframe animation that
 * starts from the element's own style, which is most of them. The cell is a scene defect only when
 * *no* sample tells it from the class-less arm.
 */
async function measureMotion(panel, dir, drive) {
  const samples = [];
  for (const sample of MOTION_SAMPLES) {
    const web = await webPanel(panel, { drive, sample });
    const native = cratePanel(panel, join(dir, `native-t${sample}`), { drive, sample });
    if (native.refused !== undefined) {
      return panel.cells.map((cell) => ({
        ...cell,
        pass: false,
        why: `the engine refused this stage: ${native.refused}`,
      }));
    }
    const stripped = await webPanel(panel, { drive, strip: true, sample });
    samples.push({ sample, web, native, vacuous: vacuityOf(panel, web, stripped) });
    if (sample === MOTION_SAMPLES.at(-1)) {
      writeFileSync(join(dir, "web", "frame.png"), PNG.sync.write(web.png));
      writeFileSync(join(dir, "native", "frame.png"), PNG.sync.write(native.png));
    }
  }

  const blind = blindCells(panel, samples);
  const cells = new Map();
  for (const { sample, web, native, vacuous } of samples) {
    for (const cell of comparePanel(panel, web, native, vacuous, blind)) {
      const seen = cells.get(cell.unit);
      const one = { at: sample, ssim: cell.ssim, pass: cell.pass };
      if (seen === undefined) {
        cells.set(cell.unit, { ...cell, samples: [one] });
        continue;
      }
      seen.samples.push(one);
      seen.pass = seen.pass && cell.pass;
      if (cell.ssim < seen.ssim) {
        Object.assign(seen, { ssim: cell.ssim, edgeMisses: cell.edgeMisses, why: cell.why });
      }
    }
  }
  return [...cells.values()];
}

/**
 * Compare one panel per cell: geometry on the cell's elements, pixels on the probe's region.
 *
 * A cell that names an exemption is not evidence — the variant never fires on either subject — so
 * it is counted separately and never as a pass. A cell whose unit class changes nothing (the vacuity
 * arm) is a scene defect and fails, because a cell that proves nothing must not lift the score.
 */
function comparePanel(panel, web, native, vacuous, blind = vacuous) {
  return panel.cells.map((cell) => {
    if (cell.exempt !== undefined) {
      // A *pending* exemption stays in the denominator: it is an unproven unit, not a pass, and the
      // family PRD that lands its device input or control removes it. A *permanent* one is out of
      // the denominator, because the batch's own decisions say the rule is inactive on both
      // subjects — no measurement of it can ever distinguish a correct engine from a wrong one.
      return {
        ...cell,
        exempt: true,
        permanent: cell.exempt.permanent === true,
        pass: false,
        why: `exempt: ${cell.exempt.why} (${cell.exempt.owner})`,
      };
    }
    if (native.refused !== undefined) {
      return { ...cell, pass: false, why: `the engine refused this stage: ${native.refused}` };
    }
    const measured = cellScore(cell, web, native);
    if (measured === undefined) return { ...cell, pass: false, why: "no cell box in Chromium" };
    const elements = web.boxes.filter(
      (candidate) => candidate.n >= cell.first && candidate.n <= cell.last,
    );
    // A subject that reports pixels only (the desktop host) leaves the geometry bar unmeasured;
    // the report says so rather than treating "no boxes" as "every box agrees".
    const geometry =
      native.rects === undefined ? undefined : edgeMisses(elements, native.rects, EDGE_PX);
    const misses = geometry ?? [];
    const min = cell.glyphs ? SSIM_MIN_GLYPHS : SSIM_MIN;
    if (blind.has(cell.unit)) {
      return {
        ...cell,
        ...measured,
        edgeMisses: misses,
        ssim: Number(measured.score.toFixed(4)),
        ssimMin: min,
        counterfactual: blind.get(cell.unit),
        pass: false,
        why: `does not discriminate: dropping the class leaves the region at ${blind.get(cell.unit)}, at or above the ${min} bar`,
      };
    }
    return {
      unit: cell.unit,
      class: cell.class,
      label: cell.label,
      owner: cell.owner,
      group: cell.group,
      box: cell.box ?? measured.cellBox,
      region: measured.region,
      edgeMisses: misses,
      geometryMeasured: geometry !== undefined,
      ssim: Number(measured.score.toFixed(4)),
      ssimMin: min,
      pass: misses.length === 0 && measured.score >= min,
    };
  });
}

/**
 * Cells that do not discriminate: dropping the unit class leaves the measured region *at or above
 * the cell's own bar*.
 *
 * Exact equality is too weak a test. A cell that changes by less than the bar cannot tell a correct
 * engine from one that dropped the declaration — `drop-shadow-lg` scores 0.9982 with and without its
 * class, above the 0.99 bar — so counting it as a pass inflates the score. The bar the cell is judged
 * by is the bar its probe must clear.
 */
function vacuityOf(panel, withClass, stripped) {
  const useless = new Map();
  for (const cell of panel.cells) {
    if (cell.exempt !== undefined) continue;
    const cellBox = withClass.boxes.find((candidate) => candidate.n === cell.first);
    if (cellBox === undefined) continue;
    const probeBox = withClass.boxes.find((candidate) => candidate.n === cell.probe);
    const region = measureRegion(cellBox, probeBox);
    const a = crop(withClass.png, region);
    const b = crop(stripped.png, region);
    const score = matchScore(a, b);
    const min = cell.glyphs ? SSIM_MIN_GLYPHS : SSIM_MIN;
    // Layout counts too: `sticky` moves its box 48 px when the class goes, which the pixel bar over
    // a mostly-empty region can miss. A cell discriminates if either bar would catch the drop.
    // Only this cell's own elements: the strip arm removes every probe's class at once, so a
    // neighbour that moves would otherwise mark this cell as discriminating.
    const moved = withClass.boxes
      .filter((box) => box.n >= cell.first && box.n <= cell.last)
      .some((box) => {
        const other = stripped.boxes.find((candidate) => candidate.n === box.n);
        return (
          other === undefined ||
          Math.max(
            Math.abs(box.x - other.x),
            Math.abs(box.y - other.y),
            Math.abs(box.w - other.w),
            Math.abs(box.h - other.h),
          ) > EDGE_PX
        );
      });
    if (score >= min && !moved) useless.set(cell.unit, Number(score.toFixed(4)));
  }
  return useless;
}

/** Steps for a cell's driver, with the probe's centre as the pointer position. */
function driverFor(cell, boxes) {
  if (cell.drive === undefined || cell.probe === undefined) return [];
  const box = boxes.find((candidate) => candidate.n === cell.probe);
  if (box === undefined) return [];
  const x = Math.round(box.x + box.w / 2);
  const y = Math.round(box.y + box.h / 2);
  return cell.drive.map((step) => {
    if (step.at !== "probe") return step;
    if (step.t === "wheel") return { t: "wheel", x, y, dx: step.dx ?? 0, dy: step.dy };
    return { t: "pointer", type: step.type, x, y };
  });
}

// -------------------------------------------------------------------------------------------------
// Contact sheets: WEB left, NATIVE right, one row per cell, labels burned in large.
// -------------------------------------------------------------------------------------------------

const slug = (value) => value.replaceAll(/[^a-zA-Z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "");
const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function writeSheet(browser, panel, cells, dir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const rows = cells.map((cell) => {
    const name = `${panel.id}-${slug(cell.class)}`;
    const webPath = join(outDir, `${name}-web.png`);
    const nativePath = join(outDir, `${name}-native.png`);
    writeFileSync(
      webPath,
      PNG.sync.write(crop(PNG.sync.read(readFileSync(join(dir, "web", "frame.png"))), cell.box)),
    );
    writeFileSync(
      nativePath,
      PNG.sync.write(crop(PNG.sync.read(readFileSync(join(dir, "native", "frame.png"))), cell.box)),
    );
    const verdict = cell.pass
      ? `meter: PASS  (ssim ${cell.ssim} >= ${cell.ssimMin}, 0 edge misses)`
      : `meter: FAIL  (ssim ${cell.ssim} < ${cell.ssimMin}, ${cell.edgeMisses.length} edge misses)`;
    return `<section><h2>${escapeHtml(cell.class)}</h2><p class="unit">${escapeHtml(cell.unit)}</p><p>${verdict}</p>
      <div class="pair"><figure><figcaption>WEB</figcaption><img src="file://${webPath}"></figure>
      <figure><figcaption>NATIVE</figcaption><img src="file://${nativePath}"></figure></div></section>`;
  });
  const html = join(outDir, `sheet-${panel.id}.html`);
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;padding:20px;background:#111;color:#eee;font:16px system-ui}
      h1{font-size:30px;margin:0 0 8px}section{margin:26px 0;border-top:2px solid #444;padding-top:14px}
      h2{font-size:32px;margin:0}p{margin:2px 0;color:#b0b0b8}p.unit{color:#7dd3fc}
      .pair{display:flex;gap:18px;margin-top:10px}figure{margin:0}
      figcaption{font:bold 26px system-ui;color:#7dd3fc;letter-spacing:2px}
      img{image-rendering:pixelated;width:640px;height:480px;border:1px solid #555}</style>
      <h1>${escapeHtml(panel.owner)} / ${escapeHtml(panel.group)} — WEB vs NATIVE</h1>
      ${rows.join("\n")}`,
  );
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const tab = await context.newPage();
  await tab.goto(`file://${html}`);
  const shot = join(outDir, `sheet-${panel.id}.png`);
  await tab.screenshot({ path: shot, fullPage: true });
  await context.close();
  return shot;
}

/**
 * A panel the host subject cannot stage, as a reported refusal.
 *
 * The host has seams for all three of these — `media(dark, reducedMotion)` and a fixed CSS clock
 * (`TN_CSS_UI_FIXED_STEP_MS`, one playtest tick per step) are wired through the playtest host — but
 * this subject does not drive them yet, and a capture taken without the input a cell asks for is a
 * false failure rather than a parity finding. So each is refused by name until the driver reaches
 * it.
 */
function refusedOnHost(panel) {
  if (panel.env !== undefined) {
    return {
      refused: `the host subject does not drive the device descriptor yet: ${JSON.stringify(panel.env)}`,
    };
  }
  if (panel.cells.some((cell) => (cell.drive ?? []).length > 0)) {
    return { refused: "the host subject does not drive pointer, key or wheel input yet" };
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------------
// CLI.
// -------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const wants = { family: option("family"), group: option("group"), sheet: option("sheet") };
const selected = (panel) =>
  (wants.family === undefined || panel.owner === wants.family) &&
  (wants.group === undefined || panel.group === wants.group);

/**
 * Which native subject scores this run.
 *
 * The crate's headless `oracle` example and the real desktop host paint through the same crate; the
 * host is what proves the integration (host ABI, stylesheet packaging, the UI clock). It cannot pin
 * an animation's clock and it reports no per-node box, so `--host` refuses a motion panel by name
 * and reports the geometry bar as unmeasured instead of scoring those on a weaker bar.
 */
const hostSubject = flag("host");

const derived = await deriveUnits();
const scene = await buildScene(derived);
const cells = scene.panels.flatMap((panel) => panel.cells);

// --- --check: the build gate ----------------------------------------------------------------

if (flag("check")) {
  const problems = [];
  const expected = `${JSON.stringify(scene, null, 0)}\n`;
  const committed = existsSync(sceneFile) ? readFileSync(sceneFile, "utf8") : "";
  if (committed !== expected) problems.push("the committed scene is stale: run --write");

  const unowned = cells.filter((cell) => cell.owner === undefined || cell.owner === "");
  if (unowned.length > 0) problems.push(`${unowned.length} units have no owner PRD`);
  const counts = new Map();
  for (const cell of cells) counts.set(cell.unit, (counts.get(cell.unit) ?? 0) + 1);
  const duplicated = [...counts].filter(([, n]) => n > 1);
  if (duplicated.length > 0) problems.push(`${duplicated.length} units have more than one cell`);
  if (cells.length !== scene.total)
    problems.push(`scene has ${cells.length} cells for ${scene.total} units`);

  // Every probe class must be a class Tailwind emits: a misspelt arbitrary variant would otherwise
  // sit in the scene proving nothing while looking like coverage.
  const uncompilable = cells.filter((cell) => {
    const css = derived.classCss.get(cell.class);
    return cell.class.includes(":")
      ? (derived.design.candidatesToCss([cell.class])[0] ?? "") === ""
      : css === undefined;
  });
  if (uncompilable.length > 0) {
    problems.push(`${uncompilable.length} probes Tailwind does not compile:`);
    for (const cell of uncompilable.slice(0, 30)) problems.push(`    ${cell.class}`);
  }

  if (!flag("no-vacuity")) {
    rmSync(outRoot, { force: true, recursive: true });
    site = await serveWeb();
    browser = await chromium.launch({ args: CHROMIUM_ARGS });
    try {
      const vacuousCells = [];
      for (const panel of scene.panels.filter(selected)) {
        if (panel.cells.every((cell) => cell.exempt !== undefined)) continue;
        // The driver's coordinates come from the same measurement the meter hands the engine.
        const probeBoxes = (await webPanel(panel)).boxes;
        const drive = panel.cells.map((cell) => driverFor(cell, probeBoxes));
        const withClass = await webPanel(panel, { drive });
        const without = await webPanel(panel, { drive, strip: true });
        for (const entry of vacuityOf(panel, withClass, without)) vacuousCells.push(entry);
      }
      if (vacuousCells.length > 0) {
        problems.push(
          `${vacuousCells.length} cells do not discriminate (dropping the unit class stays at or above the cell's bar)`,
        );
        for (const [unit, score] of vacuousCells.slice(0, 60))
          problems.push(`    ${unit}  counterfactual ${score}`);
        if (vacuousCells.length > 60) problems.push(`    ... and ${vacuousCells.length - 60} more`);
      }
    } finally {
      await browser.close();
      await site.close();
    }
  }

  console.log(
    `tailwind-parity --check: ${scene.total} units (${scene.utilityUnits} utility, ${scene.variantUnits} variant), ${unowned.length} unowned, ${scene.exemptions.length} named exemptions, ${scene.panels.length} panels`,
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`TN_PARITY_CHECK ${problem}`);
    process.exit(1);
  }
  console.log("tailwind-parity --check: ok");
  process.exit(0);
}

// --- --write ---------------------------------------------------------------------------------

if (flag("write")) {
  writeFileSync(sceneFile, `${JSON.stringify(scene, null, 0)}\n`);
  console.log(
    `tailwind-parity --write: ${scene.total} units in ${scene.panels.length} panels -> ${sceneFile}`,
  );
  process.exit(0);
}

// --- the meter --------------------------------------------------------------------------------

if (wants.family === undefined && wants.group === undefined && wants.sheet === undefined) {
  // A plain run keeps the committed scene current: the meter always scores what Tailwind says.
  writeFileSync(sceneFile, `${JSON.stringify(scene, null, 0)}\n`);
}

const panels = scene.panels.filter(selected);
if (panels.length === 0) {
  console.error(`TN_PARITY_NO_PANEL no panel matches ${wants.family ?? "*"}/${wants.group ?? "*"}`);
  process.exit(1);
}

/** Byte equality: a subject that repaints differently twice cannot be compared at all. */
const same = (a, b) => a.length === b.length && Buffer.compare(a, b) === 0;
const MOTION = /animation|transition|@starting-style/u;

rmSync(outRoot, { force: true, recursive: true });
if (hostSubject) prepareHostOut();
site = await serveWeb();
browser = await chromium.launch({ args: CHROMIUM_ARGS });
const report = [];
try {
  for (const panel of panels) {
    const dir = join(outRoot, panel.id);
    mkdirSync(join(dir, "web"), { recursive: true });
    mkdirSync(join(dir, "native"), { recursive: true });
    const motion = MOTION.test(panel.css);
    const probeBoxes = (await webPanel(panel)).boxes;
    const drive = panel.cells.map((cell) => driverFor(cell, probeBoxes));
    let measured;
    let vacuous = new Map();
    if (motion && hostSubject) {
      measured = panel.cells.map((cell) => ({
        ...cell,
        pass: false,
        why:
          "the host subject cannot pin an animation clock yet: the host's input seam has no " +
          "advance, so a motion panel is refused by name rather than scored at rest",
      }));
    } else if (motion) {
      measured = await measureMotion(panel, dir, drive);
    } else {
      const web = await webPanel(panel, { drive });
      const native = hostSubject
        ? (refusedOnHost(panel) ?? hostPanel(panel))
        : cratePanel(panel, join(dir, "native"), { drive });
      // Two capture runs per side: a subject that does not paint the same frame twice cannot be
      // compared with one that does, and a difference would otherwise read as a parity gap.
      const webAgain = await webPanel(panel, { drive });
      const nativeAgain = cratePanel(panel, join(dir, "native-again"), { drive });
      if (!same(web.png.data, webAgain.png.data)) {
        throw new Error(
          `TN_PARITY_NONDETERMINISTIC Chromium painted ${panel.id} twice differently`,
        );
      }
      if (native.refused === undefined && !same(native.png.data, nativeAgain.png.data)) {
        throw new Error(
          `TN_PARITY_NONDETERMINISTIC the engine painted ${panel.id} twice differently`,
        );
      }
      writeFileSync(join(dir, "web", "frame.png"), PNG.sync.write(web.png));
      if (native.refused === undefined) {
        writeFileSync(join(dir, "native", "frame.png"), PNG.sync.write(native.png));
      }
      // The vacuity arm, in the meter's own run: a cell whose unit class changes nothing is a scene
      // defect, so it fails here rather than counting as a pass the ratchet would then protect.
      const stripped = await webPanel(panel, { drive, strip: true });
      vacuous = vacuityOf(panel, web, stripped);
      measured = comparePanel(panel, web, native, vacuous);
    }
    report.push(...measured);
    if (wants.sheet === undefined) {
      console.log(
        `${panel.owner}/${panel.group} ${panel.id}: ${measured.filter((c) => c.pass).length}/${measured.length}${
          vacuous.size > 0 ? ` (${vacuous.size} do not discriminate)` : ""
        }`,
      );
    }
  }
} finally {
  await browser.close();
  await site.close();
}

const passed = report.filter((cell) => cell.pass).length;
const denominator = report.filter((cell) => cell.permanent !== true).length;
const useless = report.filter((cell) => (cell.why ?? "").startsWith("does not discriminate"));
const exemptCount = report.filter((cell) => cell.exempt === true).length;
const refusedCount = report.filter((cell) =>
  (cell.why ?? "").startsWith("the engine refused"),
).length;
const percent = denominator === 0 ? 0 : Math.round((passed / denominator) * 1000) / 10;
const permanentCount = report.length - denominator;
writeFileSync(
  join(outRoot, hostSubject ? "report-host.json" : "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
// Every cell is in the denominator. An exemption is an unproven unit, and a cell that does not
// discriminate is a scene defect: neither may be reported as coverage.
console.log(
  `tailwind-parity${hostSubject ? " (desktop host, pixels only)" : ""}: ${passed}/${denominator} (${percent} %)  [${useless.length} do not discriminate, ${exemptCount - permanentCount} exempt, ${permanentCount} permanently inactive, ${refusedCount} refused]`,
);

if (wants.sheet !== undefined) {
  const outDir = join(homedir(), "Downloads", "tailwind-parity", wants.sheet);
  const browser2 = await chromium.launch({ args: CHROMIUM_ARGS });
  try {
    for (const panel of panels) {
      const measured = report.filter((entry) =>
        panel.cells.some((cell) => cell.unit === entry.unit),
      );
      if (measured.length === 0) continue;
      console.log(
        `sheet ${await writeSheet(browser2, panel, measured, join(outRoot, panel.id), outDir)}`,
      );
    }
  } finally {
    await browser2.close();
  }
}

if (flag("floor")) {
  if (wants.family !== undefined || wants.group !== undefined) {
    // A floor written from a subset would make the next whole-scene ratchet protect only that
    // subset, so `--floor` takes the whole scene or nothing.
    console.error("TN_PARITY_FLOOR: --floor needs the whole scene, not --family/--group");
    process.exit(1);
  }
  // The ratchet's baseline: the units that pass today, so a later change that turns one of them red
  // is a red gate even while the batch's other families are still open.
  const units = report.filter((cell) => cell.pass).map((cell) => cell.unit);
  writeFileSync(floorFile, `${JSON.stringify({ passed, units }, null, 2)}\n`);
  console.log(`tailwind-parity --floor: ${passed} units in ${floorFile}`);
}

if (flag("ratchet")) {
  const floor = existsSync(floorFile)
    ? JSON.parse(readFileSync(floorFile, "utf8"))
    : { passed: 0, units: [] };
  // A filtered run scores a subset, so comparing it with the global floor is meaningless in both
  // directions: it would always look like a regression.
  if (wants.family !== undefined || wants.group !== undefined) {
    console.error("TN_PARITY_RATCHET: --ratchet needs the whole scene, not --family/--group");
    process.exit(1);
  }
  if (passed < floor.passed) {
    console.error(`TN_PARITY_RATCHET ${passed} units pass, the floor is ${floor.passed}`);
    process.exit(1);
  }
  for (const unit of floor.units ?? []) {
    const cell = report.find((candidate) => candidate.unit === unit);
    if (cell === undefined) {
      // A floor unit that is gone has been renamed, re-owned or deleted: that fails closed, because
      // a ratchet that silently forgets a unit protects nothing.
      console.error(`TN_PARITY_RATCHET ${unit} is in the floor but not in this run`);
      process.exit(1);
    }
    if (!cell.pass) {
      console.error(`TN_PARITY_RATCHET ${unit} used to pass and now fails`);
      process.exit(1);
    }
  }
  console.log(`tailwind-parity --ratchet: ${passed} >= ${floor.passed}`);
}

// A plain run reports the score; `--ratchet` is the gate, so an unfinished family is not a red
// build. Only a subject that could not be measured fails here.
process.exit(0);
