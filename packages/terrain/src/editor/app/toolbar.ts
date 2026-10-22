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
import { $, element } from "./dom.js";
import type { EditorSession } from "./session.js";
export function namePreset(c: EditorSession, id: string): void {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset: ${id}`);
  $("project-name").textContent = p.name;
  $("landscape-title").textContent = p.name;
  $("landscape-subtitle").textContent = p.subtitle;
  $("landscape-tag").textContent = `LANDSCAPE / ${p.tag}`;
}
export function installToolbar(c: EditorSession): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-panel]"))
    b.onclick = () => {
      for (const x of document.querySelectorAll<HTMLButtonElement>("[data-panel]")) {
        x.classList.toggle("active", x === b);
      }
      $("tools-panel").classList.toggle("hidden", b.dataset.panel !== "tools");
      $("generate-panel").classList.toggle("hidden", b.dataset.panel !== "generate");
    };
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.className = `preset-card${p.id === c.preset ? " active" : ""}`;
    b.dataset.preset = p.id;
    b.append(
      element(
        "span",
        { class: `preset-thumb ${p.id}` },
        icon(p.id === "desert" ? "terrace" : p.id === "island" ? "water" : "mountain"),
      ),
      element("span", {}, element("strong", {}, p.name), element("small", {}, p.tag)),
    );
    b.onclick = () => {
      c.preset = p.id;
      for (const el of document.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
        el.classList.toggle("active", el === b);
      }
    };
    $("preset-list").append(b);
  }
  $("generate-world").onclick = () =>
    c.attempt(() => {
      const next = createPreset(c.preset, {
        resolution: c.terrain.config.resolution,
        seed: Number($("seed-input").value),
        size: Number($("world-size").value),
      });
      c.terrain.loadJSON(next.toJSON());
      c.namePreset(c.preset);
      c.selected = c.terrain.layers[0]?.id;
      c.renderLayers();
      c.points = [];
      c.showPoints();
      c.view.frame();
      c.toast("Landscape regenerated. Undo restores the previous stack.");
    });
  c.passes = [
    [
      "noise",
      "Noise",
      () => c.terrain.noise({ label: "Detail noise", amplitude: 4, scale: 30, warp: 7 }),
    ],
    [
      "mountain",
      "Mountains",
      () =>
        c.terrain.stamp({
          label: "Mountain mass",
          at: [0, -80],
          radius: [135, 90],
          amplitude: 95,
          shape: "mountain",
        }),
    ],
    [
      "ramp",
      "Valleys",
      () =>
        c.terrain.stamp({
          label: "Valley basin",
          at: [0, 0],
          radius: [100, 150],
          amplitude: 35,
          shape: "valley",
        }),
    ],
    [
      "erode",
      "Erosion",
      () =>
        c.terrain.erode({
          label: "Hydraulic erosion",
          method: "hydraulic",
          droplets: 8000,
          maxSteps: 45,
        }),
    ],
    [
      "biome",
      "Biomes",
      () =>
        c.terrain.biome({
          label: "Forest biome",
          name: "forest",
          mask: Mask.and(Mask.height(5, 100, 10), Mask.slope(0, 35, 8)),
        }),
    ],
    [
      "scatter",
      "Populate",
      () =>
        c.terrain.scatter({
          label: "Forest population",
          asset: "pine",
          count: 800,
          minDistance: 5,
          mask: Mask.and(Mask.height(5, 100, 10), Mask.slope(0, 35, 8)),
        }),
    ],
  ];
  for (const [ico, label, fn] of c.passes) {
    const b = document.createElement("button");
    b.append(icon(ico), label);
    b.onclick = () => c.attempt(fn);
    $("pass-grid").append(b);
  }
  $("navigate-btn").onclick = () => {
    c.navigation = !c.navigation;
    c.view.setNavigation(c.navigation);
    $("navigate-btn").classList.toggle("active", c.navigation);
    c.view.setBrush(null);
  };
  $("view-angle").onchange = () => c.view.setView($("view-angle").value);
  $("render-mode").onchange = () => c.view.setMode($("render-mode").value);
  $("preview-resolution").onchange = c.build;
  $("frame-btn").onclick = () => c.view.frame();
  $("rebuild-btn").onclick = c.build;
  $("cancel-build").onclick = c.cancelBuild;
  $("mobile-tools").onclick = () => {
    document.body.dataset.mobilePanel =
      document.body.dataset.mobilePanel === "tools" ? "" : "tools";
  };
  $("mobile-layers").onclick = () => {
    document.body.dataset.mobilePanel =
      document.body.dataset.mobilePanel === "layers" ? "" : "layers";
  };
}
