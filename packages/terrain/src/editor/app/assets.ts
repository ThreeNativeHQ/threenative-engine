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
import type { IAssetOperation, IAssetResult } from "../assets.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import { inspectSpatial } from "../spatialInspector.js";
import { $, element, errorMessage } from "./dom.js";
import type { EditorSession } from "./session.js";
export function renderAssets(c: EditorSession): void {
  if (!document.getElementById("asset-count")) return;
  const assets = c.saved.document.assets ?? [];
  $("asset-count").textContent = String(assets.length);
  const list = $("asset-list");
  list.replaceChildren();
  for (const entry of assets) {
    const row = document.createElement("div");
    row.className = "asset-row";
    row.id = `asset-row-${entry.id}`;
    row.style.cssText = "display:flex;gap:6px;align-items:center;margin-bottom:5px;font-size:10px";
    const label = document.createElement("span");
    const bounds = entry.bounds;
    const size = bounds
      ? ([0, 1, 2] as const)
          .map((axis) => (bounds.max[axis] - bounds.min[axis]).toFixed(2))
          .join("×")
      : `${entry.width ?? "?"}×${entry.height ?? "?"}`;
    label.textContent = `${entry.id} · ${entry.kind} · ${size}`;
    label.style.flex = "1";
    row.append(label);
    if (entry.kind === "model") {
      const scale = document.createElement("input");
      scale.type = "number";
      scale.step = "0.01";
      scale.value = String(entry.adjust?.scale ?? 1);
      scale.title = "Scale from the file's units to metres";
      scale.style.width = "64px";
      scale.onchange = () =>
        c.attemptAsset({
          op: "adjust",
          id: entry.id,
          adjust: { scale: Number(scale.value), pivot: entry.adjust?.pivot ?? "base" },
        });
      row.append(scale);
    }
    if (entry.kind === "image") {
      const mapped = Object.entries(c.saved.document.surfaces ?? {})
        .filter(([, mapping]) => mapping.asset === entry.id)
        .map(([input]) => input);
      if (mapped.length) label.textContent += ` → ${mapped.join(", ")}`;
      const inputs = c.view.surfaceInputs?.() ?? [];
      if (inputs.length) {
        const choose = document.createElement("select");
        choose.title = "Which of this project's surface inputs this image replaces";
        for (const { input } of inputs) choose.add(new Option(input, input));
        const use = document.createElement("button");
        use.className = "secondary";
        use.textContent = "Use";
        use.onclick = () => c.attemptAsset({ op: "map", input: choose.value, asset: entry.id });
        row.append(choose, use);
      }
    }
    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.onclick = () => c.attemptAsset({ op: "remove", id: entry.id });
    row.append(remove);
    list.append(row);
  }
}

export function attemptAsset(
  c: EditorSession,
  operation: IAssetOperation,
): Promise<(IAssetResult & { revision: string }) | undefined> {
  return c.inLane(() => c.runAsset(operation));
}

export async function runAsset(
  c: EditorSession,
  operation: IAssetOperation,
): Promise<(IAssetResult & { revision: string }) | undefined> {
  try {
    const result = await c.assetOperation(operation, c.revision);
    c.revision = result.revision;
    const next = { ...c.saved.document };
    next.assets = result.assets.length ? [...result.assets] : undefined;
    next.surfaces = Object.keys(result.surfaces ?? {}).length ? result.surfaces : undefined;
    c.saved = { ...c.saved, revision: result.revision, document: next };
    c.view.setDocument(next, result.revision);
    c.syncAssets(next);
    c.renderAssets();
    c.renderEnvironment();
    c.renderOptions();
    $("asset-error").textContent = "";
    return result;
  } catch (error) {
    $("asset-error").textContent = errorMessage(error);
    c.toast(errorMessage(error));
    return undefined;
  }
}

export async function importFile(
  c: EditorSession,
  file: File,
): Promise<(IAssetResult & { revision: string }) | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return c.attemptAsset({
    op: "upload",
    id: c.assetId(file.name),
    name: file.name,
    data: btoa(binary),
    replace: $("asset-replace").checked,
  });
}
export function installAssets(c: EditorSession): void {
  c.assetPanel = document.createElement("details");
  c.assetPanel.id = "asset-inspector";
  c.assetPanel.className = "inspector";
  c.assetPanel.replaceChildren(
    element(
      "summary",
      { class: "inspector-header" },
      element("span", {}, "PROJECT ASSETS"),
      element("span", { id: "asset-count", class: "count-tag" }, "0"),
    ),
    element(
      "div",
      {
        id: "asset-drop",
        class: "field-label",
        style: "border:1px dashed var(--border);padding:10px;margin-bottom:9px",
      },
      "Drop a .glb or image here",
      element("input", {
        id: "asset-file",
        type: "file",
        accept: ".glb,.png,.jpg,.jpeg,.webp,.hdr,.exr,model/gltf-binary,image/*",
      }),
    ),
    element(
      "label",
      { class: "field-label" },
      element(
        "span",
        {},
        element("input", { id: "asset-replace", type: "checkbox" }),
        " Replace an asset with the same name",
      ),
    ),
    element("div", { id: "asset-list" }),
    element("div", { id: "asset-error", class: "inline-error" }),
  );
  c.assetPanel.style.cssText = "overflow-y:auto;min-height:0;max-height:40vh";
  c.sidebar.insertBefore(c.assetPanel, c.sidebar.querySelector(".inspector"));
  c.assetId = (name) =>
    name
      .replace(/\.[^.]+$/u, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "asset";
  const fileInput = $("asset-file");
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) await c.importFile(file);
  };
  $("asset-drop").ondragover = (event) => event.preventDefault();
  $("asset-drop").ondrop = async (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (file) await c.importFile(file);
  };
}
