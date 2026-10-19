import game from "./game.js";
void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas === undefined) throw new Error("Fog fixture did not produce a canvas.");
  document.body.appendChild(canvas);
});
