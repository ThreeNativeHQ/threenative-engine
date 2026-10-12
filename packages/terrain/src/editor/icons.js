const paths = {
  sculpt: "M3 19 9 7l4 7 3-5 5 10H3Z M9 3v5M6 5h6",
  smooth: "M2 15c4 0 3-6 7-6s3 6 7 6 4-4 6-4 M3 20h18",
  flatten: "M2 17h5l3-8h7l5 8 M9 5h9",
  ramp: "m3 18 18-12v12H3Z M7 21h10",
  stamp: "M8 3h8v6l-2 3 5 3v4H5v-4l5-3-2-3V3Z M5 22h14",
  erode: "m3 18 5-8 4 4 4-8 5 12 M7 3v3m5-4v5m6-4v2",
  paint: "m4 17 3-3 3 3-3 4H3v-4Z M8 14 18 3l3 3-11 11",
  scatter: "m5 3-4 8h8L5 3Zm0 8v5m12-9-5 9h10l-5-9Zm0 9v5M7 20h3",
  spline: "M4 18C4 3 20 21 20 6 M2 17h4v4H2v-4ZM18 2h4v4h-4V2Z",
  water: "M2 14q3-4 6 0t6 0 6 0M2 20q3-4 6 0t6 0 6 0M12 2l-3 6a3 3 0 0 0 6 0l-3-6Z",
  noise: "m2 15 3-5 3 8 3-13 4 14 3-8 4 4",
  mountain: "m2 20 8-15 5 8 3-5 5 12H2Z m5-9 3 2 3-2",
  tree: "m12 2-7 10h4l-5 7h7v3h2v-3h7l-5-7h4L12 2Z",
  code: "m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18",
  export: "M12 16V2m-5 5 5-5 5 5M4 13v8h16v-8",
  import: "M12 2v14m-5-5 5 5 5-5M4 16v5h16v-5",
  undo: "M4 5v7h7M4 12a8 8 0 1 1 2 8",
  redo: "M20 5v7h-7m7 0a8 8 0 1 0-2 8",
  layers: "m12 2 10 6-10 6L2 8l10-6Z M2 12l10 6 10-6M2 16l10 6 10-6",
  eye: "M2 12q10-14 20 0-10 14-20 0Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  "eye-off": "m3 3 18 18M2 12q5-8 11-6m9 6q-5 8-11 6",
  "arrow-up": "m5 10 7-7 7 7M12 3v18",
  "arrow-down": "m5 14 7 7 7-7M12 3v18",
  copy: "M8 8h13v13H8V8Z M16 8V3H3v13h5",
  trash: "M3 6h18M9 3h6M6 6l1 15h10l1-15M10 10v7m4-7v7",
  refresh: "M20 9a8 8 0 0 0-14-5L3 7m0-5v5h5M4 15a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  cursor: "m4 2 15 11-7 1-4 7L4 2Z",
  frame: "M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6",
  mouse: "M12 3c-5 0-7 3-7 7v5c0 5 14 5 14 0v-5c0-4-2-7-7-7Zm0 0v7M5 10h14",
  image: "M3 3h18v18H3V3Zm0 15 6-7 5 5 3-3 4 5 M8 7h.01",
  grid: "M3 3h18v18H3V3Zm6 0v18m6-18v18M3 9h18M3 15h18",
  cube: "m12 2 10 6v9l-10 6L2 17V8l10-6Zm0 12v9M2 8l10 6 10-6",
  biome: "M4 20C4 3 15 4 21 3c0 13-5 17-17 17Zm0 0L16 8",
  clear: "m3 15 9-12 10 8-8 10H9l-6-6Zm5-6 10 8M14 21h8",
  terrace: "M2 20h5v-5h5v-5h5V5h5",
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.layers}"/></svg>`;
}
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) el.innerHTML = icon(el.dataset.icon);
}
