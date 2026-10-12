import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { changed, installSaveQueue } from "../src/editor/app/evaluation.js";
import type { EditorSession } from "../src/editor/app/session.js";
import { TerrainEditorDocument } from "../src/editor/server.js";
import { Terrain } from "../src/index.js";

function session() {
  const terrain = new Terrain({ size: 32, resolution: 17, seed: 73 });
  const path = join(makeTempDirSync("editor-durability-"), "world.json");
  writeFileSync(path, JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
  const authority = new TerrainEditorDocument(path);
  const nodes = new Map<string, { textContent: string }>();
  vi.stubGlobal("document", {
    body: { dataset: {} },
    getElementById: (id: string) => {
      if (!nodes.has(id)) nodes.set(id, { textContent: "" });
      return nodes.get(id);
    },
  });
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
  return { c, authority, path, nodes };
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
});
