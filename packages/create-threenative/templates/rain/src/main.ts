import { acceptHotUpdate } from "@threenative/core/hot";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import game from "./game.js";
import { App } from "./ui/App.js";
import "./style.css";

import.meta.hot?.accept();
acceptHotUpdate(game, import.meta.hot);
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
const appRoot = root as typeof root & { __threenativeRoot?: ReturnType<typeof createRoot> };
const reactRoot = appRoot.__threenativeRoot ?? createRoot(appRoot);
appRoot.__threenativeRoot = reactRoot;
reactRoot.render(createElement(App, { game }));
