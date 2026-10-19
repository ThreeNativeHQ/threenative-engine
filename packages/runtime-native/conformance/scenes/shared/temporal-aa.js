import { createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { startVisualScene } from "./scene-support.js";

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "temporal-aa", ({ renderer, scene, camera }) => {
    const fixture = createTemporalAAFixture(renderer, scene, camera);
    return { ...fixture, detail: { milestone: "full-resolution-temporal-aa", qualification: "experimental" } };
  });
}
