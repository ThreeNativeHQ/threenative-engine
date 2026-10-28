import { AdditiveBlending, BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type Vector2, type WebGLRenderer } from "three";
import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import { installThreePlaytestBridge } from "../src/three/bridge.js";
import { observeSightLine } from "../src/three/sight-line.js";

const renderer = { getDrawingBufferSize: (target: Vector2) => target.set(1280, 720) } as WebGLRenderer;
const box = (name: string, size: [number, number, number], at: [number, number, number]) => {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial());
  mesh.name = name;
  mesh.position.set(...at);
  return mesh;
};

/** Camera at +z looking at a subject at the origin, as a third-person kit frames it. */
function world(...occluders: Mesh[]) {
  const scene = new Scene();
  const subject = new Group();
  subject.add(box("body", [1, 2, 1], [0, 1, 0]));
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.5, 5);
  scene.add(subject, camera, ...occluders);
  scene.updateMatrixWorld(true);
  return { camera, scene, subject };
}

describe("observeSightLine", () => {
  it("reports a clear line when only the subject's own body is between the lens and its centre", () => {
    const { camera, scene, subject } = world();
    expect(observeSightLine(scene, camera, subject)).toMatchObject({ blocked: false, blockers: [] });
  });

  it("reports the wall that stands between the lens and the subject", () => {
    const { camera, scene, subject } = world(box("wall", [6, 6, 0.5], [0, 2, 2.5]));
    expect(observeSightLine(scene, camera, subject)).toMatchObject({ blocked: true, blockers: ["wall"] });
  });

  it("ignores a wall behind the subject and a hidden wall in front of it", () => {
    const behind = world(box("behind", [6, 6, 0.5], [0, 2, -3]));
    expect(observeSightLine(behind.scene, behind.camera, behind.subject).blocked).toBe(false);
    const hidden = box("hidden", [6, 6, 0.5], [0, 2, 2.5]);
    hidden.visible = false;
    const invisible = world(hidden);
    expect(observeSightLine(invisible.scene, invisible.camera, invisible.subject).blocked).toBe(false);
  });

  it("does not count a cutout or an effect volume as a wall, and still counts a solid one", () => {
    const stand = (name: string, tune: (mesh: Mesh) => void) => {
      const mesh = box(name, [6, 6, 0.5], [0, 2, 2.5]);
      tune(mesh);
      const { camera, scene, subject } = world(mesh);
      return observeSightLine(scene, camera, subject).blocked;
    };
    // Leaves and grass are alpha-tested quads: the ray meets the quad, the eye sees through the holes.
    const leaves = (mesh: Mesh) => {
      (mesh.material as MeshBasicMaterial).alphaTest = 0.4;
    };
    expect(stand("leaves", leaves)).toBe(false);
    // Light shafts, mist and glow draw over the scene without writing depth: nothing stands there.
    const shafts = (mesh: Mesh) => {
      const material = mesh.material as MeshBasicMaterial;
      material.transparent = true;
      material.depthWrite = false;
      material.blending = AdditiveBlending;
    };
    expect(stand("shafts", shafts)).toBe(false);
    // A transparent surface that still writes depth is glass or a fence rail; it keeps blocking.
    const pane = (mesh: Mesh) => {
      (mesh.material as MeshBasicMaterial).transparent = true;
    };
    expect(stand("pane", pane)).toBe(true);
  });

  it("does not count a rope or a rail the ray crosses in a hand's width, but counts a wall of the same length", () => {
    const rope = world(box("rope", [6, 0.07, 0.07], [0, 1.25, 2.5]));
    expect(observeSightLine(rope.scene, rope.camera, rope.subject).blocked).toBe(false);
    const wall = world(box("wall", [6, 0.07, 0.4], [0, 1.25, 2.5]));
    expect(observeSightLine(wall.scene, wall.camera, wall.subject)).toMatchObject({ blocked: true, blockers: ["wall"] });
    // A thin panel is crossed in under a hand's width too, but it is a wall: it is wide both ways.
    const panel = world(box("panel", [6, 6, 0.08], [0, 2, 2.5]));
    expect(observeSightLine(panel.scene, panel.camera, panel.subject)).toMatchObject({ blocked: true, blockers: ["panel"] });
  });

  it("reports a camera that sits inside a solid", () => {
    const { camera, scene, subject } = world(box("pillar", [4, 4, 4], [0, 1.5, 5]));
    expect(observeSightLine(scene, camera, subject)).toMatchObject({ blocked: true });
  });
});

describe("bridge sample", () => {
  it("answers a sightLine request for a registered entity", async () => {
    const { camera, scene, subject } = world(box("wall", [6, 6, 0.5], [0, 2, 2.5]));
    const installation = installThreePlaytestBridge({ camera, entities: [{ id: "player", object: subject }], renderer, scene });
    const snapshot = await installation.bridge.sample({ include: ["entities"], sightLine: { entity: "player" } });
    expect(snapshot.sightLine).toMatchObject({ blocked: true, blockers: ["wall"] });
    installation.dispose();
  });
});

function evaluate(samples: Array<{ blocked: boolean; blockers: string[]; distance: number }> | undefined, maxBlockedRatio = 0.02) {
  const scenario = validatePlaytestScenario(
    {
      assert: { sightLine: { maxBlockedRatio } },
      name: "sight",
      schemaVersion: 1,
      steps: [{ kind: "wait", release: true, waitTicks: 10 }],
      subject: "player",
    },
    "sight.json",
  );
  const report: IPlaytestReport = {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 10,
    observations: { console: [], hud: {}, network: [], resources: {}, ...(samples === undefined ? {} : { sightLine: { entity: "player", samples } }) },
    trivialityOptOuts: [],
  };
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  return { codes: diagnostics.map(({ code }) => code), result: assertions.find(({ id }) => id.startsWith("sightLine")) };
}

const clear = { blocked: false, blockers: [], distance: 5 };
const wall = { blocked: true, blockers: ["wall"], distance: 5 };

describe("sightLine assertion", () => {
  it("passes while the lens sees the subject on every sample", () => {
    expect(evaluate(Array(50).fill(clear)).result?.pass).toBe(true);
  });

  it("fails when more than the allowed share of samples are blocked and names the blocker", () => {
    const { codes, result } = evaluate([...Array(40).fill(clear), ...Array(10).fill(wall)]);
    expect(result?.pass).toBe(false);
    expect(JSON.stringify(result?.details)).toContain("wall");
    expect(codes).toContain("TN_PLAYTEST_SIGHT_LINE_BLOCKED");
  });

  it("tolerates a blink inside the allowed share", () => {
    expect(evaluate([wall, ...Array(99).fill(clear)], 0.02).result?.pass).toBe(true);
  });

  it("fails closed when nothing was sampled", () => {
    expect(evaluate(undefined).codes).toContain("TN_PLAYTEST_SIGHT_LINE_UNOBSERVED");
    expect(evaluate([]).result?.pass).toBe(false);
  });

  it("rejects a ratio outside 0..1 and a missing ratio", () => {
    const bad = (sightLine: unknown) => () =>
      validatePlaytestScenario({ assert: { sightLine }, name: "s", schemaVersion: 1, steps: [{ kind: "wait", release: true, waitTicks: 1 }] }, "s.json");
    expect(bad({ maxBlockedRatio: 2 })).toThrow();
    expect(bad({})).toThrow();
    expect(bad({ maxBlockedRatio: "0.1" })).toThrow();
  });
});
