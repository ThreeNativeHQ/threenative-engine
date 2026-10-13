import game from "./game.js";

// Reachable from a debugging probe; the scenarios read the playtest bridge instead.
Object.assign(globalThis, { __wasmEngineBootGame: game });

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("Missing #app element.");

void game
  .start()
  .then(() => {
    const canvas = game.ctx?.renderer.domElement;
    if (canvas !== undefined) app.prepend(canvas);
  })
  .catch((error: unknown) => {
    const failure = document.createElement("div");
    failure.id = "threenative-canvas-error";
    failure.dataset.threenativeCanvasError = "true";
    failure.setAttribute("role", "alert");
    failure.textContent = error instanceof Error ? error.message : String(error);
    app.replaceChildren(failure);
  });
