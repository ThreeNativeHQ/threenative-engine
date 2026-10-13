import "./style.css";
import { createRoot } from "react-dom/client";
import game from "./terrain-game.js";
import { TerrainApp } from "./ui/TerrainApp.js";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
const appRoot = root as typeof root & { __threenativeRoot?: ReturnType<typeof createRoot> };
const reactRoot = appRoot.__threenativeRoot ?? createRoot(appRoot);
appRoot.__threenativeRoot = reactRoot;
reactRoot.render(<TerrainApp game={game} />);
