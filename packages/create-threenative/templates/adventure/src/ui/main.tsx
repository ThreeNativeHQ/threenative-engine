import { createRoot } from "react-dom/client";
import { GameUi } from "./GameUi.js";
import "../style.css";

/**
 * The UI entry the native web view loads.
 *
 * It mounts the UI and nothing else — no scene, no simulation, no renderer. The game runs beside
 * it in the native runtime and reaches it only through published state and intents, which is why
 * this file imports no game code at all.
 */
const root = document.getElementById("tn-ui");
if (root === null) throw new Error("Missing #tn-ui element.");
createRoot(root).render(<GameUi />);
