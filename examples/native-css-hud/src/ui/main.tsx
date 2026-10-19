import { createRoot } from "react-dom/client";
import { Inventory } from "./Inventory.js";
import "./hud.css";

/**
 * The stylesheet entry, and the browser page when it is loaded directly.
 *
 * The native build compiles this file with the project's own Vite config: importing `hud.css` is
 * what makes Tailwind emit the stylesheet the native CSS engine resolves. Nothing else here is
 * native-specific, and `onClose` only logs, because this page has no game to inform.
 */
const root = document.getElementById("tn-ui");
if (root === null) throw new Error("Missing #tn-ui element.");
createRoot(root).render(<Inventory onClose={() => console.info("TN_HUD_CLOSED_WEB")} />);
