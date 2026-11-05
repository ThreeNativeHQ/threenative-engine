import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorSession } from "../src/editor/app/session.js";
import { optionNumber, optionSelect, renderOptions } from "../src/editor/app/tools.js";

/** A DOM node stub: the tools build controls with createElement, setAttribute and append only. */
class StubNode {
  readonly attributes = new Map<string, string>();
  children: (StubNode | string)[] = [];
  checked = false;
  selected = false;
  value = "";
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "value") this.value = value;
  }
  append(...nodes: (StubNode | string)[]): void {
    this.children.push(...nodes);
  }
  add(node: StubNode | string): void {
    this.children.push(node);
  }
  replaceChildren(...nodes: (StubNode | string)[]): void {
    this.children = nodes;
  }
}

class StubOption extends StubNode {
  constructor(text: string, value: string, _defaultSelected = false, selected = false) {
    super("option");
    this.value = value;
    this.selected = selected;
    this.children.push(text);
  }
}

const controls = new Map<string, StubNode>();

/** The scatter tool's option panel, built over a project palette that has no "pine". */
function scatterPanel(palette: readonly string[], asset: string) {
  const panel = new StubNode("div");
  controls.set("tool-options", panel);
  vi.stubGlobal("Option", StubOption);
  vi.stubGlobal("document", {
    createElement: (tag: string) => new StubNode(tag),
    getElementById: (id: string) => controls.get(id) ?? null,
  });
  const session = {
    active: "scatter",
    options: { scatter: { asset, count: 180, erase: false } },
    view: { propAssets: () => palette },
  } as unknown as EditorSession;
  // The real session binds these to itself; renderOptions calls them as c.optionSelect(...).
  Object.assign(session, {
    optionSelect: optionSelect.bind(null, session),
    optionNumber: optionNumber.bind(null, session),
  });
  renderOptions(session);
  const select = find(panel, "select");
  return { session, select };
}

function find(node: StubNode, tag: string): StubNode {
  if (node.tag === tag) return node;
  for (const child of node.children) {
    if (child instanceof StubNode) {
      const hit = findOptional(child, tag);
      if (hit) return hit;
    }
  }
  throw new Error(`The panel built no <${tag}>`);
}

function findOptional(node: StubNode, tag: string): StubNode | undefined {
  if (node.tag === tag) return node;
  for (const child of node.children)
    if (child instanceof StubNode) {
      const hit = findOptional(child, tag);
      if (hit) return hit;
    }
  return undefined;
}

function shown(select: StubNode): string {
  const chosen = select.children.filter(
    (child): child is StubNode => child instanceof StubNode && child.selected,
  );
  if (chosen.length !== 1) throw new Error(`The picker selected ${chosen.length} options`);
  return chosen[0]?.value ?? "";
}

afterEach(() => {
  controls.clear();
  vi.unstubAllGlobals();
});

describe("editor scatter asset picker", () => {
  it("scatters the asset the picker shows when the palette lacks the default", () => {
    const { session, select } = scatterPanel(["oak", "boulder"], "pine");
    expect(shown(select)).toBe("oak");
    expect(session.options.scatter.asset).toBe("oak");
  });

  it("keeps an asset the project still offers", () => {
    const { session, select } = scatterPanel(["pine", "boulder"], "pine");
    expect(shown(select)).toBe("pine");
    expect(session.options.scatter.asset).toBe("pine");
  });
});
