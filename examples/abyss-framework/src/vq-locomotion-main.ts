import game from "./render/vq-locomotion-game.js";

void game.start().then(() => {
  const canvas = game.ctx?.renderer.domElement;
  if (canvas === undefined) throw new Error("Locomotion capture has no canvas.");
  document.body.append(canvas);
});
