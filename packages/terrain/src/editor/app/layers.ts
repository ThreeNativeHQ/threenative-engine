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
import { $, errorMessage } from "./dom.js";
import type { EditorSession } from "./session.js";
export function updateHistory(c: EditorSession): void {
  $("undo-btn").disabled = !c.terrain.canUndo;
  $("redo-btn").disabled = !c.terrain.canRedo;
}

export function renderLayers(c: EditorSession): void {
  const layers = c.terrain.layers;
  if (!layers.some((l) => l.id === c.selected)) c.selected = layers.at(-1)?.id;
  $("layer-count").textContent = String(layers.length);
  const list = $("layer-list");
  const focusedId = document.activeElement?.closest<HTMLElement>(".layer-row")?.dataset.id;
  list.replaceChildren();
  layers.forEach((l, i) => {
    const row = document.createElement("div");
    row.className = `layer-row${l.id === c.selected ? " selected" : ""}${l.enabled === false ? " disabled" : ""}`;
    row.draggable = true;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Select layer ${l.id}`);
    row.onkeydown = (event) => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        event.stopPropagation();
        row.click();
      }
    };
    row.dataset.id = l.id;
    const index = document.createElement("span");
    index.className = "layer-index";
    index.textContent = String(i + 1).padStart(2, "0");
    const glyph = document.createElement("span");
    glyph.className = "layer-icon";
    glyph.replaceChildren(
      icon(
        l.type === "materials" ? "paint" : ["river", "road"].includes(l.type) ? "spline" : l.type,
      ),
    );
    const label = document.createElement("div");
    label.className = "layer-label";
    const name = document.createElement("strong");
    const type = document.createElement("small");
    name.textContent = l.name ?? l.id;
    type.textContent = l.type;
    label.append(name, type);
    const eye = document.createElement("button");
    eye.className = "layer-eye";
    eye.replaceChildren(icon(l.enabled === false ? "eye-off" : "eye"));
    eye.title = l.enabled === false ? "Enable layer" : "Disable layer";
    eye.setAttribute("aria-label", `${eye.title}: ${l.name ?? l.id}`);
    eye.onclick = (e) => {
      e.stopPropagation();
      c.terrain.toggle(l.id, l.enabled === false);
    };
    row.append(index, glyph, label, eye);
    row.onclick = () => {
      c.selected = l.id;
      c.renderLayers();
      if (c.active === "select") c.view.selectLayer?.(l.id);
    };
    row.ondragstart = (e) => e.dataTransfer?.setData("text/plain", l.id);
    row.ondragover = (e) => e.preventDefault();
    row.ondrop = (e) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/plain");
      if (id) c.attempt(() => c.terrain.move(id, i));
    };
    list.append(row);
    if (focusedId === l.id) row.focus();
  });
  c.renderInspector();
  c.updateHistory();
}

export function renderInspector(c: EditorSession): void {
  const layer = c.selected ? c.terrain.layer(c.selected ?? "") : null;
  for (const id of [
    "selected-name",
    "selected-opacity",
    "selected-json",
    "apply-layer",
    "layer-up",
    "layer-down",
    "layer-duplicate",
    "layer-delete",
  ])
    $(id).disabled = !layer;
  $("selected-type").textContent = layer ? layer.type.toUpperCase() : "LAYER PROPERTIES";
  $("selected-name").value = layer?.name ?? layer?.id ?? "";
  $("selected-opacity").value = String(layer?.opacity ?? 1);
  $("opacity-value").textContent = `${Math.round((layer?.opacity ?? 1) * 100)}%`;
  $("selected-json").value = layer
    ? JSON.stringify({ params: layer.params, ...(layer.mask ? { mask: layer.mask } : {}) }, null, 2)
    : "";
  $("layer-error").textContent = "";
}
export function installLayers(c: EditorSession): void {
  $("undo-btn").onclick = () => c.terrain.undo();
  $("redo-btn").onclick = () => c.terrain.redo();
  $("selected-opacity").oninput = () => {
    $("opacity-value").textContent = `${Math.round(Number($("selected-opacity").value) * 100)}%`;
  };
  $("selected-opacity").onchange = () =>
    c.attempt(() =>
      c.terrain.update(c.selected ?? "", { opacity: Number($("selected-opacity").value) }),
    );
  $("selected-name").onchange = () =>
    c.attempt(() => c.terrain.update(c.selected ?? "", { name: $("selected-name").value }));
  $("apply-layer").onclick = () => {
    try {
      const patch = JSON.parse($("selected-json").value);
      if (
        !patch ||
        typeof patch !== "object" ||
        Array.isArray(patch) ||
        Object.keys(patch).some((k) => !["params", "mask"].includes(k))
      )
        throw Error('Use {"params": {...}, "mask": {...}}');
      const old = c.terrain.layer(c.selected ?? "");
      c.terrain.add({
        ...old,
        params: patch.params ?? old.params,
        mask: patch.mask ?? { type: "all" },
      });
      $("layer-error").textContent = "";
    } catch (e) {
      $("layer-error").textContent = errorMessage(e);
    }
  };
  $("layer-up").onclick = () =>
    c.attempt(() =>
      c.terrain.move(
        c.selected ?? "",
        Math.max(0, c.terrain.layers.findIndex((l) => l.id === c.selected) - 1),
      ),
    );
  $("layer-down").onclick = () =>
    c.attempt(() =>
      c.terrain.move(
        c.selected ?? "",
        Math.min(
          c.terrain.layers.length - 1,
          c.terrain.layers.findIndex((l) => l.id === c.selected) + 1,
        ),
      ),
    );
  $("layer-delete").onclick = () => c.attempt(() => c.terrain.remove(c.selected ?? ""));
  $("layer-duplicate").onclick = () =>
    c.attempt(() => {
      const layer = c.terrain.layer(c.selected ?? "");
      let i = 1;
      while (c.terrain.layers.some((l) => l.id === `${layer.id.slice(0, 85)}-copy-${i}`)) i++;
      const id = `${layer.id.slice(0, 85)}-copy-${i}`;
      c.terrain.add({ ...layer, id, name: `${(layer.name ?? layer.type).slice(0, 85)} copy` });
      c.selected = id;
      c.renderLayers();
    });
}
