import { createRoot } from "react-dom/client";
import { TailwindParity, panelCss } from "./ui/TailwindParity.js";

/**
 * The browser arm of the Tailwind parity meter (`corpus/tailwind-parity.mjs`).
 *
 * The page is the corpus's web subject: it installs the panel's own stylesheet — Tailwind's emitted
 * rules, byte for byte — and mounts `src/ui/TailwindParity.tsx`, the component the native entry
 * mounts. `?panel=N` selects the panel and `?strip=1` renders every probe without its unit class,
 * which is the vacuity guard's second arm. Nothing here is engine-specific.
 *
 * The native build never loads this file: `ui.renderer: "native-css"` compiles `src/ui/main.tsx`
 * for its stylesheet and mounts the component through `createCssUiRoot()`.
 */
const search = new URLSearchParams(window.location.search);
const panel = Number(search.get("panel") ?? "0");
const strip = search.get("strip") === "1";

const style = document.createElement("style");
style.textContent = panelCss(panel);
document.head.append(style);

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
createRoot(root).render(<TailwindParity panel={panel} stripProbeClass={strip} />);
