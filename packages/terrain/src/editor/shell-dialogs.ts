import { shellElement } from "./shell.js";
export function appendShellDialogs(parent: Node): void {
  const n1 = shellElement(parent, "dialog", { id: "recipe-dialog", class: "recipe-dialog" });
  const n2 = shellElement(n1, "div", { class: "dialog-header" });
  const n3 = shellElement(n2, "div");
  const n4 = shellElement(n3, "span", { class: "eyebrow" });
  n4.appendChild(document.createTextNode("AI-FIRST AUTHORING"));
  const n5 = shellElement(n3, "h2");
  n5.appendChild(document.createTextNode("The recipe is the source."));
  const n6 = shellElement(n3, "p");
  n6.appendChild(
    document.createTextNode("Edit structured data, not a mesh. No JavaScript is executed here."),
  );
  const n7 = shellElement(n2, "button", {
    id: "close-recipe",
    class: "icon-button dialog-close",
    "aria-label": "Close recipe",
  });
  n7.appendChild(document.createTextNode("×"));
  const n8 = shellElement(n1, "div", { class: "recipe-layout" });
  const n9 = shellElement(n8, "div");
  const n10 = shellElement(n9, "div", { class: "json-label" });
  const n11 = shellElement(n10, "span");
  n11.appendChild(document.createTextNode("PROJECT RECIPE"));
  const n12 = shellElement(n10, "span");
  n12.appendChild(document.createTextNode("schema version 1"));
  shellElement(n9, "textarea", {
    id: "recipe-editor",
    spellcheck: "false",
    "aria-label": "Project recipe JSON",
  });
  shellElement(n9, "div", { id: "recipe-error", class: "inline-error" });
  const n15 = shellElement(n8, "aside", { class: "api-note" });
  const n16 = shellElement(n15, "span", { class: "eyebrow" });
  n16.appendChild(document.createTextNode("CODE API"));
  const n17 = shellElement(n15, "h3");
  n17.appendChild(document.createTextNode("Give your AI"));
  shellElement(n17, "br");
  n17.appendChild(document.createTextNode("better tools."));
  const n19 = shellElement(n15, "p");
  n19.appendChild(
    document.createTextNode(
      "The headless engine runs in Node, a worker, or your game. Every action has a named operation.",
    ),
  );
  const n20 = shellElement(n15, "pre");
  const n21 = shellElement(n20, "code");
  n21.appendChild(
    document.createTextNode(
      'terrain.stamp({\n  id: "north-peak",\n  at: [80, -100],\n  radius: [90, 60],\n  amplitude: 80\n});\n\nterrain.update("river-main", {\n  params: { width: 24 }\n});\n\nterrain.undo();\nterrain.toJSON();',
    ),
  );
  const n22 = shellElement(n15, "div", { class: "api-footnote" });
  n22.appendChild(document.createTextNode("In DevTools: "));
  const n23 = shellElement(n22, "code");
  n23.appendChild(document.createTextNode("strata.terrain"));
  shellElement(n22, "br");
  n22.appendChild(document.createTextNode("On disk: "));
  const n25 = shellElement(n22, "code");
  n25.appendChild(document.createTextNode("src/index.js"));
  shellElement(n22, "br");
  n22.appendChild(document.createTextNode("Agent instructions: "));
  const n27 = shellElement(n22, "code");
  n27.appendChild(document.createTextNode("docs/AGENT_GUIDE.md"));
  const n28 = shellElement(n1, "div", { class: "dialog-footer" });
  const n29 = shellElement(n28, "button", { id: "copy-recipe", class: "ghost" });
  shellElement(n29, "span", { "data-icon": "copy" });
  n29.appendChild(document.createTextNode("Copy JSON"));
  const n31 = shellElement(n28, "span", { class: "muted small" });
  n31.appendChild(
    document.createTextNode("Validation failures leave the current project untouched."),
  );
  const n32 = shellElement(n28, "button", { id: "apply-recipe", class: "primary" });
  n32.appendChild(document.createTextNode("Validate & apply"));
  const n33 = shellElement(parent, "dialog", { id: "export-dialog", class: "export-dialog" });
  const n34 = shellElement(n33, "div", { class: "dialog-header" });
  const n35 = shellElement(n34, "div");
  const n36 = shellElement(n35, "span", { class: "eyebrow" });
  n36.appendChild(document.createTextNode("PORTABLE BY DESIGN"));
  const n37 = shellElement(n35, "h2");
  n37.appendChild(document.createTextNode("Take your terrain anywhere."));
  const n38 = shellElement(n35, "p");
  n38.appendChild(document.createTextNode("Keep the recipe. Bake the data your engine needs."));
  const n39 = shellElement(n34, "button", {
    id: "close-export",
    class: "icon-button dialog-close",
    "aria-label": "Close export",
  });
  n39.appendChild(document.createTextNode("×"));
  const n40 = shellElement(n33, "div", { class: "export-settings" });
  const n41 = shellElement(n40, "label", { class: "field-label" });
  n41.appendChild(document.createTextNode("Bake resolution"));
  const n42 = shellElement(n41, "select", { id: "export-resolution" });
  const n43 = shellElement(n42, "option", { value: "129" });
  n43.appendChild(document.createTextNode("129 × 129"));
  const n44 = shellElement(n42, "option", { value: "257", selected: "" });
  n44.appendChild(document.createTextNode("257 × 257"));
  const n45 = shellElement(n42, "option", { value: "513" });
  n45.appendChild(document.createTextNode("513 × 513"));
  const n46 = shellElement(n42, "option", { value: "1025" });
  n46.appendChild(document.createTextNode("1025 × 1025"));
  const n47 = shellElement(n40, "p");
  n47.appendChild(document.createTextNode("Preview and export resolutions are independent."));
  shellElement(n47, "br");
  n47.appendChild(document.createTextNode("High-resolution bakes run in a separate worker."));
  const n49 = shellElement(n33, "div", { class: "export-grid" });
  const n50 = shellElement(n49, "button", { class: "export-card", "data-export": "project" });
  shellElement(n50, "span", { "data-icon": "code" });
  const n52 = shellElement(n50, "strong");
  n52.appendChild(document.createTextNode("Project recipe"));
  const n53 = shellElement(n50, "small");
  n53.appendChild(document.createTextNode("JSON · layers, masks, seeds"));
  const n54 = shellElement(n49, "button", { class: "export-card", "data-export": "png" });
  shellElement(n54, "span", { "data-icon": "image" });
  const n56 = shellElement(n54, "strong");
  n56.appendChild(document.createTextNode("Heightmap"));
  const n57 = shellElement(n54, "small");
  n57.appendChild(document.createTextNode("16-bit grayscale PNG"));
  const n58 = shellElement(n49, "button", { class: "export-card", "data-export": "raw" });
  shellElement(n58, "span", { "data-icon": "grid" });
  const n60 = shellElement(n58, "strong");
  n60.appendChild(document.createTextNode("RAW heightfield"));
  const n61 = shellElement(n58, "small");
  n61.appendChild(document.createTextNode("RAW16 + scale metadata ZIP"));
  const n62 = shellElement(n49, "button", { class: "export-card", "data-export": "splat" });
  shellElement(n62, "span", { "data-icon": "paint" });
  const n64 = shellElement(n62, "strong");
  n64.appendChild(document.createTextNode("Splatmaps"));
  const n65 = shellElement(n62, "small");
  n65.appendChild(document.createTextNode("8 channels · 2 RGBA PNGs"));
  const n66 = shellElement(n49, "button", { class: "export-card", "data-export": "glb" });
  shellElement(n66, "span", { "data-icon": "cube" });
  const n68 = shellElement(n66, "strong");
  n68.appendChild(document.createTextNode("Terrain mesh"));
  const n69 = shellElement(n66, "small");
  n69.appendChild(document.createTextNode("GLB · baked vertex colors"));
  const n70 = shellElement(n49, "button", {
    class: "export-card featured",
    "data-export": "world",
  });
  shellElement(n70, "span", { "data-icon": "cube" });
  const n72 = shellElement(n70, "strong");
  n72.appendChild(document.createTextNode("World GLB"));
  const n73 = shellElement(n70, "small");
  n73.appendChild(document.createTextNode("GLB · terrain, props, water, PBR maps"));
  const n74 = shellElement(n49, "button", { class: "export-card", "data-export": "runtime" });
  shellElement(n74, "span", { "data-icon": "layers" });
  const n76 = shellElement(n74, "strong");
  n76.appendChild(document.createTextNode("Runtime bundle"));
  const n77 = shellElement(n74, "small");
  n77.appendChild(document.createTextNode("Chunk LODs · collision · placements"));
  const n78 = shellElement(n33, "div", { class: "import-area" });
  const n79 = shellElement(n78, "div");
  const n80 = shellElement(n79, "strong");
  n80.appendChild(document.createTextNode("Bring your own terrain"));
  const n81 = shellElement(n79, "p");
  n81.appendChild(document.createTextNode("Project JSON, grayscale PNG8/16, or square RAW16 LE."));
  const n82 = shellElement(n78, "button", { id: "import-btn", class: "secondary" });
  shellElement(n82, "span", { "data-icon": "import" });
  n82.appendChild(document.createTextNode("Import file"));
  shellElement(n78, "input", {
    id: "import-file",
    class: "hidden",
    type: "file",
    accept: ".json,.png,.raw,.r16",
  });
  const n85 = shellElement(n78, "div", { class: "import-ranges" });
  const n86 = shellElement(n85, "label");
  n86.appendChild(document.createTextNode("External map minimum (m)"));
  shellElement(n86, "input", { id: "import-min", type: "number", value: "0" });
  const n88 = shellElement(n85, "label");
  n88.appendChild(document.createTextNode("External map maximum (m)"));
  shellElement(n88, "input", { id: "import-max", type: "number", value: "180" });
  shellElement(n33, "div", { id: "export-error", class: "inline-error" });
  const n91 = shellElement(n33, "div", { class: "export-note" });
  n91.appendChild(
    document.createTextNode(
      "World GLB carries the terrain, the placed models with their final transforms, this project’s PBR maps and its baked water; lighting, sky, fog and live water stay the receiving game’s. The terrain-only cards export no props, and the runtime bundle includes deterministic placements separately. No navmesh or EXR export.",
    ),
  );
}
