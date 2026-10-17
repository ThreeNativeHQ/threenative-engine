import { type PatchCommand, Terrain } from "../core/terrain.js";

import type { ITerrainDocument } from "../core/types.js";
import type { IAuthoringDocument, IEditorSnapshot } from "./server.js";

export type ISaveRecipe = ITerrainDocument;
export type ISaveDocument = IAuthoringDocument;
export type ISaveSnapshot = IEditorSnapshot;
export interface ISaveLayer {
  id: string;
  enabled?: boolean;
  params?: object;
}
export type SaveLayer = ISaveLayer;
/**
 * One local intent in the ordered journal: the change from the document shown just before it
 * (`baseline`) to the document shown just after (`target`), plus the layer commands when a
 * plain layer diff expresses it. A refused intent keeps its exact change so it can be retried.
 */
export interface IUnsentEdit {
  id: string;
  label: string;
  error: string;
  commands: PatchCommand[];
  document: ISaveDocument | null;
}
interface ISaveIntent extends IUnsentEdit {
  baseline: ISaveDocument;
  target: ISaveDocument;
  wholeDocument: boolean;
  state: "queued" | "inflight" | "rejected";
}
export type ISaveTransaction =
  | { baseRevision: string; commands: readonly PatchCommand[]; document?: never }
  | { baseRevision: string; document: ISaveDocument; commands?: never };
/** What an external snapshot (reload, restore, SSE) does to the local view. */
export type ExternalSnapshotAction = "ignore" | "defer" | "adopt" | "apply";

/**
 * The net layer commands between two recipes. A layer only present in the next recipe is a new
 * `upsert`; one changed in place keeps every field through an `upsert`; a reorder emits one `move`
 * per layer so the server sees the exact stack order.
 *
 * The order comparison uses the disk order the upserts and removes will produce — base layers
 * that survive, then brand-new layers appended in next order — so a layer inserted before an
 * existing one still gets its moves and is not silently appended to the end.
 */
export function diffLayers(baseLayers: SaveLayer[], nextLayers: SaveLayer[]): PatchCommand[] {
  const baseMap = new Map((baseLayers ?? []).map((layer) => [layer.id, layer]));
  const nextMap = new Map((nextLayers ?? []).map((layer) => [layer.id, layer]));
  const commands: PatchCommand[] = [];
  for (const id of baseMap.keys()) if (!nextMap.has(id)) commands.push({ op: "remove", id });
  for (const layer of nextLayers ?? []) {
    const before = baseMap.get(layer.id);
    if (!before) {
      commands.push({ op: "upsert", layer: layer as never });
    } else if (JSON.stringify(before) !== JSON.stringify(layer)) {
      const onlyToggle =
        before.enabled !== layer.enabled &&
        JSON.stringify({ ...before, enabled: layer.enabled }) === JSON.stringify(layer);
      commands.push(
        onlyToggle
          ? { op: "toggle", id: layer.id, enabled: layer.enabled }
          : { op: "upsert", layer: layer as never },
      );
    }
  }
  const projected = [
    ...(baseLayers ?? []).filter((layer) => nextMap.has(layer.id)).map((layer) => layer.id),
    ...(nextLayers ?? []).filter((layer) => !baseMap.has(layer.id)).map((layer) => layer.id),
  ];
  if (JSON.stringify(projected) !== JSON.stringify((nextLayers ?? []).map((layer) => layer.id)))
    for (const [index, layer] of (nextLayers ?? []).entries())
      commands.push({ op: "move", id: layer.id, index });
  return commands;
}

function recipeOf(document: ISaveDocument): ISaveRecipe {
  return document.recipe;
}
function layersOf(document: ISaveDocument): SaveLayer[] {
  return recipeOf(document).layers ?? [];
}
function withoutRecipe(document: ISaveDocument): Record<string, unknown> {
  const { recipe: _recipe, ...rest } = document;
  return rest;
}
/** Every recipe field a patch command cannot express: config, assets and anything a game adds. */
function withoutLayers(document: ISaveDocument): Record<string, unknown> {
  const { layers: _layers, ...rest } = recipeOf(document);
  return rest;
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function isConflict(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 409 || /(^|\D)409(\D|$)|Stale base revision/u.test(message);
}
function applyToRecipe(recipe: ISaveRecipe, commands: readonly PatchCommand[]): ISaveRecipe {
  if (commands.length === 0) return structuredClone(recipe);
  const terrain = Terrain.fromJSON(recipe as never);
  terrain.applyPatch(commands as never);
  return terrain.toJSON();
}

/**
 * Three-way merge of plain JSON. Objects merge key by key; arrays and primitives are leaves, so a
 * field the local user changed wins, and a field only the disk changed keeps the disk value. This
 * is what lets a whole-document save rebase onto a fresh revision without dropping an unrelated
 * external edit.
 */
function threeWayMerge(base: unknown, local: unknown, remote: unknown): unknown {
  if (isPlainObject(base) || isPlainObject(local) || isPlainObject(remote)) {
    const b = isPlainObject(base) ? base : {};
    const l = isPlainObject(local) ? local : {};
    const r = isPlainObject(remote) ? remote : {};
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)]))
      merged[key] = threeWayMerge(b[key], l[key], r[key]);
    return merged;
  }
  return same(local, base) ? remote : local;
}

/**
 * Merge a whole-document intent (baseline -> target) onto the fresh disk document. Unchanged
 * fields keep the fresh value; changed fields take the local value; the layer intent replays as
 * commands so an external layer change survives alongside the local one.
 */
function mergeWholeDocument(
  baseline: ISaveDocument,
  target: ISaveDocument,
  fresh: ISaveDocument,
): ISaveDocument {
  const merged = threeWayMerge(baseline, target, fresh) as ISaveDocument;
  const commands = diffLayers(layersOf(baseline), layersOf(target));
  if (commands.length) {
    const terrain = Terrain.fromJSON(recipeOf(fresh) as never);
    terrain.applyPatch(commands as never);
    merged.recipe = { ...merged.recipe, layers: terrain.layers as never };
  }
  return merged;
}

/**
 * Decide what an external snapshot does to the editor. A diagnostic snapshot is ignored here (the
 * caller shows the banner). Any local intent — queued, in flight or refused — defers the snapshot
 * so a reload, restore or SSE event can never roll local work back; an unchanged revision only
 * needs the queue to adopt it, a newer one also reloads the preview.
 */
export function externalSnapshotAction(
  queue: SaveQueue,
  snapshot: ISaveSnapshot,
): ExternalSnapshotAction {
  if (snapshot.diagnostic) return "ignore";
  if (queue.hasLocalIntent()) return "defer";
  return snapshot.revision === queue.revision ? "adopt" : "apply";
}

/**
 * Client-side ordered intent journal for the project terrain document.
 *
 * The queue owns one journal of local intents and one confirmed disk snapshot. Each `record` diffs
 * the new observation against the last displayed document and appends one intent; the displayed
 * document is always the confirmed snapshot replayed with every intent still in the journal. A
 * commit acknowledges exactly one intent, so a second stroke, a refusal or a discard never drops a
 * sibling: discarding a refused edit removes only that intent and replays the rest. A 409 rebases
 * the intent on the fresh revision and retries once (a command batch replays its layer commands, a
 * whole-document batch merges only the fields it changed). A refusal stays visible for retry or
 * discard. A metadata lane hands back its own committed document through `adopt`.
 *
 * @example const queue = new SaveQueue({ base, commit, getSnapshot }); queue.record(nextDocument);
 */
export class SaveQueue {
  #commit: (transaction: ISaveTransaction) => Promise<ISaveSnapshot>;
  #getSnapshot: () => Promise<ISaveSnapshot>;
  #onSaved: ((snapshot: ISaveSnapshot, local: ISaveDocument) => void) | undefined;
  #onNotify: ((message: string) => void) | undefined;
  #onChange: (() => void) | undefined;
  #confirmed: ISaveSnapshot;
  #journal: ISaveIntent[] = [];
  #saving = false;
  #flushing: Promise<void> = Promise.resolve();

  constructor(options: {
    base: ISaveSnapshot;
    commit: (transaction: ISaveTransaction) => Promise<ISaveSnapshot>;
    getSnapshot: () => Promise<ISaveSnapshot>;
    onSaved?: (snapshot: ISaveSnapshot, local: ISaveDocument) => void;
    onNotify?: (message: string) => void;
    onChange?: () => void;
  }) {
    this.#confirmed = options.base;
    this.#commit = options.commit;
    this.#getSnapshot = options.getSnapshot;
    this.#onSaved = options.onSaved;
    this.#onNotify = options.onNotify;
    this.#onChange = options.onChange;
  }

  get base(): ISaveSnapshot {
    return this.#confirmed;
  }
  get revision(): string {
    return this.#confirmed.revision;
  }
  /** The local document as the queue sees it: the confirmed snapshot with every intent replayed. */
  get localDocument(): ISaveDocument {
    return this.#replay();
  }
  /** Refused intents, kept visible with retry and discard. */
  get unsent(): readonly IUnsentEdit[] {
    return this.#journal.filter((intent) => intent.state === "rejected");
  }
  get saving(): boolean {
    return this.#saving;
  }
  hasPending(): boolean {
    return this.#journal.some((intent) => intent.state === "queued" || intent.state === "inflight");
  }
  /** True while any local intent exists — queued, in flight or refused — or a save is running. */
  hasLocalIntent(): boolean {
    return this.#saving || this.#journal.length > 0;
  }

  /**
   * Record one local observation. The intent diffs the new document against the displayed local
   * document: the confirmed snapshot replayed with the journal. It never diffs against the disk, so
   * a second edit before the first save answers is queued rather than reverted. A remote change
   * adopted since the last edit belongs to the baseline, so it never becomes a local intent.
   */
  record(document: ISaveDocument): void {
    const baseline = this.localDocument;
    if (same(baseline, document)) return;
    const whole =
      !same(withoutLayers(baseline), withoutLayers(document)) ||
      !same(withoutRecipe(baseline), withoutRecipe(document));
    const commands = whole ? [] : diffLayers(layersOf(baseline), layersOf(document));
    if (!whole && commands.length === 0) return;
    this.#journal.push({
      id: `intent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label: `${whole ? 1 : commands.length} edit(s)`,
      error: "",
      commands,
      document: whole ? structuredClone(document) : null,
      baseline: structuredClone(baseline),
      target: structuredClone(document),
      wholeDocument: whole,
      state: "queued",
    });
    this.#onChange?.();
    void this.flush();
  }

  /**
   * Adopt a snapshot the queue did not request (SSE, reload, restore or a metadata lane commit).
   * The base revision always follows disk; the displayed document stays the confirmed snapshot
   * replayed with any local intent, so nothing in flight is dropped.
   */
  adopt(snapshot: ISaveSnapshot): void {
    this.#confirmed = snapshot;
    this.#onChange?.();
  }

  /** Re-queue a refused intent in place, so retry keeps its order in the journal. */
  retry(edit: IUnsentEdit): void {
    const intent = this.#intent(edit.id);
    if (!intent) return;
    intent.state = "queued";
    intent.error = "";
    this.#onChange?.();
    void this.flush();
  }

  /** Drop one refused intent and replay the rest, so a later save never resends it. */
  discard(edit: IUnsentEdit): void {
    this.#journal = this.#journal.filter((intent) => intent.id !== edit.id);
    this.#onChange?.();
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.#saving) return this.#flushing;
    if (!this.hasPending()) return;
    this.#saving = true;
    this.#flushing = this.#run();
    return this.#flushing;
  }

  #intent(id: string): ISaveIntent | undefined {
    return this.#journal.find((intent) => intent.id === id);
  }

  /** The confirmed snapshot with every journal intent replayed in order. */
  #replay(): ISaveDocument {
    let document = structuredClone(this.#confirmed.document);
    for (const intent of this.#journal) {
      try {
        document = this.#apply(document, intent);
      } catch (error) {
        // A rejected sibling can make a dependent intent un-replayable: keep it visible instead
        // of silently dropping it, so the user can retry or discard it.
        if (intent.state !== "rejected") this.#reject(intent, error);
      }
    }
    return document;
  }

  #apply(document: ISaveDocument, intent: ISaveIntent): ISaveDocument {
    if (intent.wholeDocument) return mergeWholeDocument(intent.baseline, intent.target, document);
    const recipe = applyToRecipe(recipeOf(document), intent.commands);
    return { ...document, recipe };
  }

  #reject(intent: ISaveIntent, error: unknown): void {
    intent.state = "rejected";
    intent.error = error instanceof Error ? error.message : String(error);
    intent.label = `${intent.wholeDocument ? 1 : intent.commands.length} edit(s) rejected: ${intent.error}`;
    this.#onNotify?.(intent.error);
  }

  #transaction(intent: ISaveIntent, snapshot: ISaveSnapshot): ISaveTransaction {
    if (intent.wholeDocument)
      return {
        baseRevision: snapshot.revision,
        document: mergeWholeDocument(intent.baseline, intent.target, snapshot.document),
      };
    return { baseRevision: snapshot.revision, commands: intent.commands };
  }

  #rebase(intent: ISaveIntent, snapshot: ISaveSnapshot): ISaveTransaction {
    if (intent.wholeDocument)
      return {
        baseRevision: snapshot.revision,
        document: mergeWholeDocument(intent.baseline, intent.target, snapshot.document),
      };
    const recipe = applyToRecipe(recipeOf(snapshot.document), intent.commands);
    return {
      baseRevision: snapshot.revision,
      commands: diffLayers(layersOf(snapshot.document), recipe.layers ?? []),
    };
  }

  async #run(): Promise<void> {
    try {
      for (;;) {
        const intent = this.#journal.find((entry) => entry.state === "queued");
        if (!intent) break;
        intent.state = "inflight";
        this.#onChange?.();
        let transaction: ISaveTransaction;
        try {
          transaction = this.#transaction(intent, this.#confirmed);
        } catch (error) {
          this.#reject(intent, error);
          this.#onChange?.();
          continue;
        }
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const next = await this.#commit(transaction);
            this.#confirmed = next;
            this.#journal = this.#journal.filter((entry) => entry.id !== intent.id);
            this.#onSaved?.(next, this.localDocument);
            this.#onChange?.();
            break;
          } catch (error) {
            if (isConflict(error) && attempt === 1) {
              try {
                const fresh = await this.#getSnapshot();
                this.#confirmed = fresh;
                transaction = this.#rebase(intent, fresh);
                continue;
              } catch {}
            }
            this.#reject(intent, error);
            this.#onChange?.();
            break;
          }
        }
      }
    } finally {
      this.#saving = false;
      this.#onChange?.();
    }
    if (this.hasPending()) void this.flush();
  }
}
