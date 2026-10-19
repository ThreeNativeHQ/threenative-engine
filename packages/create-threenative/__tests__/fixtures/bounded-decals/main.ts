import { createDecalFixture } from "./game.js";
const params = new URLSearchParams(location.search);
const game = createDecalFixture(
  params.get("hideDecals") === "1",
  params.get("atlasFade") === "1",
  params.get("hideFading") === "1",
);
void game
  .start()
  .then(() => {
    const canvas = game.ctx?.renderer.domElement;
    if (canvas === undefined) throw new Error("Decal fixture has no canvas.");
    document.body.append(canvas);
  })
  .catch((error: unknown) => {
    console.error(error);
  });
