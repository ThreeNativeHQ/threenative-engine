import type { ITerrainState } from "../../core/types.js";
import {
  MATERIAL_IDS,
  Mask,
  Terrain,
  applyPlacementOverrides,
  bakeTerrain,
  decodeHeightPNG,
  decodeRAW16,
  makeExport,
} from "../../index.js";
import type { IProjectAsset } from "../assets.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import type { IAuthoringDocument, IEditorSnapshot } from "../server.js";
import { inspectSpatial } from "../spatialInspector.js";
import type { EditorWorkerReply } from "../worker.js";
import { $, errorMessage } from "./dom.js";
import { AnnouncementQueue } from "./keyboard.js";
import type { EditorSession } from "./session.js";
export function toast(c: EditorSession, message: string, blocking = false): void {
  c.announce(message, blocking);
  clearTimeout(c.toastTimer ?? undefined);
  $("toast").textContent = message;
  $("toast").classList.remove("hidden");
  c.toastTimer = setTimeout(() => $("toast").classList.add("hidden"), 4300);
}

export function attempt(c: EditorSession, fn: () => unknown): unknown {
  try {
    return fn();
  } catch (e) {
    c.toast(errorMessage(e));
    return undefined;
  }
}

export function setBusy(c: EditorSession, value: boolean, text = "Building terrain"): void {
  c.busy = value;
  $("busy-status").classList.toggle("hidden", !value);
  $("busy-text").textContent = text;
}

export function workerURL(c: EditorSession): URL {
  return new URL("./worker.js", import.meta.url);
}

export function newWorker(c: EditorSession): Worker {
  const w = new Worker(c.workerURL(), { type: "module" });
  w.onmessage = async ({ data }: MessageEvent<EditorWorkerReply>) => {
    if (data.type === "progress") {
      if (data.id === c.sequence)
        $("busy-text").textContent = `Evaluating ${data.progress.index + 1}/${data.progress.total}`;
      return;
    }
    // Imported models load asynchronously; the preview waits for them rather than failing a
    // placement that names an asset still on its way. The worker stays busy meanwhile.
    if (data.id === c.sequence && data.type === "evaluated")
      await c.view.assetsReady?.().catch(() => {});
    c.workerBusy = false;
    if (data.id === c.sequence) {
      if (data.type === "error") {
        c.toast(data.error);
        $("save-status").textContent = "Build failed · last preview retained";
      } else if (data.type === "evaluated") {
        const ready = c.attempt(() => {
          data.state = c.view.update(data.state) ?? data.state;
          return true;
        });
        if (!ready) {
          $("save-status").textContent = "Preview failed · last preview retained";
        } else {
          c.state = data.state;
          c.renderedRecipe = JSON.stringify(c.terrain.toJSON());
          c.renderedRevision = c.revision;
          c.onEvaluated?.({ revision: c.revision, state: data.state, ms: data.ms });
          $("mesh-stats").textContent =
            `${(2 * (data.state.resolution - 1) ** 2).toLocaleString()} tris · ${data.state.instances.length.toLocaleString()} instances`;
          $("eval-time").textContent = `${Math.round(data.ms)} ms · CPU worker`;
          $("diagnostic-count").textContent = String(data.state.diagnostics.length);
          $("diagnostic-list").textContent = data.state.diagnostics.join("\n") || "No diagnostics.";
          $("save-status").textContent =
            `Rendered ${c.renderedRevision.slice(0, 8)} · saved on disk`;
        }
      }
    }
    if (c.pending) c.dispatch();
    else c.setBusy(false);
  };
  w.onerror = (e) => {
    e.preventDefault();
    c.workerBusy = false;
    c.pending = null;
    c.setBusy(false);
    c.toast(`Worker failed: ${e.message}. Serve the source over HTTP or use the standalone HTML.`);
  };
  return w;
}

export function dispatch(c: EditorSession): void {
  if (c.workerBusy || !c.pending) return;
  const job = c.pending;
  c.pending = null;
  try {
    c.worker ??= c.newWorker();
    c.workerBusy = true;
    c.worker.postMessage(job);
    c.evaluationRequests++;
  } catch (e) {
    c.workerBusy = false;
    c.setBusy(false);
    c.toast(errorMessage(e));
  }
}

export function build(c: EditorSession): void {
  if (c.disposed) return;
  c.sequence++;
  c.pending = {
    id: c.sequence,
    type: "evaluate",
    recipe: c.terrain.toJSON(),
    resolution: Number($("preview-resolution").value),
  };
  c.setBusy(true);
  clearTimeout(c.timer ?? undefined);
  c.timer = setTimeout(c.dispatch, 35);
}

export function cancelBuild(c: EditorSession): void {
  clearTimeout(c.timer ?? undefined);
  c.pending = null;
  c.sequence++;
  c.worker?.terminate();
  c.worker = null;
  c.workerBusy = false;
  c.exportWorker?.terminate();
  c.exportWorker = null;
  c.exportReject?.(new Error("Export cancelled"));
  c.exportReject = null;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]")) {
    b.disabled = false;
  }
  c.setBusy(false);
  $("save-status").textContent = "Build cancelled · preview unchanged";
  c.toast("Build cancelled. Rebuild to evaluate the current stack.");
}

export function syncAssets(c: EditorSession, document_: IAuthoringDocument): void {
  const next = JSON.stringify(document_.assets ?? []);
  if (next === c.assetSignature) return;
  const before = new Map(
    (JSON.parse(c.assetSignature) as IProjectAsset[]).map((entry) => [
      entry.id,
      JSON.stringify(entry),
    ]),
  );
  const after = new Map((document_.assets ?? []).map((entry) => [entry.id, JSON.stringify(entry)]));
  const changed = new Set(
    [...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id)),
  );
  c.assetSignature = next;
  const used = () =>
    c.terrain
      .toJSON()
      .layers.some((layer) => "asset" in layer.params && changed.has(layer.params.asset ?? ""));
  Promise.resolve(c.view.assetsReady?.())
    .catch(() => {})
    .then(() => {
      if (c.disposed) return;
      c.renderOptions();
      if (used()) c.build();
    });
}

export function useSnapshot(c: EditorSession, snapshot: IEditorSnapshot): void {
  if (snapshot.diagnostic) {
    c.toast(snapshot.diagnostic);
    $("save-status").textContent = "Invalid disk save · valid preview retained";
    return;
  }
  if (snapshot.revision === c.revision) return;
  const recipeChanged =
    JSON.stringify(c.terrain.toJSON()) !== JSON.stringify(snapshot.document.recipe);
  const ready = c.attempt(() => {
    c.view.setDocument(snapshot.document, snapshot.revision);
    return true;
  });
  if (!ready) {
    $("save-status").textContent = "Preview failed · last preview retained";
    return;
  }
  c.revision = snapshot.revision;
  c.renderCameras(snapshot.document);
  c.renderEnvironment();
  c.renderAssets();
  c.syncAssets(snapshot.document);
  if (!recipeChanged) {
    const matchesPreview = c.renderedRecipe === JSON.stringify(snapshot.document.recipe);
    if (c.state && matchesPreview)
      c.state = applyPlacementOverrides(c.state, snapshot.document.placementOverrides ?? {});
    if (matchesPreview && !c.busy) {
      c.renderedRevision = c.revision;
      $("save-status").textContent = `Applied ${c.revision.slice(0, 8)} · saved on disk`;
    } else {
      $("save-status").textContent = c.busy
        ? `Requested ${c.revision.slice(0, 8)} · building`
        : "Saved recipe not rendered · last preview retained";
    }
    return;
  }
  c.loading = true;
  c.terrain.loadJSON(snapshot.document.recipe);
  c.loading = false;
  c.renderLayers();
  c.build();
}

export async function changed(c: EditorSession): Promise<void> {
  c.renderLayers();
  if (c.loading) return;
  if (c.saving) {
    c.loading = true;
    c.terrain.loadJSON(c.saved.document.recipe);
    c.loading = false;
    c.toast("Wait for the current save");
    return;
  }
  c.saving = true;
  document.body.dataset.saving = "true";
  try {
    const next = await c.commit({
      baseRevision: c.revision,
      document: { ...c.saved.document, recipe: c.terrain.toJSON() },
    });
    c.saved = next;
    c.revision = next.revision;
    c.view.setDocument(next.document, next.revision);
    $("save-status").textContent = `Requested ${c.revision.slice(0, 8)} · building`;
    c.build();
  } catch (error) {
    c.toast(errorMessage(error), true);
    const next = await c.getSnapshot();
    c.saved = next;
    c.revision = next.revision;
    c.view.setDocument(next.document, next.revision);
    c.loading = true;
    c.terrain.loadJSON(next.document.recipe);
    c.loading = false;
    c.renderLayers();
    c.build();
  } finally {
    c.saving = false;
    delete document.body.dataset.saving;
  }
}
export function installEvaluation(c: EditorSession) {
  c.abort = new AbortController();
  c.disposed = false;
  const live = document.createElement("div");
  live.id = "editor-announcements";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.style.cssText =
    "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
  document.body.append(live);
  const queue = new AnnouncementQueue();
  let announcementTimer: ReturnType<typeof setTimeout> | undefined;
  const deliver = () => {
    const next = queue.shift();
    if (!next) {
      announcementTimer = undefined;
      return;
    }
    live.textContent = "";
    live.setAttribute("aria-live", next.blocking ? "assertive" : "polite");
    announcementTimer = setTimeout(() => {
      live.textContent = next.message;
      announcementTimer = setTimeout(deliver, 1000);
    }, 50);
  };
  c.announce = (message, blocking = false) => {
    queue.push(message, blocking);
    if (announcementTimer === undefined) deliver();
  };
  const errors = new MutationObserver((records) => {
    const changed = new Set<Element>();
    for (const record of records) {
      const node = record.target instanceof Element ? record.target : record.target.parentElement;
      const error = node?.closest('[id$="-error"], #placement-status');
      if (error) changed.add(error);
    }
    for (const error of changed) if (error.textContent) c.announce(error.textContent);
    // A modal makes outside content inert; keep the one live region inside the active dialog.
    const parent = document.querySelector("dialog[open]") ?? document.body;
    if (live.parentElement !== parent) parent.append(live);
  });
  errors.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  c.abort.signal.addEventListener(
    "abort",
    () => {
      errors.disconnect();
      clearTimeout(announcementTimer);
      live.remove();
    },
    { once: true },
  );
  $("toast").removeAttribute("role");
  const focusStyle = document.createElement("style");
  focusStyle.textContent =
    ":focus-visible{outline:2px solid var(--accent)!important;outline-offset:3px}";
  document.head.append(focusStyle);
  c.abort.signal.addEventListener("abort", () => focusStyle.remove(), { once: true });
  c.tools = [
    ["sculpt", "Sculpt", "Raise the ground. Hold Shift to lower."],
    ["smooth", "Smooth", "Soften spikes and blend transitions."],
    ["flatten", "Flatten", "Make a building pad at a chosen elevation."],
    ["ramp", "Ramp", "Click two endpoints to connect their elevations."],
    ["stamp", "Stamp", "Place a transformed procedural terrain feature."],
    ["erode", "Erode", "Run a local thermal or hydraulic erosion pass."],
    ["paint", "Paint", "Paint a material or a named biome mask."],
    ["scatter", "Scatter", "Place deterministic assets inside the brush."],
    [
      "spline",
      "Spline",
      "Click control points, or use viewport arrows and Space. Ctrl+Enter finishes the road or river.",
    ],
    ["water", "Water", "Flood a connected basin from the clicked point."],
    [
      "select",
      "Select",
      "Select a prop or recipe landform. Drag its handles or enter precise values.",
    ],
  ];
  c.options = {
    flatten: { height: 24 },
    stamp: { shape: "mountain", mirrorX: false },
    erode: { method: "thermal" },
    paint: { material: "dirt", mode: "material", biome: "forest" },
    scatter: { asset: "pine", count: 180, erase: false },
    spline: { kind: "road", width: 12, depth: 4 },
    water: { kind: "lake", level: 5 },
    ramp: { width: 22 },
  };
  c.terrain = Terrain.fromJSON(c.initial.document.recipe);
  c.state = null;
  c.renderedRecipe = null;
  c.view = c.providedView;
  c.selected = c.terrain.layers[0]?.id;
  c.active = "sculpt";
  c.preset = "alpine";
  c.navigation = false;
  c.points = [];
  c.stroke = null;
  c.busy = false;
  c.sequence = 0;
  c.workerBusy = false;
  c.evaluationRequests = 0;
  c.pending = null;
  c.worker = null;
  c.exportWorker = null;
  c.exportReject = null;
  c.timer = null;
  c.toastTimer = null;
  fillIcons();
  c.assetSignature = JSON.stringify(c.initial.document.assets ?? []);
  c.revision = c.initial.revision;
  c.renderedRevision = null;
  c.saving = false;
  c.loading = false;
  c.saved = c.initial;
  c.subscribe((snapshot) => {
    if (!c.saving) {
      c.saved = snapshot;
      c.useSnapshot(snapshot);
    }
  });
  c.terrain.subscribe(c.changed);
}
