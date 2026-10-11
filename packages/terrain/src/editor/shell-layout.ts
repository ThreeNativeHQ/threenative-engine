import { shellElement } from "./shell.js";
export function appendShellLayout(parent: Node): void {
  const n1 = shellElement(parent, "header", { class: "app-header" });
  n1.appendChild(document.createTextNode("\n "));
  const n2 = shellElement(n1, "div", { class: "brand-wrap" });
  const n3 = shellElement(n2, "svg", {
    class: "brand-mark",
    viewBox: "0 0 36 36",
    fill: "none",
    "aria-hidden": "true",
  });
  shellElement(n3, "path", {
    d: "M3 27 14 8l7 11 5-7 8 15M3 32h31M8 27l7-11 6 11M21 27l5-7 4 7",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linejoin": "round",
  });
  const n5 = shellElement(n2, "div");
  const n6 = shellElement(n5, "strong", { id: "brand" });
  n6.appendChild(document.createTextNode("STRATA"));
  const n7 = shellElement(n5, "span");
  n7.appendChild(document.createTextNode("TERRAIN STUDIO"));
  n1.appendChild(document.createTextNode("\n "));
  shellElement(n1, "div", { class: "header-divider" });
  const n9 = shellElement(n1, "div", { class: "project-heading" });
  const n10 = shellElement(n9, "span", { id: "project-name" });
  n10.appendChild(document.createTextNode("Alpine watershed"));
  const n11 = shellElement(n9, "small");
  shellElement(n11, "i", { class: "status-dot" });
  const n13 = shellElement(n11, "span", { id: "save-status" });
  n13.appendChild(document.createTextNode("Local workspace"));
  n1.appendChild(document.createTextNode("\n "));
  const n14 = shellElement(n1, "div", { class: "header-actions" });
  const n15 = shellElement(n14, "button", {
    class: "mobile-only",
    id: "mobile-tools",
    title: "Tools",
  });
  n15.appendChild(document.createTextNode("Tools"));
  const n16 = shellElement(n14, "button", {
    class: "mobile-only",
    id: "mobile-layers",
    title: "Layers",
  });
  n16.appendChild(document.createTextNode("Layers"));
  const n17 = shellElement(n14, "div", { class: "history-buttons" });
  const n18 = shellElement(n17, "button", {
    id: "undo-btn",
    class: "icon-button",
    title: "Undo (Ctrl/⌘ Z)",
    "aria-label": "Undo",
  });
  shellElement(n18, "span", { "data-icon": "undo" });
  const n20 = shellElement(n17, "button", {
    id: "redo-btn",
    class: "icon-button",
    title: "Redo (Ctrl/⌘ Shift Z)",
    "aria-label": "Redo",
  });
  shellElement(n20, "span", { "data-icon": "redo" });
  const n22 = shellElement(n14, "button", { id: "recipe-btn", class: "ghost" });
  shellElement(n22, "span", { "data-icon": "code" });
  const n24 = shellElement(n22, "span");
  n24.appendChild(document.createTextNode("Recipe & API"));
  const n25 = shellElement(n14, "button", { id: "export-btn", class: "primary" });
  shellElement(n25, "span", { "data-icon": "export" });
  n25.appendChild(document.createTextNode("Export terrain"));
  n1.appendChild(document.createTextNode("\n"));
  const n27 = shellElement(parent, "div", { class: "workspace" });
  n27.appendChild(document.createTextNode("\n "));
  const n28 = shellElement(n27, "aside", { class: "sidebar left-sidebar" });
  n28.appendChild(document.createTextNode("\n  "));
  const n29 = shellElement(n28, "div", { class: "panel-heading" });
  const n30 = shellElement(n29, "span");
  n30.appendChild(document.createTextNode("AUTHORING"));
  const n31 = shellElement(n29, "span", { class: "tiny-tag" });
  n31.appendChild(document.createTextNode("NON-DESTRUCTIVE"));
  n28.appendChild(document.createTextNode("\n  "));
  const n32 = shellElement(n28, "div", { class: "panel-tabs" });
  const n33 = shellElement(n32, "button", { class: "active", "data-panel": "tools" });
  n33.appendChild(document.createTextNode("Tools"));
  const n34 = shellElement(n32, "button", { "data-panel": "generate" });
  n34.appendChild(document.createTextNode("Generate"));
  n28.appendChild(document.createTextNode("\n  "));
  const n35 = shellElement(n28, "div", { id: "tools-panel", class: "panel-scroll" });
  n35.appendChild(document.createTextNode("\n   "));
  shellElement(n35, "div", { id: "tool-grid", class: "tool-grid" });
  n35.appendChild(document.createTextNode("\n   "));
  const n37 = shellElement(n35, "section", { class: "brush-section" });
  const n38 = shellElement(n37, "div", { class: "section-title" });
  const n39 = shellElement(n38, "span", { id: "brush-title" });
  n39.appendChild(document.createTextNode("Sculpt terrain"));
  const n40 = shellElement(n38, "span", { class: "keycap", id: "tool-key" });
  n40.appendChild(document.createTextNode("1"));
  const n41 = shellElement(n37, "p", { id: "brush-desc", class: "muted tool-description" });
  n41.appendChild(document.createTextNode("Raise the ground. Hold Shift to lower."));
  n37.appendChild(document.createTextNode("\n    "));
  const n42 = shellElement(n37, "label", { class: "slider-label" });
  n42.appendChild(document.createTextNode("Size "));
  const n43 = shellElement(n42, "output", { id: "radius-value" });
  n43.appendChild(document.createTextNode("36 m"));
  shellElement(n37, "input", {
    id: "brush-radius",
    type: "range",
    min: "4",
    max: "150",
    value: "36",
    step: "1",
    "aria-label": "Brush radius",
  });
  n37.appendChild(document.createTextNode("\n    "));
  const n45 = shellElement(n37, "label", { class: "slider-label" });
  n45.appendChild(document.createTextNode("Strength "));
  const n46 = shellElement(n45, "output", { id: "strength-value" });
  n46.appendChild(document.createTextNode("35%"));
  shellElement(n37, "input", {
    id: "brush-strength",
    type: "range",
    min: "0.01",
    max: "1",
    value: "0.35",
    step: "0.01",
    "aria-label": "Brush strength",
  });
  n37.appendChild(document.createTextNode("\n    "));
  const n48 = shellElement(n37, "label", { class: "slider-label" });
  n48.appendChild(document.createTextNode("Falloff "));
  const n49 = shellElement(n48, "output", { id: "falloff-value" });
  n49.appendChild(document.createTextNode("65%"));
  shellElement(n37, "input", {
    id: "brush-falloff",
    type: "range",
    min: "0",
    max: "1",
    value: "0.65",
    step: "0.01",
    "aria-label": "Brush falloff",
  });
  n37.appendChild(document.createTextNode("\n    "));
  shellElement(n37, "div", { id: "tool-options", class: "tool-options" });
  n37.appendChild(document.createTextNode("\n    "));
  const n52 = shellElement(n37, "details", { class: "advanced" });
  const n53 = shellElement(n52, "summary");
  n53.appendChild(document.createTextNode("Brush dynamics"));
  const n54 = shellElement(n53, "span");
  n54.appendChild(document.createTextNode("+"));
  const n55 = shellElement(n52, "label", { class: "field-label" });
  n55.appendChild(document.createTextNode("Shape"));
  const n56 = shellElement(n55, "select", { id: "brush-shape" });
  const n57 = shellElement(n56, "option", { value: "circle" });
  n57.appendChild(document.createTextNode("Circle"));
  const n58 = shellElement(n56, "option", { value: "square" });
  n58.appendChild(document.createTextNode("Square"));
  const n59 = shellElement(n52, "label", { class: "slider-label" });
  n59.appendChild(document.createTextNode("Rotation "));
  const n60 = shellElement(n59, "output", { id: "rotation-value" });
  n60.appendChild(document.createTextNode("0°"));
  shellElement(n52, "input", {
    id: "brush-rotation",
    type: "range",
    min: "0",
    max: "360",
    value: "0",
  });
  const n62 = shellElement(n52, "label", { class: "slider-label" });
  n62.appendChild(document.createTextNode("Spacing "));
  const n63 = shellElement(n62, "output", { id: "spacing-value" });
  n63.appendChild(document.createTextNode("15%"));
  shellElement(n52, "input", {
    id: "brush-spacing",
    type: "range",
    min: "0.02",
    max: "1",
    step: "0.01",
    value: "0.15",
  });
  const n65 = shellElement(n52, "label", { class: "slider-label" });
  n65.appendChild(document.createTextNode("Jitter "));
  const n66 = shellElement(n65, "output", { id: "jitter-value" });
  n66.appendChild(document.createTextNode("0%"));
  shellElement(n52, "input", {
    id: "brush-jitter",
    type: "range",
    min: "0",
    max: "1",
    step: "0.01",
    value: "0",
  });
  n37.appendChild(document.createTextNode("\n   "));
  n35.appendChild(document.createTextNode("\n   "));
  const n68 = shellElement(n35, "div", { class: "tip-card" });
  shellElement(n68, "span", { "data-icon": "layers" });
  const n70 = shellElement(n68, "p");
  n70.appendChild(document.createTextNode("Every stroke is a layer."));
  shellElement(n70, "br");
  const n72 = shellElement(n70, "strong");
  n72.appendChild(document.createTextNode("Nothing is permanent."));
  n35.appendChild(document.createTextNode("\n  "));
  n28.appendChild(document.createTextNode("\n  "));
  const n73 = shellElement(n28, "div", { id: "generate-panel", class: "panel-scroll hidden" });
  const n74 = shellElement(n73, "div", { class: "section-title" });
  n74.appendChild(document.createTextNode("START FROM A LANDSCAPE"));
  shellElement(n73, "div", { id: "preset-list", class: "preset-list" });
  const n76 = shellElement(n73, "div", { class: "two-fields" });
  const n77 = shellElement(n76, "label", { class: "field-label" });
  n77.appendChild(document.createTextNode("Seed"));
  shellElement(n77, "input", {
    id: "seed-input",
    type: "number",
    value: "73",
    min: "0",
    max: "4294967295",
  });
  const n79 = shellElement(n76, "label", { class: "field-label" });
  n79.appendChild(document.createTextNode("World size"));
  const n80 = shellElement(n79, "select", { id: "world-size" });
  const n81 = shellElement(n80, "option");
  n81.appendChild(document.createTextNode("256"));
  const n82 = shellElement(n80, "option", { selected: "" });
  n82.appendChild(document.createTextNode("512"));
  const n83 = shellElement(n80, "option");
  n83.appendChild(document.createTextNode("1024"));
  const n84 = shellElement(n80, "option");
  n84.appendChild(document.createTextNode("2048"));
  const n85 = shellElement(n73, "button", { id: "generate-world", class: "primary full" });
  shellElement(n85, "span", { "data-icon": "refresh" });
  n85.appendChild(document.createTextNode("Generate landscape"));
  const n87 = shellElement(n73, "p", { class: "muted small" });
  n87.appendChild(
    document.createTextNode(
      "Replaces the stack as one undoable action. All dimensions are in metres.",
    ),
  );
  const n88 = shellElement(n73, "div", { class: "section-title pass-title" });
  n88.appendChild(document.createTextNode("ADD A PROCEDURAL PASS"));
  shellElement(n73, "div", { id: "pass-grid", class: "pass-grid" });
  n28.appendChild(document.createTextNode("\n  "));
  const n90 = shellElement(n28, "div", { class: "sidebar-bottom" });
  shellElement(n90, "i", { class: "status-dot" });
  const n92 = shellElement(n90, "span");
  n92.appendChild(document.createTextNode("Deterministic · local · open source"));
  n28.appendChild(document.createTextNode("\n "));
  n27.appendChild(document.createTextNode("\n "));
  const n93 = shellElement(n27, "main", { class: "stage" });
  n93.appendChild(document.createTextNode("\n  "));
  const n94 = shellElement(n93, "div", { class: "viewport-toolbar" });
  const n95 = shellElement(n94, "div", { class: "view-settings" });
  const n96 = shellElement(n95, "button", {
    class: "icon-button",
    id: "navigate-btn",
    "aria-label": "Toggle navigation tool",
    title: "Navigate / edit (V)",
  });
  shellElement(n96, "span", { "data-icon": "cursor" });
  const n98 = shellElement(n95, "select", { id: "view-angle", "aria-label": "Camera view" });
  const n99 = shellElement(n98, "option", { value: "perspective" });
  n99.appendChild(document.createTextNode("Perspective"));
  const n100 = shellElement(n98, "option", { value: "top" });
  n100.appendChild(document.createTextNode("Top view"));
  const n101 = shellElement(n95, "select", { id: "render-mode", "aria-label": "Render mode" });
  const n102 = shellElement(n101, "option", { value: "lit" });
  n102.appendChild(document.createTextNode("Lit"));
  const n103 = shellElement(n101, "option", { value: "height" });
  n103.appendChild(document.createTextNode("Height"));
  const n104 = shellElement(n101, "option", { value: "slope" });
  n104.appendChild(document.createTextNode("Slope"));
  const n105 = shellElement(n101, "option", { value: "materials" });
  n105.appendChild(document.createTextNode("Material IDs"));
  const n106 = shellElement(n101, "option", { value: "wire" });
  n106.appendChild(document.createTextNode("Wireframe"));
  const n107 = shellElement(n94, "div", { class: "view-settings" });
  const n108 = shellElement(n107, "span", { class: "toolbar-label" });
  n108.appendChild(document.createTextNode("PREVIEW"));
  const n109 = shellElement(n107, "select", {
    id: "preview-resolution",
    "aria-label": "Preview resolution",
  });
  const n110 = shellElement(n109, "option", { value: "65" });
  n110.appendChild(document.createTextNode("65²"));
  const n111 = shellElement(n109, "option", { value: "129" });
  n111.appendChild(document.createTextNode("129²"));
  const n112 = shellElement(n109, "option", { value: "257", selected: "" });
  n112.appendChild(document.createTextNode("257²"));
  const n113 = shellElement(n109, "option", { value: "513" });
  n113.appendChild(document.createTextNode("513²"));
  const n114 = shellElement(n107, "button", {
    class: "icon-button",
    id: "frame-btn",
    title: "Frame terrain (F)",
    "aria-label": "Frame terrain",
  });
  shellElement(n114, "span", { "data-icon": "frame" });
  const n116 = shellElement(n107, "button", {
    class: "icon-button",
    id: "rebuild-btn",
    title: "Rebuild preview",
    "aria-label": "Rebuild preview",
  });
  shellElement(n116, "span", { "data-icon": "refresh" });
  n93.appendChild(document.createTextNode("\n  "));
  const n118 = shellElement(n93, "div", { id: "viewport", class: "viewport" });
  const n119 = shellElement(n118, "div", { class: "viewport-caption" });
  const n120 = shellElement(n119, "span", { id: "landscape-tag", class: "eyebrow" });
  n120.appendChild(document.createTextNode("LANDSCAPE 01 / ALPINE"));
  const n121 = shellElement(n119, "h1", { id: "landscape-title" });
  n121.appendChild(document.createTextNode("Alpine watershed"));
  const n122 = shellElement(n119, "p", { id: "landscape-subtitle" });
  n122.appendChild(document.createTextNode("Granite ridges · river valley · conifer forest"));
  const n123 = shellElement(n118, "div", { class: "viewport-badges" });
  const n124 = shellElement(n123, "span", { id: "renderer-badge", class: "render-badge" });
  n124.appendChild(document.createTextNode("Loading Three.js…"));
  const n125 = shellElement(n123, "span", { id: "busy-status", class: "busy-badge hidden" });
  shellElement(n125, "span", { class: "spinner" });
  const n127 = shellElement(n125, "span", { id: "busy-text" });
  n127.appendChild(document.createTextNode("Building terrain"));
  const n128 = shellElement(n125, "button", { id: "cancel-build", title: "Cancel build" });
  n128.appendChild(document.createTextNode("×"));
  const n129 = shellElement(n118, "div", { class: "north-indicator" });
  const n130 = shellElement(n129, "span");
  n130.appendChild(document.createTextNode("N"));
  const n131 = shellElement(n129, "svg", { viewBox: "0 0 26 38" });
  shellElement(n131, "path", {
    d: "M13 2 22 30 13 25 4 30Z",
    fill: "none",
    stroke: "currentColor",
  });
  shellElement(n131, "path", { d: "m13 2 0 23-9 5Z", fill: "currentColor", opacity: ".4" });
  const n134 = shellElement(n118, "div", { id: "spline-bar", class: "spline-bar hidden" });
  const n135 = shellElement(n134, "span", { id: "spline-count" });
  n135.appendChild(document.createTextNode("0 control points"));
  const n136 = shellElement(n134, "button", { id: "finish-spline", class: "primary" });
  n136.appendChild(document.createTextNode("Finish spline ↵"));
  const n137 = shellElement(n134, "button", { id: "cancel-spline", class: "ghost" });
  n137.appendChild(document.createTextNode("Cancel"));
  const n138 = shellElement(n118, "div", { class: "canvas-help", id: "canvas-help" });
  shellElement(n138, "span", { "data-icon": "mouse" });
  const n140 = shellElement(n138, "span");
  n140.appendChild(document.createTextNode("Drag to sculpt "));
  const n141 = shellElement(n140, "b");
  n141.appendChild(document.createTextNode("·"));
  n140.appendChild(document.createTextNode(" Shift lowers "));
  const n142 = shellElement(n140, "b");
  n142.appendChild(document.createTextNode("·"));
  n140.appendChild(document.createTextNode(" Right-drag orbits"));
  shellElement(n118, "div", { id: "toast", role: "status", class: "toast hidden" });
  n93.appendChild(document.createTextNode("\n  "));
  const n144 = shellElement(n93, "div", { class: "viewport-footer" });
  const n145 = shellElement(n144, "span", { id: "coordinates" });
  n145.appendChild(document.createTextNode("X —   Y —   Z —"));
  const n146 = shellElement(n144, "span", { id: "mesh-stats" });
  n146.appendChild(document.createTextNode("Preparing terrain…"));
  const n147 = shellElement(n144, "span", { id: "eval-time" });
  n147.appendChild(document.createTextNode("CPU worker"));
  n93.appendChild(document.createTextNode("\n "));
  n27.appendChild(document.createTextNode("\n "));
  const n148 = shellElement(n27, "aside", { class: "sidebar right-sidebar" });
  const n149 = shellElement(n148, "div", { class: "panel-heading" });
  const n150 = shellElement(n149, "span");
  n150.appendChild(document.createTextNode("OPERATION STACK"));
  const n151 = shellElement(n149, "span", { id: "layer-count", class: "count-tag" });
  n151.appendChild(document.createTextNode("0"));
  const n152 = shellElement(n148, "div", { class: "stack-explainer" });
  n152.appendChild(document.createTextNode("Evaluated from top to bottom"));
  shellElement(n152, "span", { "data-icon": "arrow-down" });
  shellElement(n148, "div", { id: "layer-list", class: "layer-list" });
  const n155 = shellElement(n148, "div", { class: "inspector" });
  const n156 = shellElement(n155, "div", { class: "inspector-header" });
  const n157 = shellElement(n156, "span", { id: "selected-type" });
  n157.appendChild(document.createTextNode("LAYER PROPERTIES"));
  const n158 = shellElement(n156, "div");
  const n159 = shellElement(n158, "button", {
    id: "layer-up",
    class: "icon-button small-icon",
    title: "Move earlier",
    "aria-label": "Move layer up",
  });
  shellElement(n159, "span", { "data-icon": "arrow-up" });
  const n161 = shellElement(n158, "button", {
    id: "layer-down",
    class: "icon-button small-icon",
    title: "Move later",
    "aria-label": "Move layer down",
  });
  shellElement(n161, "span", { "data-icon": "arrow-down" });
  const n163 = shellElement(n158, "button", {
    id: "layer-duplicate",
    class: "icon-button small-icon",
    title: "Duplicate layer",
    "aria-label": "Duplicate layer",
  });
  shellElement(n163, "span", { "data-icon": "copy" });
  const n165 = shellElement(n158, "button", {
    id: "layer-delete",
    class: "icon-button small-icon danger",
    title: "Delete layer",
    "aria-label": "Delete layer",
  });
  shellElement(n165, "span", { "data-icon": "trash" });
  shellElement(n155, "input", {
    id: "selected-name",
    class: "layer-name-input",
    "aria-label": "Layer name",
    placeholder: "Select a layer",
  });
  const n168 = shellElement(n155, "label", { class: "slider-label" });
  n168.appendChild(document.createTextNode("Opacity "));
  const n169 = shellElement(n168, "output", { id: "opacity-value" });
  n169.appendChild(document.createTextNode("100%"));
  shellElement(n155, "input", {
    id: "selected-opacity",
    type: "range",
    min: "0",
    max: "1",
    step: "0.01",
    value: "1",
    "aria-label": "Layer opacity",
  });
  const n171 = shellElement(n155, "div", { class: "json-label" });
  const n172 = shellElement(n171, "span");
  n172.appendChild(document.createTextNode("PARAMETERS + MASK"));
  const n173 = shellElement(n171, "span");
  n173.appendChild(document.createTextNode("JSON"));
  shellElement(n155, "textarea", {
    id: "selected-json",
    spellcheck: "false",
    "aria-label": "Layer parameters",
  });
  shellElement(n155, "div", { id: "layer-error", class: "inline-error" });
  const n176 = shellElement(n155, "button", { id: "apply-layer", class: "secondary full" });
  n176.appendChild(document.createTextNode("Apply changes"));
  const n177 = shellElement(n148, "details", { class: "diagnostics" });
  const n178 = shellElement(n177, "summary");
  n178.appendChild(document.createTextNode("Build diagnostics "));
  const n179 = shellElement(n178, "span", { id: "diagnostic-count" });
  n179.appendChild(document.createTextNode("0"));
  const n180 = shellElement(n177, "div", { id: "diagnostic-list" });
  n180.appendChild(document.createTextNode("No diagnostics."));
  const n181 = shellElement(n148, "div", { class: "sidebar-bottom" });
  shellElement(n181, "span", { "data-icon": "code" });
  const n183 = shellElement(n181, "span");
  n183.appendChild(document.createTextNode("Same operations. UI or code."));
  n27.appendChild(document.createTextNode("\n"));
}
