import { sourceRadiusShadowFilter } from "../../../../core/src/render/soft-shadow.ts";
import { ShadowFilterBudget } from "../../../../core/src/render/shadow-filter-budget.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-652: a GPU frame over the frame period for two frames steps the soft-shadow filter down one tier when the
 * shadow passes could absorb the overage, and the game rebuilds its
 * filter with that tier's taps. The `ShadowFilterBudget` runs on injected readings, so the browser and the
 * native host take the same step; the frame is the lamp scene of `soft-shadow-source-radius` drawn with the
 * stepped filter (4 + 4 taps instead of 16 + 16).
 */
const TAPS = { high: 16, medium: 4 };
const PERIOD_MS = 1000 / 60;

function verifyStep(lamps) {
  const lines = [];
  const rebuilt = [];
  const budget = new ShadowFilterBudget({
    framePeriodMs: PERIOD_MS,
    onStep: (tier) => {
      rebuilt.push(tier);
      const taps = TAPS[tier];
      const filter = sourceRadiusShadowFilter({ sourceRadius: 0.25, blockerSamples: taps, filterSamples: taps });
      for (const lamp of lamps) lamp.shadow.filterNode = filter;
    },
    report: (line) => lines.push(line),
    tier: "high",
    windowFrames: 12,
  });
  let report;
  for (let i = 0; i < 2; i += 1) report = budget.observe(8, 22) ?? report;
  assertCondition(report?.stepped === "medium" && report.panic, "2 frames of 22 ms over the 16.7 ms period, 8 ms of it shadows, step high down to medium");
  assertCondition(rebuilt.join() === "medium", "the game rebuilds its filter once, at the new tier");
  assertCondition(budget.shadowQuality === 1, "medium follows Unreal shadow quality level 1");
  assertCondition(lines.length === 1 && lines[0].startsWith("TN_SHADOW_TIER "), "one TN_SHADOW_TIER line for the step");
  const keep = new ShadowFilterBudget({
    explicit: true,
    framePeriodMs: PERIOD_MS,
    report: (line) => lines.push(line),
    tier: "high",
    windowFrames: 12,
  });
  let kept;
  for (let i = 0; i < 12; i += 1) kept = keep.observe(8, 22) ?? kept;
  assertCondition(kept?.tier === "high" && kept.explicit, "explicit sample counts stay at high");
  assertCondition(kept.verdict === "over" && kept.frameMs > kept.targetMs, "the explicit report names the frame over its target");
  return { tier: budget.tier, taps: TAPS[budget.tier], explicit: keep.tier };
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "shadow-filter-step", ({ renderer, scene, camera }) => {
    renderer.shadowMap.enabled = true;
    camera.position.set(0, 7, 4);
    camera.lookAt(0, 0, 0);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 8),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const plate = (x) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.05, 1.2),
        new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 1 }),
      );
      mesh.position.set(x, 1.5, 0);
      mesh.castShadow = true;
      return mesh;
    };
    const spot = new THREE.SpotLight(0xffffff, 40, 0, Math.PI / 3, 0.2, 2);
    spot.position.set(-2.2, 3, 0);
    spot.target.position.set(-2.2, 0, 0);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    const point = new THREE.PointLight(0xffffff, 40, 0, 2);
    point.position.set(2.2, 3, 0);
    point.castShadow = true;
    point.shadow.mapSize.set(1024, 1024);
    scene.add(floor, plate(-2.2), plate(2.2), spot, spot.target, point, new THREE.AmbientLight(0x405070, 0.3));
    const detail = verifyStep([spot, point]);
    assertCondition(spot.shadow.filterNode === point.shadow.filterNode, "both lamps take the stepped filter");
    return { detail, floor, spot, point };
  });
}
