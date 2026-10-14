import { MessageChannel } from "node:worker_threads";
import { Terrain } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { SaveQueue, diffLayers, externalSnapshotAction } from "../src/editor/saveQueue.js";
import type {
  ISaveDocument,
  ISaveSnapshot,
  ISaveTransaction,
  SaveLayer,
} from "../src/editor/saveQueue.js";

function recipe() {
  return new Terrain({ size: 512, resolution: 129, seed: 73 })
    .noise({ id: "hills", amplitude: 16 })
    .toJSON();
}
function doc(recipeValue: unknown): ISaveDocument {
  return { version: 1, recipe: recipeValue } as ISaveDocument;
}
function ids(document_: ISaveDocument): string[] {
  return (document_.recipe.layers ?? []).map((layer) => layer.id);
}

/**
 * A real in-process document authority: validates nothing itself but applies the same patch
 * commands through the shipped `Terrain`, so a queue test exercises the actual command semantics.
 * It can hold a commit open (to prove edits made while the first save is pending) and reject a
 * chosen number of commits with a real 409, and an external writer can move the revision too.
 */
function makeServer(initial: ISaveDocument) {
  let current: ISaveDocument = structuredClone(initial);
  let revision = "r0";
  let counter = 0;
  let holdCount = 0;
  let rejectCount = 0;
  const gates: (() => void)[] = [];
  const commits: ISaveTransaction[] = [];
  return {
    commits,
    get revision() {
      return revision;
    },
    get document() {
      return structuredClone(current);
    },
    snapshot(): ISaveSnapshot {
      return { revision, document: structuredClone(current), diagnostic: null };
    },
    hold(count: number) {
      holdCount = count;
    },
    release() {
      holdCount = 0;
      for (const gate of gates.splice(0)) gate();
    },
    reject(count: number) {
      rejectCount = count;
    },
    externalAdd(id: string) {
      const terrain = Terrain.fromJSON(current.recipe as never).noise({ id, amplitude: 3 });
      current = { ...current, recipe: terrain.toJSON() as never };
      revision = `r${++counter}`;
    },
    externalRemove(id: string) {
      const terrain = Terrain.fromJSON(current.recipe as never).remove(id);
      current = { ...current, recipe: terrain.toJSON() as never };
      revision = `r${++counter}`;
    },
    externalAmplitude(id: string, amplitude: number) {
      const terrain = Terrain.fromJSON(current.recipe as never).update(id, {
        params: { amplitude },
      });
      current = { ...current, recipe: terrain.toJSON() as never };
      revision = `r${++counter}`;
    },
    externalMetadata(patch: Record<string, unknown>) {
      current = { ...current, ...patch };
      revision = `r${++counter}`;
    },
    async commit(transaction: ISaveTransaction): Promise<ISaveSnapshot> {
      commits.push(transaction);
      if (holdCount > 0) {
        holdCount--;
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      if (rejectCount > 0) {
        rejectCount--;
        throw new Error("409: Stale base revision");
      }
      if (transaction.baseRevision !== revision) throw new Error("409: Stale base revision");
      if (transaction.document) current = structuredClone(transaction.document);
      else {
        const terrain = Terrain.fromJSON(current.recipe as never);
        terrain.applyPatch(transaction.commands ?? []);
        current = { ...current, recipe: terrain.toJSON() as never };
      }
      revision = `r${++counter}`;
      return { revision, document: structuredClone(current), diagnostic: null };
    },
  };
}
type FakeServer = ReturnType<typeof makeServer>;

function makeQueue(server: FakeServer): SaveQueue {
  return new SaveQueue({
    base: server.snapshot(),
    commit: server.commit,
    getSnapshot: async () => server.snapshot(),
  });
}

function grow(recipeValue: unknown, id: string, amplitude: number) {
  return Terrain.fromJSON(recipeValue as never)
    .noise({ id, amplitude })
    .toJSON();
}

describe("terrain editor save queue", () => {
  it("keeps a second edit made while the first save is pending", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    let local = grow(server.document.recipe, "a", 5);
    queue.record(doc(local));
    expect(server.commits.length).toBe(1);
    local = grow(local, "b", 7);
    queue.record(doc(local));
    server.release();
    await queue.flush();
    expect(server.commits.length).toBe(2);
    expect(ids(server.document).sort()).toEqual(["a", "b", "hills"]);
    expect(queue.unsent.length).toBe(0);
  });

  it("keeps a layer added after a pending whole-document config change", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    const first = grow(server.document.recipe, "a", 5);
    queue.record(doc(first));
    expect(server.commits.length).toBe(1);
    const config = structuredClone(first);
    config.config = { ...config.config, seed: 999 };
    queue.record(doc(config));
    const layered = grow(config, "b", 7);
    queue.record(doc(layered));
    server.release();
    await queue.flush();
    // The stroke after a queued config save is its own save now, so the config save is not extended.
    expect(server.commits.length).toBe(3);
    expect(ids(server.document).sort()).toEqual(["a", "b", "hills"]);
    expect(server.document.recipe.config.seed).toBe(999);
    expect(queue.unsent.length).toBe(0);
  });

  it("honours an undo made before the first save answers", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    const base = structuredClone(server.document.recipe);
    server.hold(1);
    queue.record(doc(grow(base, "a", 5)));
    queue.record(doc(structuredClone(base)));
    server.release();
    await queue.flush();
    expect(ids(server.document)).toEqual(["hills"]);
  });

  it("retries a real 409 once, then keeps the refused edit visible", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    const local = grow(server.document.recipe, "a", 5);
    server.reject(2);
    queue.record(doc(local));
    await queue.flush();
    expect(server.commits.length).toBe(2);
    expect(queue.unsent.length).toBe(1);
    const refused = queue.unsent[0];
    if (!refused) throw new Error("expected a refused edit");
    expect(refused.label).toContain("rejected");
    // Discarding drops the change from the local observation, so a later edit never resends it.
    queue.discard(refused);
    expect(queue.unsent.length).toBe(0);
    expect(ids(queue.localDocument)).toEqual(["hills"]);
    queue.record(doc(grow(queue.localDocument.recipe, "c", 9)));
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["c", "hills"]);
  });

  it("does not resend a discarded edit in a later whole-document save", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.reject(2);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    await queue.flush();
    expect(queue.unsent.length).toBe(1);
    queue.discard(editFor(queue, "a"));
    const local = structuredClone(queue.localDocument.recipe);
    local.config = { ...local.config, seed: 999 };
    queue.record(doc(local));
    await queue.flush();
    expect(ids(server.document)).toEqual(["hills"]);
    expect(server.document.recipe.config.seed).toBe(999);
    expect(queue.unsent.length).toBe(0);
  });

  it("persists a refused edit when the user retries it", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.reject(2);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    await queue.flush();
    expect(queue.unsent.length).toBe(1);
    const refused = queue.unsent[0];
    if (!refused) throw new Error("expected a refused edit");
    queue.retry(refused);
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["a", "hills"]);
    expect(queue.unsent.length).toBe(0);
  });

  it("merges an unrelated external change when it rebases a conflicted save", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    expect(server.commits.length).toBe(1);
    server.externalAdd("b");
    server.release();
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["a", "b", "hills"]);
    expect(server.commits.length).toBe(2);
  });

  it("keeps local config, layer and asset changes over unrelated external edits", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    const localRecipe = structuredClone(server.document.recipe);
    localRecipe.config = { ...localRecipe.config, seed: 999 };
    const local = { ...grow(localRecipe, "a", 5), assets: [{ id: "tex", kind: "image" }] };
    server.hold(1);
    queue.record(doc(local));
    expect(server.commits.length).toBe(1);
    server.externalAdd("b");
    server.externalMetadata({ note: "external" });
    server.release();
    await queue.flush();
    const disk = server.document;
    expect(disk.recipe.config.seed).toBe(999);
    expect(ids(disk).sort()).toEqual(["a", "b", "hills"]);
    expect(disk.recipe).toHaveProperty("assets", [{ id: "tex", kind: "image" }]);
    expect(disk).toMatchObject({ note: "external" });
  });

  it("keeps local edits when an external snapshot arrives during a held save", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    let local = grow(server.document.recipe, "a", 5);
    queue.record(doc(local));
    expect(server.commits.length).toBe(1);
    server.externalAdd("b");
    queue.adopt(server.snapshot());
    local = grow(queue.localDocument.recipe, "c", 7);
    queue.record(doc(local));
    server.release();
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["a", "b", "c", "hills"]);
    expect(queue.unsent.length).toBe(0);
  });

  it("keeps the latest remote amplitude when a later edit follows an adopted snapshot", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    expect(server.commits.length).toBe(1);
    server.externalAdd("b");
    queue.adopt(server.snapshot());
    queue.record(doc(grow(queue.localDocument.recipe, "c", 7)));
    // The user never edited "b", so the remote amplitude must survive the held save's rebase.
    server.externalAmplitude("b", 11);
    server.release();
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["a", "b", "c", "hills"]);
    expect(server.document.recipe.layers.find((layer) => layer.id === "b")).toMatchObject({
      type: "noise",
      params: { amplitude: 11 },
    });
    expect(queue.unsent.length).toBe(0);
  });

  it("does not make a remote layer local-owned through a config intent queued before adopt", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    const config = structuredClone(queue.localDocument.recipe);
    config.config = { ...config.config, seed: 999 };
    queue.record(doc(config));
    server.externalAdd("b");
    queue.adopt(server.snapshot());
    queue.record(doc(grow(queue.localDocument.recipe, "c", 7)));
    server.externalAmplitude("b", 11);
    server.release();
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["a", "b", "c", "hills"]);
    expect(server.document.recipe.layers.find((layer) => layer.id === "b")).toMatchObject({
      type: "noise",
      params: { amplitude: 11 },
    });
    expect(server.document.recipe.config.seed).toBe(999);
    expect(queue.unsent.length).toBe(0);
  });

  it("sends every layer mutation route", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    let local = grow(server.document.recipe, "a", 5);
    queue.record(doc(local));
    await queue.flush();
    expect(ids(server.document)).toContain("a");
    local = Terrain.fromJSON(local as never)
      .update("hills", { params: { amplitude: 42 } })
      .toJSON();
    queue.record(doc(local));
    await queue.flush();
    expect(server.document.recipe.layers.find((layer) => layer.id === "hills")).toMatchObject({
      type: "noise",
      params: { amplitude: 42 },
    });
    local = Terrain.fromJSON(local as never)
      .toggle("hills", false)
      .toJSON();
    queue.record(doc(local));
    await queue.flush();
    expect(server.document.recipe.layers.find((l) => l.id === "hills")?.enabled).toBe(false);
    local = Terrain.fromJSON(local as never)
      .move("a", 0)
      .toJSON();
    queue.record(doc(local));
    await queue.flush();
    expect(ids(server.document)[0]).toBe("a");
    local = Terrain.fromJSON(local as never)
      .remove("a")
      .toJSON();
    queue.record(doc(local));
    await queue.flush();
    expect(ids(server.document)).toEqual(["hills"]);
  });

  it("sends a config change as the whole document", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    const next = structuredClone(server.document.recipe);
    next.config = { ...next.config, seed: 999 };
    queue.record(doc(next));
    await queue.flush();
    expect(server.document.recipe.config.seed).toBe(999);
    const first = server.commits[0];
    if (!first) throw new Error("expected a commit");
    expect(first.document).toBeTruthy();
    expect(first.commands).toBeUndefined();
    expect(ids(server.document)).toEqual(["hills"]);
  });

  it("sends a recipe asset change as the whole document", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    const next = {
      ...structuredClone(server.document.recipe),
      assets: [{ id: "tex", kind: "image" }],
    };
    queue.record(doc(next));
    await queue.flush();
    expect(server.document.recipe).toHaveProperty("assets", [{ id: "tex", kind: "image" }]);
    expect(ids(server.document)).toEqual(["hills"]);
  });

  it("diffs layers into order-preserving commands", () => {
    const base = [{ id: "a" }, { id: "b" }] as unknown as SaveLayer[];
    const next = [{ id: "b" }, { id: "a" }, { id: "c" }] as unknown as SaveLayer[];
    const commands = diffLayers(base, next);
    expect(commands).toContainEqual({ op: "upsert", layer: { id: "c" } });
    expect(commands.filter((command) => command.op === "move")).toEqual([
      { op: "move", id: "b", index: 0 },
      { op: "move", id: "a", index: 1 },
      { op: "move", id: "c", index: 2 },
    ]);
  });

  it("moves a layer inserted before an existing layer onto disk in order", () => {
    const baseRecipe = new Terrain({ size: 512, resolution: 129, seed: 73 })
      .noise({ id: "a", amplitude: 1 })
      .noise({ id: "b", amplitude: 2 })
      .toJSON();
    const inserted = Terrain.fromJSON(baseRecipe as never)
      .noise({ id: "c", amplitude: 3 })
      .move("c", 1);
    const commands = diffLayers(
      baseRecipe.layers as unknown as SaveLayer[],
      inserted.toJSON().layers as unknown as SaveLayer[],
    );
    const applied = Terrain.fromJSON(baseRecipe as never);
    applied.applyPatch(commands as never);
    expect(applied.toJSON().layers.map((layer) => layer.id)).toEqual(["a", "c", "b"]);
  });

  it("emits a reorder for a removed then re-added layer with the same id", () => {
    const baseRecipe = new Terrain({ size: 512, resolution: 129, seed: 73 })
      .noise({ id: "a", amplitude: 1 })
      .noise({ id: "b", amplitude: 2 })
      .noise({ id: "c", amplitude: 3 })
      .toJSON();
    const layerB = baseRecipe.layers.find((layer) => layer.id === "b");
    if (!layerB) throw new Error("expected layer b");
    const readded = Terrain.fromJSON(baseRecipe as never)
      .remove("b")
      .add(structuredClone(layerB));
    const commands = diffLayers(
      baseRecipe.layers as unknown as SaveLayer[],
      readded.toJSON().layers as unknown as SaveLayer[],
    );
    const applied = Terrain.fromJSON(baseRecipe as never);
    applied.applyPatch(commands as never);
    expect(applied.toJSON().layers.map((layer) => layer.id)).toEqual(["a", "c", "b"]);
  });

  function editFor(queue: SaveQueue, layerId: string) {
    const edit = queue.unsent.find((item) =>
      item.commands.some((command) => command.op === "upsert" && command.layer.id === layerId),
    );
    if (!edit) throw new Error(`expected a refused edit that adds ${layerId}`);
    return edit;
  }

  it("keeps a second refused edit when the first is discarded", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.reject(2);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    await queue.flush();
    server.reject(2);
    queue.record(doc(grow(queue.localDocument.recipe, "b", 7)));
    await queue.flush();
    expect(queue.unsent.length).toBe(2);
    queue.discard(editFor(queue, "a"));
    expect(queue.unsent.length).toBe(1);
    expect(ids(queue.localDocument).sort()).toEqual(["b", "hills"]);
  });

  it("keeps an in-flight edit when an earlier refused edit is discarded, then acks only it", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.reject(2);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    await queue.flush();
    expect(queue.unsent.length).toBe(1);
    server.hold(1);
    queue.record(doc(grow(queue.localDocument.recipe, "b", 7)));
    expect(queue.hasLocalIntent()).toBe(true);
    queue.discard(editFor(queue, "a"));
    expect(ids(queue.localDocument).sort()).toEqual(["b", "hills"]);
    server.release();
    await queue.flush();
    expect(ids(server.document).sort()).toEqual(["b", "hills"]);
    expect(queue.unsent.length).toBe(0);
    expect(ids(queue.localDocument).sort()).toEqual(["b", "hills"]);
    const commits = server.commits.length;
    await queue.flush();
    expect(server.commits.length).toBe(commits);
  });

  it("defers an external snapshot while any local intent exists", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    expect(externalSnapshotAction(queue, server.snapshot())).toBe("defer");
    server.release();
    await queue.flush();
    server.reject(2);
    queue.record(doc(grow(server.document.recipe, "b", 7)));
    await queue.flush();
    expect(queue.unsent.length).toBe(1);
    expect(externalSnapshotAction(queue, server.snapshot())).toBe("defer");
    queue.discard(editFor(queue, "b"));
    expect(externalSnapshotAction(queue, { ...server.snapshot(), revision: "newer" })).toBe(
      "apply",
    );
  });

  it("keeps remote fields and layers through a 409 rebase and a later whole save", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    const first = grow(server.document.recipe, "a", 5);
    queue.record(doc(first));
    expect(server.commits.length).toBe(1);
    const config = structuredClone(first);
    config.config = { ...config.config, seed: 999 };
    queue.record(doc(config));
    // While the first commit waits, a remote writer adds a layer, a config field and an asset.
    server.externalAdd("b");
    const remote = server.document.recipe;
    remote.config = { ...remote.config, size: 1024 };
    server.externalMetadata({ recipe: remote, assets: [{ id: "remote-tex", kind: "image" }] });
    server.release();
    await queue.flush();
    expect(server.commits.length).toBe(3);
    const sent = server.commits[2]?.document;
    if (!sent) throw new Error("expected a commit for the second intent");
    for (const document_ of [sent, server.document, queue.base.document, queue.localDocument]) {
      expect(ids(document_).sort()).toEqual(["a", "b", "hills"]);
      expect(document_.recipe.config).toMatchObject({ size: 1024, seed: 999 });
      expect(document_.assets).toEqual([{ id: "remote-tex", kind: "image" }]);
    }
    expect(queue.unsent.length).toBe(0);
  });

  it("refuses a queued toggle of a layer an external writer removed, then settles", async () => {
    const server = makeServer(doc(recipe()));
    const queue = makeQueue(server);
    server.hold(1);
    queue.record(doc(grow(server.document.recipe, "a", 5)));
    expect(server.commits.length).toBe(1);
    const next = structuredClone(queue.localDocument.recipe);
    next.config = { ...next.config, seed: 999 };
    queue.record(
      doc(
        Terrain.fromJSON(next as never)
          .toggle("hills", false)
          .toJSON(),
      ),
    );
    // The external writer removes "hills" while the first commit waits.
    // The 409 rebase still adds "a". The queued toggle of "hills" then targets a missing layer.
    server.externalRemove("hills");
    server.release();
    await queue.flush();
    expect(queue.hasPending()).toBe(false);
    expect(queue.unsent.length).toBe(1);
    const refused = queue.unsent[0];
    if (!refused) throw new Error("expected a refused edit");
    expect(refused.label).toContain("rejected");
    expect(server.commits.length).toBe(2);
    expect(ids(server.document)).toEqual(["a"]);
    expect(server.document.recipe.config.seed).toBe(73);
  });
});

describe("editor worker transfer", () => {
  it.each(["../src/editor/worker.js", "../dist/editor/worker.js"])(
    "%s transfers height, genuine normal and splat buffers and can evaluate again",
    async (entry) => {
      const { Terrain } = await import("../src/index.js");
      const { bakeMesh } = await import("../src/core/bake.js");
      const recipe = new Terrain({ resolution: 17, size: 16 }).noise({ amplitude: 4 }).toJSON();
      const channel = new MessageChannel();
      const sent: ArrayBuffer[] = [];
      const expected: ArrayBufferLike[] = [];
      const post = Object.getOwnPropertyDescriptor(globalThis, "postMessage");
      const handler = Object.getOwnPropertyDescriptor(globalThis, "onmessage");
      Object.defineProperty(globalThis, "postMessage", {
        configurable: true,
        value: (
          message: import("../src/editor/worker.js").EditorWorkerReply,
          transfer?: ArrayBuffer[],
        ) => {
          if (message.type === "progress") return;
          if (message.type === "evaluated") {
            expected.push(message.state.height.buffer, message.state.splat.buffer);
            if (message.normal) expected.push(message.normal.buffer);
          }
          sent.push(...(transfer ?? []));
          channel.port1.postMessage(message, transfer);
        },
      });
      try {
        await import(entry);
        for (const id of [1, 2]) {
          const reply = new Promise<import("../src/editor/worker.js").EditorWorkerReply>(
            (resolve) => channel.port2.once("message", resolve),
          );
          await (
            globalThis.onmessage as unknown as (
              event: MessageEvent<import("../src/editor/worker.js").IWorkerRequest>,
            ) => Promise<void>
          )(
            new MessageEvent("message", { data: { id, type: "evaluate", recipe, resolution: 17 } }),
          );
          const received = await reply;
          expect(received.type).toBe("evaluated");
          if (received.type !== "evaluated") throw new Error("No evaluated state");
          expect(sent).toHaveLength(3 * id);
          expect(sent).toEqual(expect.arrayContaining(expected));
          expect(sent.every((buffer) => buffer.byteLength === 0)).toBe(true);
          expect(received.state.height.length).toBe(17 * 17);
          expect(received.state.splat.length).toBe(17 * 17 * 8);
          expect(received.normal).toEqual(bakeMesh(received.state).normals);
          expect(received.state.height.some((height) => height !== 0)).toBe(true);
        }
        expect(sent).toHaveLength(6);
      } finally {
        channel.port1.close();
        channel.port2.close();
        if (post) Object.defineProperty(globalThis, "postMessage", post);
        else Reflect.deleteProperty(globalThis, "postMessage");
        if (handler) Object.defineProperty(globalThis, "onmessage", handler);
        else Reflect.deleteProperty(globalThis, "onmessage");
      }
    },
    10_000,
  );
});
