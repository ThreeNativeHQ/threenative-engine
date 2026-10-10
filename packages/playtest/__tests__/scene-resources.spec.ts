import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
} from "three";
import { describe, expect, test } from "vitest";

import { observeSceneResources } from "../src/three/scene-observation.js";
import { formatSceneOverview, summariseScene } from "../src/runner/sceneOverview.js";

/**
 * `doctor --url` used to print "not observed: lights, materials and textures" and "not observed:
 * camera framing" — so an agent staring at a black or washed-out frame had nothing between the
 * bridge answering and a screenshot, and went to the screenshot, which cannot say why.
 *
 * Round 9 lost the visual column to a fog whose far plane sat in front of the sky dome. Nothing
 * in the harness could have said so. These pin the room the game is played in, and the two
 * warnings that name the frame-destroying cases.
 */

function lit(): Mesh {
  return new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
}

function camera(): PerspectiveCamera {
  const perspective = new PerspectiveCamera(60, 16 / 9, 0.1, 200);
  perspective.position.set(0, 2, 10);
  perspective.lookAt(0, 0, 0);
  return perspective;
}

describe("the scene reports the room it is played in", () => {
  test("a background with no type and no constructor name reads unobserved, not a crash", () => {
    // A Perry-compiled native texture adopted onto another prototype read `constructor` as
    // undefined, and the walk returned it as the name: the bridge then failed the whole sample
    // with "$.scene.background must be JSON-safe". A null-prototype object throws the same way.
    for (const background of [Object.create(null), { constructor: undefined }]) {
      const scene = new Scene();
      scene.background = background;
      expect(observeSceneResources(scene, camera()).background).toBe("unobserved");
    }
  });

  test("counts lights, materials and objects, and reads the camera's framing", () => {
    const scene = new Scene();
    scene.background = new Color(0x112233);
    const sun = new DirectionalLight(0xffffff, 3);
    scene.add(sun, new AmbientLight(0x404040, 1), lit(), lit());
    scene.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    const observation = observeSceneResources(scene, camera());

    expect(observation.background).toBe("color:#112233");
    expect(observation.lights).toHaveLength(2);
    expect(observation.lights.find(({ type }) => type === "DirectionalLight")).toMatchObject({
      color: "#ffffff",
      intensity: 3,
      visible: true,
    });
    // Two lit meshes carry two distinct MeshStandardMaterial instances, counted per material.
    expect(observation.materials.MeshStandardMaterial).toBe(2);
    expect(observation.materials.MeshBasicMaterial).toBe(1);
    expect(observation.camera).toMatchObject({ far: 200, fov: 60, near: 0.1, type: "PerspectiveCamera" });
    expect(observation.camera.position).toEqual([0, 2, 10]);
    expect(observation.objects).toBeGreaterThan(0);
    expect(observation.truncated).toBe(false);
  });

  test("counts one shared material once rather than once per mesh", () => {
    const scene = new Scene();
    const shared = new MeshStandardMaterial();
    scene.add(new Mesh(new BoxGeometry(), shared), new Mesh(new BoxGeometry(), shared));
    expect(observeSceneResources(scene, camera()).materials.MeshStandardMaterial).toBe(1);
  });

  test("reports linear and exponential fog by their own fields, and no fog as absent", () => {
    const scene = new Scene();
    scene.add(lit());
    expect(observeSceneResources(scene, camera()).fog).toBeUndefined();
    scene.fog = new Fog(0x8899aa, 18, 80);
    expect(observeSceneResources(scene, camera()).fog).toEqual({
      color: "#8899aa",
      far: 80,
      near: 18,
      type: "linear",
    });
    scene.fog = new FogExp2(0x8899aa, 0.02);
    expect(observeSceneResources(scene, camera()).fog).toMatchObject({ density: 0.02, type: "exponential" });
  });

  test("omits a field it did not measure rather than reporting a zero for it", () => {
    const scene = new Scene();
    scene.add(lit());
    const orthographic = new OrthographicCamera(-1, 1, 1, -1, 0.1, 50);
    const observation = observeSceneResources(scene, orthographic);
    expect(observation.camera.fov).toBeUndefined();
    expect(observation.camera).toMatchObject({ far: 50, near: 0.1, type: "OrthographicCamera" });
  });
});

/** A snapshot shaped the way the bridge sends one, carrying only what a test needs. */
function overviewOf(scene: Scene, view = camera(), extra: Record<string, unknown> = {}) {
  return summariseScene({
    snapshot: {
      clock: { mode: "fixed-step", tick: 1 },
      entities: [],
      scene: observeSceneResources(scene, view),
      ...extra,
    } as never,
    url: "http://127.0.0.1:5173",
  });
}

describe("doctor names the two ways a frame is destroyed silently", () => {
  test("warns when lit materials are mounted and no light is visible", () => {
    const scene = new Scene();
    scene.add(lit());
    const overview = overviewOf(scene);
    expect(overview.warnings.some((warning) => warning.includes("no visible light"))).toBe(true);
    expect(overview.room?.summary.litMaterials).toBe(1);
  });

  test("does not warn about lighting when a visible light is present", () => {
    const scene = new Scene();
    scene.add(lit(), new DirectionalLight(0xffffff, 1));
    expect(overviewOf(scene).warnings.some((warning) => warning.includes("no visible light"))).toBe(false);
  });

  test("counts an invisible light as no light, because the renderer will", () => {
    const scene = new Scene();
    const sun = new DirectionalLight(0xffffff, 1);
    sun.visible = false;
    scene.add(lit(), sun);
    const overview = overviewOf(scene);
    expect(overview.room?.summary.lights).toMatchObject({ count: 1, visible: 0 });
    expect(overview.warnings.some((warning) => warning.includes("no visible light"))).toBe(true);
  });

  test("warns when the fog's far plane sits in front of the scene it is fogging", () => {
    // Round 9's defect exactly: a radius-90 sky dome behind a fog that ends at 80.
    const scene = new Scene();
    const dome = lit();
    dome.scale.setScalar(90);
    scene.add(dome, new DirectionalLight(0xffffff, 1));
    scene.fog = new Fog(0xffffff, 18, 80);
    const overview = overviewOf(scene);
    expect(overview.warnings.some((warning) => warning.includes("one flat wash"))).toBe(true);
  });

  test("does not warn when the fog reaches past the scene", () => {
    const scene = new Scene();
    scene.add(lit(), new DirectionalLight(0xffffff, 1));
    scene.fog = new Fog(0xffffff, 18, 400);
    expect(overviewOf(scene).warnings.some((warning) => warning.includes("one flat wash"))).toBe(false);
  });

  test("warns when the camera's far plane clips the scene", () => {
    const scene = new Scene();
    const far = lit();
    far.position.set(0, 0, -500);
    scene.add(far, new DirectionalLight(0xffffff, 1));
    expect(overviewOf(scene).warnings.some((warning) => warning.includes("far plane"))).toBe(true);
  });

  test("stops listing lights and camera framing as unobserved once it reports them", () => {
    const scene = new Scene();
    scene.add(lit(), new DirectionalLight(0xffffff, 1));
    const overview = overviewOf(scene);
    expect(overview.notObserved.join(" ")).not.toContain("camera framing");
    expect(overview.notObserved.join(" ")).toContain("texture contents");
  });

  test("still says lights and framing are unobserved when the bridge sends no scene", () => {
    const overview = summariseScene({
      snapshot: { clock: { mode: "fixed-step", tick: 1 }, entities: [] } as never,
      url: "http://127.0.0.1:5173",
    });
    expect(overview.room).toBeUndefined();
    expect(overview.notObserved.join(" ")).toContain("camera framing");
  });

  test("prints the room, and the feet against the ground, in the text report", () => {
    const scene = new Scene();
    scene.add(lit(), new DirectionalLight(0xffffff, 2));
    const overview = overviewOf(scene, camera(), {
      gameplay: {
        animation: {
          player: {
            advancedFrames: 30,
            clip: "walk",
            stride: { clipGroundSpeed: 1, groundSpeed: 4, overridden: true, rate: 1, synced: false },
          },
        },
        states: {},
      },
    });
    const text = formatSceneOverview(overview);
    expect(text).toContain("lighting");
    expect(text).toContain("1× DirectionalLight");
    expect(text).toContain("fov 60°");
    expect(text).toContain("stride");
    expect(overview.warnings.some((warning) => warning.includes("feet and the ground disagree"))).toBe(true);
  });

  test("reports no stride line for a game that does not measure one", () => {
    const scene = new Scene();
    scene.add(lit(), new DirectionalLight(0xffffff, 2));
    const overview = overviewOf(scene, camera(), {
      gameplay: { animation: { player: { advancedFrames: 30, clip: "walk" } }, states: {} },
    });
    expect(overview.room?.slides).toEqual([]);
    expect(formatSceneOverview(overview)).not.toContain("  stride ");
  });
});
