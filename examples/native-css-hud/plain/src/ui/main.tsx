import { createRoot } from "react-dom/client";
import { Panel } from "./Panel.js";

const root = document.getElementById("tn-ui");
if (root === null) throw new Error("Missing #tn-ui element.");
createRoot(root).render(<Panel onClose={() => console.info("TN_HUD_CLOSED_WEB")} />);
