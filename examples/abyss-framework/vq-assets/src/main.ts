import game from "./game.js";

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("Missing #app element.");
void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas !== undefined) app.prepend(canvas);
});
