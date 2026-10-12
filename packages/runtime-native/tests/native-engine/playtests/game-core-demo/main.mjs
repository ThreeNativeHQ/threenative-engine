import game from "./game.ts";

void game.start().then(() => {
  // The host reads the world before its first tick, so publish the handles after core's boot.
  game.ctx.renderer.render(game.ctx.scene, game.ctx.camera);
}).catch((error) => { globalThis.tn.__startupError = String(error.stack ?? error); });
