import { startWorkerGame } from "@threenative/core/worker";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { GameUi } from "./ui/GameUi.js";
import "./style.css";

/**
 * `index.html`, the default: the game runs in `src/worker.ts`, off the page's thread, so a busy
 * page cannot stall its frames. This page keeps the canvas, the input and the HUD; `main.html` runs
 * the same game on the page itself.
 */
const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
root.className = "relative h-screen w-screen overflow-hidden bg-ink";
const stage = document.createElement("div");
stage.className = "absolute inset-0";
root.append(stage);
const ui = document.createElement("div");
root.append(ui);
// Before the UI mounts: the HUD finds the worker's bridge from its first render.
const game = startWorkerGame(
  new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  stage,
);
createRoot(ui).render(createElement(GameUi));
game.ready.catch((error: unknown) => {
  stage.textContent = error instanceof Error ? error.message : String(error);
  stage.setAttribute("role", "alert");
});
