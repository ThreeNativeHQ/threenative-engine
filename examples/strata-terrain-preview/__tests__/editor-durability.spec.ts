import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validatePlaytestScenario } from "../../../packages/playtest/src/scenario.js";
import { changed, installSaveQueue } from "../../../packages/terrain/src/editor/app/evaluation.js";
import type { EditorSession } from "../../../packages/terrain/src/editor/app/session.js";
import { TerrainEditorDocument } from "../../../packages/terrain/src/editor/server.js";
import { Terrain } from "../../../packages/terrain/src/index.js";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { installStaleWrites } from "../scripts/fixtures/editor-conflict.js";

function session() {
  const terrain = new Terrain({ size: 32, resolution: 17, seed: 73 });
  const path = join(makeTempDirSync("editor-durability-"), "world.json");
  writeFileSync(path, JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
  const authority = new TerrainEditorDocument(path);
  class DomNode {
    children: (DomNode | string)[] = [];
    attributes: Record<string, string> = {};
    hidden = false;
    style = { cssText: "" };
    dataset: Record<string, string> = {};
    onclick?: () => void;
    constructor(readonly tagName: string) {}
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
      if (key === "id") nodes.set(value, this);
    }
    append(...children: (DomNode | string)[]) {
      this.children.push(...children);
    }
    replaceChildren(...children: (DomNode | string)[]) {
      this.children = children;
    }
    get textContent(): string {
      return this.children
        .map((node) => (typeof node === "string" ? node : node.textContent))
        .join("");
    }
    set textContent(text: string) {
      this.children = [text];
    }
    contains(node: unknown): boolean {
      return (
        node === this ||
        this.children.some((child) => typeof child !== "string" && child.contains(node))
      );
    }
    focus() {
      dom.activeElement = this;
    }
  }
  const nodes = new Map<string, DomNode>();
  nodes.set("save-status", new DomNode("span"));
  const dom = {
    body: new DomNode("body"),
    activeElement: null as DomNode | null,
    getElementById: (id: string) => nodes.get(id),
    createElement: (tag: string) => new DomNode(tag),
  };
  vi.stubGlobal("document", dom);
  const c = {
    terrain,
    saved: authority.snapshot(),
    revision: authority.snapshot().revision,
    loading: false,
    saving: false,
    disposed: false,
    renderLayers: vi.fn(),
    renderCameras: vi.fn(),
    renderEnvironment: vi.fn(),
    renderAssets: vi.fn(),
    syncAssets: vi.fn(),
    build: vi.fn(),
    toast: vi.fn(),
    view: { setDocument: vi.fn() },
    commit: async (input: unknown) => authority.commit(input),
    getSnapshot: async () => authority.snapshot(),
  } as unknown as EditorSession;
  installSaveQueue(c);
  terrain.subscribe(() => void changed(c));
  return { c, authority, path, nodes, dom };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("editor save integration", () => {
  it("persists two actual strokes 50 ms apart while the first write is pending", async () => {
    vi.useFakeTimers();
    const { c, path } = session();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = c.commit;
    c.commit = async (input) => {
      await gate;
      return commit(input);
    };
    c.terrain.sculpt({ id: "first", points: [[0, 0]], radius: 4, strength: 1 });
    await vi.advanceTimersByTimeAsync(50);
    c.terrain.sculpt({ id: "second", points: [[2, 2]], radius: 4, strength: 1 });
    release();
    await c.saveQueue.flush();
    await Promise.resolve();
    const disk = JSON.parse(readFileSync(path, "utf8"));
    expect(disk.recipe.layers.map((layer: { id: string }) => layer.id)).toEqual([
      "first",
      "second",
    ]);
    expect(c.terrain.layers.map((layer) => layer.id)).toEqual(["first", "second"]);
    expect(c.toast).not.toHaveBeenCalled();
  });
  it("renders a real stale-revision 409 in the not-saved list and retries through its button", async () => {
    const { c, authority, nodes, dom } = session();
    c.commit = async (input) => authority.commit({ ...input, baseRevision: "stale" });
    c.terrain.sculpt({ id: "refused", points: [[0, 0]], radius: 4, strength: 1 });
    await c.saveQueue.flush();
    const panel = nodes.get("not-saved");
    expect(panel?.hidden).toBe(false);
    expect(panel?.textContent).toContain("Not saved");
    expect(panel?.textContent).toContain("Stale base revision");
    expect(c.terrain.layers.map((layer) => layer.id)).toEqual(["refused"]);
    const id = c.saveQueue.unsent[0]?.id;
    const retry = nodes.get(`retry-${id}`);
    expect(retry?.tagName).toBe("button");
    expect(retry?.attributes.type).toBe("button");
    expect(nodes.get(`discard-${id}`)?.tagName).toBe("button");
    expect(c.toast).toHaveBeenCalledWith(expect.stringContaining("Stale base revision"), true);
    retry?.focus();
    c.commit = async (input) => authority.commit(input);
    retry?.onclick?.();
    await c.saveQueue.flush();
    expect(authority.snapshot().document.recipe.layers.map((layer) => layer.id)).toEqual([
      "refused",
    ]);
    expect(panel?.hidden).toBe(true);
    expect(c.saving).toBe(false);
    expect(dom.activeElement).toBe(nodes.get("save-status"));
  });

  it("discards one rendered refusal while retaining its sibling and editable terrain", async () => {
    const { c, authority, nodes } = session();
    c.commit = async (input) => authority.commit({ ...input, baseRevision: "stale" });
    for (const id of ["first", "second"]) {
      c.terrain.sculpt({ id, points: [[0, 0]], radius: 4, strength: 1 });
      await c.saveQueue.flush();
    }
    const first = c.saveQueue.unsent[0]?.id;
    nodes.get(`discard-${first}`)?.onclick?.();
    expect(c.saveQueue.unsent).toHaveLength(1);
    expect(c.terrain.layers.map((layer) => layer.id)).toEqual(["second"]);
    expect(authority.snapshot().document.recipe.layers).toHaveLength(0);
    expect(nodes.get("not-saved")?.hidden).toBe(false);
  });
  it("forces exactly two real server conflicts without mocking 409 responses", async () => {
    const { c, authority, dom } = session();
    vi.stubGlobal("location", { href: "http://127.0.0.1:5173/terrain-editor/conflict.html" });
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
      try {
        return Response.json(authority.commit(JSON.parse(String(init.body))));
      } catch (error) {
        return Response.json(
          { error: String(error) },
          { status: (error as { status: number }).status },
        );
      }
    });
    installStaleWrites();
    // The conflict fixture counts one sculpt intent per commit, so post a real stroke.
    const stroke = {
      enabled: true,
      id: "sculpt-conflict",
      name: "Sculpt stroke",
      opacity: 1,
      params: {
        falloff: 0.65,
        jitter: 0,
        points: [[0, 0]],
        radius: 4,
        rotation: 0,
        shape: "circle",
        spacing: 0.15,
        strength: 1,
      },
      type: "sculpt",
    };
    const input = {
      baseRevision: c.revision,
      commands: [{ layer: stroke, op: "upsert" }],
    };
    const post = () =>
      fetch("/terrain-editor/api/document", { method: "POST", body: JSON.stringify(input) });
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(409);
    expect((await post()).status).toBe(200);
    expect(dom.body.dataset.staleWriteConflicts).toBe("2");
  });

  it.each(["editor", "editor-conflict"])("uses existing harness vocabulary in %s", (name) => {
    const scenario = JSON.parse(
      readFileSync(new URL(`../playtests/${name}.playtest.json`, import.meta.url), "utf8"),
    );
    expect(() => validatePlaytestScenario(scenario, `${name}.playtest.json`)).not.toThrow();
  });
});
