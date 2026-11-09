import { type ReactElement, createElement } from "react";
import scene from "./tailwind-parity.scene.json";

/**
 * The Tailwind parity scene: one panel of the generated corpus, rendered as React.
 *
 * The browser page (`src/parity-web.tsx`) and the native entry mount this same component over the
 * same `tailwind-parity.scene.json`, which `corpus/tailwind-parity.mjs` writes from Tailwind's own
 * design system. Nothing here decides a cell's look: the panel's stylesheet is Tailwind's compiled
 * output and the tree is the corpus data, so a difference between the two renderers is a difference
 * in the engine, never in what was asked for.
 *
 * `stripProbeClass` is the vacuity guard's arm: it renders the panel with every probe class removed,
 * so a cell whose crop does not change is a cell whose class proves nothing.
 */
export interface ITailwindParityProps {
  /** Which generated panel to mount. */
  readonly panel: number;
  /** Render every probe without its unit class (the vacuity guard's second arm). */
  readonly stripProbeClass?: boolean;
}

interface ISceneNode {
  readonly tag?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ISceneNode[];
  readonly text?: string;
  readonly n?: number;
}

interface IScenePanel {
  readonly id: string;
  readonly owner: string;
  readonly group: string;
  readonly width: number;
  readonly height: number;
  readonly css: string;
  readonly tree: readonly ISceneNode[];
}

/** React spells two of the corpus's attributes differently; the rest cross as written. */
const REACT_ATTR: Readonly<Record<string, string>> = { class: "className", for: "htmlFor" };

/**
 * Attributes whose *presence* is their value, which React does not render from `""`.
 *
 * A DOM boolean attribute is true when it is there: `<button disabled>` is a disabled button, and
 * the corpus spells that `disabled: ""` the way HTML does. React treats `disabled: ""` as false and
 * omits the attribute, so a staged `disabled:`/`inert:`/`checked:` control reached the browser
 * enabled and every one of those variants measured "does nothing" — while the engine, which takes
 * the attribute as given, painted them.
 */
const BOOLEAN_ATTRS = new Set(["disabled", "checked", "selected", "open", "inert"]);

/**
 * A probe's class list is `probe <contrast class> <unit class>`: the vacuity guard drops the last
 * token, which is the one unit being measured, and keeps the contrast class it wins against.
 */
const PROBE = /^probe(\s|$)/u;
const stripUnitClass = (value: string): string => {
  const parts = value.split(/\s+/u);
  parts.pop();
  return parts.join(" ");
};

export const panels = scene.panels as unknown as readonly IScenePanel[];

/** One panel's stylesheet, for the browser entry to install before the first paint. */
export function panelCss(panel: number): string {
  const data = panels[panel];
  if (data === undefined) throw new Error(`TN_PARITY_NO_PANEL: ${panel} of ${panels.length}`);
  return data.css;
}

function render(node: ISceneNode, strip: boolean, key: number): ReactElement | string {
  if (node.text !== undefined) return node.text;
  const props: Record<string, unknown> = { key };
  if (node.n !== undefined) props["data-n"] = node.n;
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    props[REACT_ATTR[name] ?? name] =
      BOOLEAN_ATTRS.has(name) && value === ""
        ? true
        : strip && PROBE.test(value)
          ? stripUnitClass(value)
          : value;
  }
  return createElement(
    node.tag ?? "div",
    props,
    (node.children ?? []).map((child, index) => render(child, strip, index)),
  );
}

export function TailwindParity({
  panel,
  stripProbeClass = false,
}: ITailwindParityProps): ReactElement {
  const data = panels[panel];
  if (data === undefined) throw new Error(`TN_PARITY_NO_PANEL: ${panel} of ${panels.length}`);
  return <>{data.tree.map((node, index) => render(node, stripProbeClass, index))}</>;
}
