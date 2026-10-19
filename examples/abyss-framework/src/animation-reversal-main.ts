import game from "./render/animation-reversal-game.js";

void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas === undefined) throw new Error("Animation capture has no canvas.");
  document.body.append(canvas);
});
