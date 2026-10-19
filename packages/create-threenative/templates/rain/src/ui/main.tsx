import { createRoot } from "react-dom/client";
import { GameUi } from "./GameUi.js";
import "../style.css";

const root = document.getElementById("tn-ui");
if (root === null) throw new Error("Missing #tn-ui element.");
createRoot(root).render(<GameUi />);
