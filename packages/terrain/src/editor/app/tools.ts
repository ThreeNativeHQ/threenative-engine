import { MATERIAL_IDS } from "../../index.js";
import { icon } from "../icons.js";
import { $, element, errorMessage, field } from "./dom.js";
import type { EditorSession } from "./session.js";
export function brush(c: EditorSession) {
  return {
    radius: Number($("brush-radius").value),
    strength: Number($("brush-strength").value),
    falloff: Number($("brush-falloff").value),
    shape: $("brush-shape").value as "circle" | "square",
    rotation: Number($("brush-rotation").value),
    spacing: Number($("brush-spacing").value),
    jitter: Number($("brush-jitter").value),
  };
}
export function optionSelect(
  _c: EditorSession,
  label: string,
  key: string,
  choices: readonly string[],
  value: string,
) {
  const input = element("select", { "data-option": key });
  for (const choice of choices)
    input.add(
      new Option(choice.charAt(0).toUpperCase() + choice.slice(1), choice, false, choice === value),
    );
  return field(label, input);
}
export function optionNumber(
  _c: EditorSession,
  label: string,
  key: string,
  value: number,
  step = 1,
) {
  return field(
    label,
    element("input", {
      type: "number",
      "data-option": key,
      value: String(value),
      step: String(step),
    }),
  );
}
export function renderOptions(c: EditorSession): void {
  const nodes: HTMLElement[] = [];
  const note = (text: string) => nodes.push(element("p", { class: "small muted" }, text));
  switch (c.active) {
    case "flatten":
      nodes.push(c.optionNumber("Target elevation (m)", "height", c.options.flatten.height));
      note("Use the terrain Y coordinate as a guide.");
      break;
    case "stamp":
      nodes.push(
        c.optionSelect(
          "Stamp shape",
          "shape",
          ["mountain", "crater", "ridge", "valley", "mesa", "dune"],
          c.options.stamp.shape,
        ),
      );
      note(
        "Strength controls amplitude. Rotate in Brush dynamics. JSON also supports anisotropic scale and mirrored heightmaps.",
      );
      break;
    case "erode":
      nodes.push(
        c.optionSelect("Simulation", "method", ["thermal", "hydraulic"], c.options.erode.method),
      );
      note("Evaluates on the current heightfield, then blends inside the brush footprint.");
      break;
    case "paint": {
      const o = c.options.paint;
      nodes.push(c.optionSelect("Paint target", "mode", ["material", "biome"], o.mode));
      if (o.mode === "biome")
        nodes.push(
          field("Biome name", element("input", { "data-option": "biome", value: o.biome })),
        );
      else {
        const grid = element("div", { class: "swatch-grid" });
        MATERIAL_IDS.forEach((id, i) => {
          const colour = c.materialColours[i];
          if (!colour) throw new Error(`Missing material colour: ${id}`);
          const swatch = element(
            "button",
            {
              class: `swatch${o.material === id ? " active" : ""}`,
              "data-material": id,
              title: id,
            },
            element("i", {
              style: `background:rgb(${colour.map((value) => Math.round(value * 255)).join(",")})`,
            }),
            element("span", {}, id),
          );
          grid.append(swatch);
        });
        nodes.push(grid);
      }
      break;
    }
    case "scatter": {
      const o = c.options.scatter;
      const assets = c.view.propAssets?.() ?? ["pine", "boulder", "grass"];
      nodes.push(
        c.optionSelect(
          "Asset ID",
          "asset",
          assets,
          assets.includes(o.asset) ? o.asset : (assets[0] ?? ""),
        ),
        c.optionNumber("Requested instances", "count", o.count),
      );
      const erase = element("input", { type: "checkbox", "data-option": "erase" });
      erase.checked = o.erase;
      nodes.push(field("", element("span", {}, erase, " Erase this asset inside brush")));
      note("The palette is this project's own assets; register another through the view.");
      break;
    }
    case "spline": {
      const o = c.options.spline;
      nodes.push(
        c.optionSelect("Spline type", "kind", ["road", "river"], o.kind),
        c.optionNumber("Width (m)", "width", o.width),
      );
      if (o.kind === "river") nodes.push(c.optionNumber("River depth (m)", "depth", o.depth));
      note("Control points retain their elevations. Edit the layer JSON for precise profiles.");
      break;
    }
    case "water": {
      const o = c.options.water;
      nodes.push(
        c.optionSelect("Water body", "kind", ["lake", "ocean"], o.kind),
        c.optionNumber("Water level (m)", "level", o.level, 0.5),
      );
      note("Lake seed must be below the water level. Oceans flood from map boundaries.");
      break;
    }
    case "ramp":
      nodes.push(c.optionNumber("Ramp width (m)", "width", c.options.ramp.width));
      note("First click: start. Second click: end. The shoulder blends into the terrain.");
      break;
  }
  $("tool-options").replaceChildren(...nodes);
}
export function selectTool(c: EditorSession, id: string): void {
  const tool = c.tools.find((tool) => tool[0] === id);
  if (!tool) throw new Error(`Unknown editor tool: ${id}`);
  c.stroke = null;
  c.active = id;
  document.body.dataset.terrainTool = id;
  c.navigation = false;
  c.view.setNavigation(false);
  c.view.setSelection?.(id === "select");
  c.view.setBrush(null);
  $("navigate-btn").classList.remove("active");
  c.points = [];
  c.showPoints();
  const i = c.tools.indexOf(tool);
  $("brush-title").textContent =
    id === "select" ? "Select a prop or landform" : `${tool[1]} terrain`;
  $("brush-desc").textContent = tool[2];
  $("tool-key").textContent = id === "select" ? "Q" : String((i + 1) % 10);
  for (const button of document.querySelectorAll<HTMLElement>(".tool-button")) {
    button.classList.toggle("active", button.dataset.tool === id);
    button.setAttribute("aria-pressed", String(button.dataset.tool === id));
  }
  c.renderOptions();
  $("canvas-help").replaceChildren(
    icon("mouse"),
    element("span", {}, `${tool[2]} `, element("b", {}, "·"), " Right-drag navigates"),
  );
}
export function installTools(c: EditorSession): void {
  c.tools.forEach(([id, name], i) => {
    const button = element(
      "button",
      { class: "tool-button", "data-tool": id },
      icon(id === "select" ? "mouse" : id),
      element("span", {}, name),
      element("small", {}, id === "select" ? "Q" : String((i + 1) % 10)),
    );
    button.onclick = () => c.selectTool(id);
    $("tool-grid").append(button);
  });
  $("tool-options").onchange = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const key = target.dataset.option;
    if (!key) return;
    const options = c.options[c.active as keyof typeof c.options];
    if (!options || !(key in options)) return;
    // The controls above define each option's type; the evaluator validates the resulting recipe.
    Object.assign(options, {
      [key]:
        target instanceof HTMLInputElement && target.type === "checkbox"
          ? target.checked
          : target.type === "number"
            ? Number(target.value)
            : target.value,
    });
    if (key === "mode" || key === "kind") c.renderOptions();
  };
  $("tool-options").onclick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>("[data-material]");
    const material = button?.dataset.material;
    if (material && MATERIAL_IDS.includes(material as (typeof MATERIAL_IDS)[number])) {
      c.options.paint.material = material as (typeof MATERIAL_IDS)[number];
      c.renderOptions();
    }
  };
  const fields: [string, string, (value: number) => string][] = [
    ["brush-radius", "radius-value", (v) => `${v} m`],
    ["brush-strength", "strength-value", (v) => `${Math.round(v * 100)}%`],
    ["brush-falloff", "falloff-value", (v) => `${Math.round(v * 100)}%`],
    ["brush-rotation", "rotation-value", (v) => `${v}°`],
    ["brush-spacing", "spacing-value", (v) => `${Math.round(v * 100)}%`],
    ["brush-jitter", "jitter-value", (v) => `${Math.round(v * 100)}%`],
  ];
  for (const [id, out, format] of fields) {
    $(id).setAttribute("aria-label", id.replace("brush-", "Brush "));
    $(id).oninput = () => {
      $(out).textContent = format(Number($(id).value));
    };
  }
}
