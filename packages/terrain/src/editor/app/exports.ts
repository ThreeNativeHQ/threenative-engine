import type { ExportKind, IExportArchive } from "../../core/types.js";
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
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import { inspectSpatial } from "../spatialInspector.js";
import type { EditorWorkerReply } from "../worker.js";
import { $, errorMessage } from "./dom.js";
import type { EditorSession } from "./session.js";
export function download(
  c: EditorSession,
  output: { name: string; bytes: Uint8Array; type?: string; mime?: string },
): void {
  const blob = new Blob([new Uint8Array(output.bytes)], { type: output.type ?? output.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = output.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportKind(c: EditorSession, kind: ExportKind | "world"): Promise<void> {
  $("export-error").textContent = "";
  if (kind === "project") {
    c.download(await makeExport(c.state, c.terrain.toJSON(), kind));
    return;
  }
  // The whole world comes from the live view, because only the view holds the resolved models,
  // the grounded transforms and the baked water. The worker export below is terrain-only, and
  // presenting that as a world is the thing this card exists to stop.
  if (kind === "world") {
    if (!c.view.exportCurrentWorld) throw Error("This view cannot export a world GLB");
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]"))
      b.disabled = true;
    c.setBusy(true, "Baking world GLB");
    try {
      c.download(await c.view.exportCurrentWorld());
      c.toast("World GLB ready.");
    } catch (e) {
      $("export-error").textContent = errorMessage(e);
    } finally {
      for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]"))
        b.disabled = false;
      if (!c.workerBusy && !c.pending) c.setBusy(false);
    }
    return;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]")) {
    b.disabled = true;
  }
  c.setBusy(true, "Baking export");
  try {
    const output = await new Promise<IExportArchive>((resolve, reject) => {
      c.exportReject = reject;
      c.exportWorker = new Worker(c.workerURL(), { type: "module" });
      c.exportWorker.onmessage = ({ data }: MessageEvent<EditorWorkerReply>) => {
        if (data.type === "exported") resolve(data.output);
        else if (data.type === "error") reject(new Error(data.error));
        else if (data.type === "progress")
          $("busy-text").textContent = `Baking ${data.progress.index + 1}/${data.progress.total}`;
      };
      c.exportWorker.onerror = (e) => {
        e.preventDefault();
        reject(new Error(e.message));
      };
      c.exportWorker.postMessage({
        type: "export",
        id: 1,
        recipe: c.terrain.toJSON(),
        resolution: Number($("export-resolution").value),
        kind,
      });
    });
    c.download(output);
    c.toast(`Export ready: ${output.name}`);
  } catch (e) {
    $("export-error").textContent = errorMessage(e);
  } finally {
    c.exportWorker?.terminate();
    c.exportWorker = null;
    c.exportReject = null;
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]")) {
      b.disabled = false;
    }
    if (!c.workerBusy && !c.pending) c.setBusy(false);
  }
}
export function installExports(c: EditorSession): void {
  $("recipe-btn").onclick = () => {
    $<HTMLTextAreaElement>("recipe-editor").value = JSON.stringify(c.terrain.toJSON(), null, 2);
    $("recipe-error").textContent = "";
    $<HTMLDialogElement>("recipe-dialog").showModal();
  };
  $("close-recipe").onclick = () => $<HTMLDialogElement>("recipe-dialog").close();
  $("apply-recipe").onclick = () => {
    try {
      c.terrain.loadJSON($<HTMLTextAreaElement>("recipe-editor").value);
      $("recipe-error").textContent = "";
      c.toast("Recipe validated and applied.");
    } catch (e) {
      $("recipe-error").textContent = errorMessage(e);
    }
  };
  $("copy-recipe").onclick = async () => {
    try {
      await navigator.clipboard.writeText($<HTMLTextAreaElement>("recipe-editor").value);
      c.toast("Recipe copied.");
    } catch {
      const ta = $<HTMLTextAreaElement>("recipe-editor");
      ta.focus();
      ta.select();
      c.toast("Clipboard unavailable. JSON selected; press Ctrl/⌘ C.");
    }
  };
  $("export-btn").onclick = () => {
    $("export-error").textContent = "";
    $<HTMLDialogElement>("export-dialog").showModal();
  };
  $("close-export").onclick = () => $<HTMLDialogElement>("export-dialog").close();
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-export]"))
    b.onclick = () => {
      const kind = b.dataset.export;
      if (!kind) throw new Error("Missing export kind");
      return c.exportKind(kind as ExportKind | "world");
    };
  $("import-btn").onclick = () => $("import-file").click();
  $("import-file").onchange = async () => {
    const file = $("import-file").files?.[0];
    if (!file) return;
    try {
      if (file.size > 64 * 1024 * 1024) throw Error("File is larger than the 64 MB import limit");
      if (file.name.toLowerCase().endsWith(".json")) c.terrain.loadJSON(await file.text());
      else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const min = Number($("import-min").value);
        const max = Number($("import-max").value);
        let data: Awaited<ReturnType<typeof decodeHeightPNG>> | ReturnType<typeof decodeRAW16>;
        if (file.name.toLowerCase().endsWith(".png")) {
          const png = await decodeHeightPNG(bytes);
          data = png.hasEmbeddedRange ? png : await decodeHeightPNG(bytes, { min, max });
        } else {
          const n = Math.sqrt(bytes.length / 2);
          if (!Number.isInteger(n)) throw Error("RAW16 import requires a square heightfield");
          data = decodeRAW16(bytes, { width: n, height: n, min, max, littleEndian: true });
        }
        c.terrain.heightmap({
          label: "Imported heightmap",
          data: { width: data.width, height: data.height, values: data.values },
          blend: "replace",
        });
      }
      c.toast("File imported as an undoable edit.");
      $("export-error").textContent = "";
    } catch (e) {
      $("export-error").textContent = errorMessage(e);
    } finally {
      $("import-file").value = "";
    }
  };
}
