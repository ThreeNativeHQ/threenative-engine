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
import type { IEnvironment, IEnvironmentOperation, IEnvironmentResult } from "../environment.js";
import { fillIcons, icon } from "../icons.js";
import { PRESETS, createPreset } from "../presets.js";
import { inspectSpatial } from "../spatialInspector.js";
import { $, element, errorMessage, field } from "./dom.js";
import type { EditorSession } from "./session.js";
export function renderEnvironment(c: EditorSession): void {
  if (!document.getElementById("environment-count")) return;
  const live = c.view.environment?.().read() ?? {};
  for (const [section, key, , type] of c.envFields) {
    const fields = section ? live[section] : live;
    const value =
      fields && typeof fields === "object" ? (fields as Record<string, unknown>)[key] : undefined;
    const input = $(c.envId(section, key));
    if (type === "asset") {
      // Every registered environment or ordinary image, plus the procedural default.
      const choices = (c.saved.document.assets ?? []).filter(
        (entry) => entry.kind === "environment" || entry.kind === "image",
      );
      input.replaceChildren(
        new Option("(procedural)", ""),
        ...choices.map((entry) => new Option(entry.id, entry.id)),
      );
      input.value = typeof value === "string" ? value : "";
      continue;
    }
    if (document.activeElement !== input && value !== undefined) {
      if (type === "color") input.value = c.hex(value);
      else if (typeof value === "number") input.value = String(Number(value.toFixed(6)));
    }
  }
  $("environment-count").textContent = String(
    Object.keys(c.saved.document.environment ?? {}).length,
  );
}

export function attemptEnvironment(
  c: EditorSession,
  operation: IEnvironmentOperation,
): Promise<(IEnvironmentResult & { revision: string }) | undefined> {
  return c.inLane(() => c.runEnvironment(operation));
}

export async function runEnvironment(
  c: EditorSession,
  operation: IEnvironmentOperation,
): Promise<(IEnvironmentResult & { revision: string }) | undefined> {
  try {
    const result = await c.environmentOperation(operation, c.revision);
    c.revision = result.revision;
    c.saved = {
      ...c.saved,
      revision: result.revision,
      document: { ...c.saved.document, environment: result.environment },
    };
    c.view.environment?.().apply(result.environment);
    c.renderEnvironment();
    $("environment-error").textContent = "";
    return result;
  } catch (error) {
    $("environment-error").textContent = errorMessage(error);
    c.toast(errorMessage(error));
    c.renderEnvironment();
    return undefined;
  }
}
export function installEnvironment(c: EditorSession): void {
  c.envFields = [
    ["sun", "azimuth", "Sun azimuth °", "number", "1"],
    ["sun", "elevation", "Sun elevation °", "number", "1"],
    ["sun", "intensity", "Sun intensity", "number", "0.1"],
    ["sun", "colour", "Sun colour", "color"],
    ["fill", "intensity", "Sky fill", "number", "0.05"],
    ["sky", "colour", "Sky colour", "color"],
    ["sky", "image", "Sky image", "asset"],
    ["sky", "rotation", "Sky rotation °", "number", "1"],
    ["sky", "intensity", "Sky intensity", "number", "0.05"],
    ["lighting", "image", "Lighting image", "asset"],
    ["lighting", "rotation", "Lighting rotation °", "number", "1"],
    ["lighting", "intensity", "Lighting intensity", "number", "0.05"],
    ["fog", "density", "Haze density", "number", "0.0001"],
    ["fog", "colour", "Haze colour", "color"],
    [null, "exposure", "Exposure", "number", "0.05"],
    ["ocean", "shallow", "Sea shallow", "color"],
    ["ocean", "deep", "Sea deep", "color"],
  ];
  c.envId = (section, key) => `env-${section ?? "root"}-${key}`;
  c.environmentPanel = document.createElement("details");
  c.environmentPanel.id = "environment-inspector";
  c.environmentPanel.className = "inspector";
  c.environmentPanel.replaceChildren(
    element(
      "summary",
      { class: "inspector-header" },
      element("span", {}, "ENVIRONMENT"),
      element("span", { id: "environment-count", class: "count-tag" }, "0"),
    ),
    ...c.envFields.map(([section, key, label, type, step]) =>
      field(
        label,
        type === "asset"
          ? element(
              "select",
              { id: c.envId(section, key) },
              element("option", { value: "" }, "(procedural)"),
            )
          : element("input", { id: c.envId(section, key), type, ...(step ? { step } : {}) }),
      ),
    ),
    element("button", { id: "environment-reset", class: "ghost full" }, "Reset to project look"),
    element("div", { id: "environment-error", class: "inline-error" }),
  );
  c.environmentPanel.style.cssText = "overflow-y:auto;min-height:0;max-height:46vh";
  c.sidebar.insertBefore(c.environmentPanel, c.sidebar.querySelector(".inspector"));
  c.hex = (value) =>
    typeof value === "string" && /^#[0-9a-f]{6}$/u.test(value) ? value : "#000000";
  c.lane = Promise.resolve();
  for (const [section, key, , type] of c.envFields) {
    const input = $(c.envId(section, key));
    input.onchange = () => {
      const raw = input.value;
      // An image field's empty choice returns the sky or lighting to its procedural default.
      const value = type === "color" ? raw : type === "asset" ? raw || null : Number(raw);
      return c.attemptEnvironment({
        op: "patch",
        values: section ? { [section]: { [key]: value } } : { [key]: value },
      });
    };
  }
  $("environment-reset").onclick = () => c.attemptEnvironment({ op: "reset" });
}
