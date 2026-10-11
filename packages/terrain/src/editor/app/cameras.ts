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
import type {
  ICameraOperation,
  ICameraResult,
  IFocusOutcome,
  IFocusRequest,
  IFocusTarget,
} from "../cameras.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import type { IAuthoringDocument } from "../server.js";
import { inspectSpatial } from "../spatialInspector.js";
import { $, element, errorMessage, field } from "./dom.js";
import type { EditorSession } from "./session.js";
export function selectedCameraId(c: EditorSession): string {
  return $("camera-name").value.trim();
}

export function renderCameras(c: EditorSession, document_: IAuthoringDocument): void {
  // The panel is created after the first snapshot subscription; ignore anything earlier.
  if (!document.getElementById("camera-count")) return;
  const cameras = document_.cameras ?? [];
  const active = document_.activeCamera ?? null;
  $("camera-count").textContent = String(cameras.length);
  const list = $("camera-list");
  list.replaceChildren();

  for (const camera of cameras) {
    const row = document.createElement("button");
    row.id = `camera-row-${camera.id}`;
    row.className = `camera-row${camera.id === active ? " active" : ""}`;
    row.textContent = camera.name;
    const kind = document.createElement("small");
    kind.textContent =
      camera.projection === "orthographic" ? "ortho" : `${Math.round(camera.fov)}°`;
    row.append(kind);
    row.onclick = () => c.attemptCamera({ op: "activate", id: camera.id });
    list.append(row);
  }
  const live = cameras.find((camera) => camera.id === active);
  // The projection picker follows the live camera, so a save never contradicts what is drawn.
  if (live) $("camera-projection").value = live.projection;
  $("camera-error").textContent = "";
}

export async function attemptCamera(
  c: EditorSession,
  operation: ICameraOperation | { op: "focus" },
  target?: Omit<IFocusRequest, "aspect">,
): Promise<(ICameraResult & { revision: string }) | IFocusOutcome | undefined> {
  try {
    if (operation.op === "focus") {
      if (!target) throw Error("Camera focus requires a target");
      const result = c.view.cameras?.().focus(target);
      $("camera-error").textContent = result?.diagnostic ?? "";
      if (result?.diagnostic) c.toast(result.diagnostic);
      return result;
    }
    const result = await c.cameraOperation(operation, c.revision);
    c.revision = result.revision;
    c.saved = { ...c.saved, revision: result.revision };
    if (result.fallback) c.toast("Active camera deleted · back to the editor camera");
    c.renderCameras({
      ...c.saved.document,
      cameras: [...result.cameras],
      activeCamera: result.activeCamera,
    });
    $("camera-error").textContent = "";
    return result;
  } catch (error) {
    $("camera-error").textContent = errorMessage(error);
    c.toast(errorMessage(error));
    return undefined;
  }
}

export function focusTarget(c: EditorSession): IFocusTarget | undefined {
  const raw = $("camera-target").value.trim();
  if (!raw) return undefined;
  const numbers = raw.split(/\s+/u).map(Number);
  if (numbers.length === 3 && numbers.every((value) => Number.isFinite(value)))
    return { kind: "point", at: numbers as [number, number, number] };
  // One id names a prop, a landmark or a region; the view resolves whichever it knows.
  return {
    kind: raw.startsWith("region:") ? "region" : "prop",
    id: raw.replace(/^(region|landmark|prop):/u, ""),
  };
}
export function installCameras(c: EditorSession): void {
  c.cameraPanel = document.createElement("div");
  c.cameraPanel.id = "camera-inspector";
  c.cameraPanel.className = "inspector";
  c.cameraPanel.replaceChildren(
    element(
      "div",
      { class: "inspector-header" },
      element("span", {}, "OBSERVATION CAMERAS"),
      element("span", { id: "camera-count", class: "count-tag" }, "0"),
    ),
    element("div", { id: "camera-list" }),
    field("Name", element("input", { id: "camera-name", placeholder: "Camera name" })),
    field(
      "Projection",
      element(
        "select",
        { id: "camera-projection" },
        element("option", { value: "perspective" }, "Perspective"),
        element("option", { value: "orthographic" }, "Orthographic map"),
      ),
    ),
    element(
      "div",
      { class: "two-fields" },
      field(
        "Fov",
        element("input", { id: "camera-fov", type: "number", value: "60", min: "1", max: "170" }),
      ),
      field(
        "Margin",
        element("input", {
          id: "camera-margin",
          type: "number",
          value: "1.15",
          min: "1",
          step: "0.05",
        }),
      ),
    ),
    field(
      "Focus target",
      element("input", {
        id: "camera-target",
        placeholder: "prop id, landmark id, region id or x y z",
      }),
    ),
    element(
      "div",
      { class: "two-fields" },
      element("button", { id: "camera-save", class: "secondary" }, "Save current"),
      element("button", { id: "camera-activate", class: "secondary" }, "Activate"),
    ),
    element("button", { id: "camera-focus", class: "secondary full" }, "Focus target"),
    element("button", { id: "camera-delete", class: "ghost full" }, "Delete camera"),
    element("div", { id: "camera-error", class: "inline-error" }),
  );
  c.style = document.createElement("style");
  c.style.textContent =
    "#camera-inspector{overflow-y:auto;min-height:0}#camera-list{margin-bottom:9px;max-height:120px;overflow-y:auto}" +
    "#camera-row{display:flex;gap:6px;align-items:center;width:100%;justify-content:flex-start;margin-bottom:5px;font-size:10px}" +
    "#camera-row.active{border-color:var(--accent);color:var(--accent)}#camera-row small{margin-left:auto;opacity:.7}";
  document.head.append(c.style);
  const sidebar = document.querySelector<HTMLElement>(".right-sidebar");
  if (!sidebar) throw new Error("Camera inspector has no sidebar");
  c.sidebar = sidebar;
  c.sidebar.insertBefore(c.cameraPanel, c.sidebar.querySelector(".inspector"));
  $("camera-save").onclick = () => {
    const pose = c.view.cameras?.().read();
    if (!pose) throw Error("This view has no camera surface");
    const projection = $("camera-projection").value;
    c.attemptCamera({
      op: "create",
      camera: {
        id: `camera-${Date.now().toString(36)}`,
        name: $("camera-name").value.trim() || "Observation",
        position: pose.position,
        target: pose.target,
        up: pose.up,
        near: pose.near,
        far: pose.far,
        projection,
        ...(projection === "perspective"
          ? { fov: Number($("camera-fov").value) }
          : {
              extent: Math.max(
                1,
                Math.hypot(...pose.position.map((value) => value - pose.target[0])),
              ),
              zoom: 1,
            }),
      },
    });
  };
  $("camera-activate").onclick = () =>
    c.attemptCamera({ op: "activate", id: c.selectedCameraId() });
  $("camera-delete").onclick = () => c.attemptCamera({ op: "delete", id: c.selectedCameraId() });
  $("camera-focus").onclick = () => {
    const target = c.focusTarget();
    if (!target) return c.toast("Name a prop, landmark, region or x y z point");
    return c.attemptCamera({ op: "focus" }, { target, margin: Number($("camera-margin").value) });
  };
}
