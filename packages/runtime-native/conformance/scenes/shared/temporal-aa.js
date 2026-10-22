import { createTemporalAAFixture } from "./temporal-aa-fixture.js";
import { assertCondition, startVisualScene } from "./scene-support.js";

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "temporal-aa", async ({ renderer, scene, camera }) => {
    const fixture = createTemporalAAFixture(renderer, scene, camera);
    for (let frame = 0; frame < 26; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      fixture.render();
      await fixture.sampleVelocity();
    }
    fixture.freeze();
    const observation = fixture.observation();
    assertCondition(
      observation.frame === 26 && observation.held?.frame === 26,
      "Temporal AA capture must hold exactly 26 moving history frames.",
    );
    return { ...fixture, detail: { milestone: "full-resolution-temporal-aa", qualification: "experimental" } };
  });
}
