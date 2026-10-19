/// <reference types="vite/client" />
import { type ICtx, Scene, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  AmbientLight,
  type AnimationClip,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Vector3,
} from "three";
import { ClippingGroup } from "three/webgpu";
import { createLocomotionTrace } from "./vq-locomotion-trace.js";

const eye = new Vector3();
/** Eye position relative to the head bone: slightly up, forward of the neck (the rig faces -z). */
const EYE_OFFSET = new Vector3(0, 0.1, -0.26);
/** Pitch below the horizon, radians. */
const LOOK_DOWN = (46 * Math.PI) / 180;
/** Where the KayKit rig stands beside the mannequin, in metres. Its own front faces the camera. */
const KAYKIT_PLACEMENT = new Vector3(1.15, 0, -2.3);
/** The KayKit rig is taller than the framing allows at this depth, so it is shown at this scale. */
const KAYKIT_SCALE = 0.7;
/**
 * The gait camera, relative to the KayKit rig: 2.9 m in front of it at 50 degrees off its front,
 * 1.15 m up and looking down on its middle, so a sideways step crosses the frame and a backward one
 * turns the body to face the lens. The first-person eye cannot carry that claim: it is pitched 46
 * degrees down, so the rig is seen from above. Its 34 degree field of view is what keeps the
 * first-person body out of this frame - at 2.9 m it stands between the two rigs - while still
 * covering the whole 0.7-scaled body and the floor under its feet.
 */
const GAIT_VIEW = {
  at: new Vector3(0, 0.72, 0),
  eye: new Vector3(-2.22, 1.15, 1.86),
  fov: 34,
};

/** What `ctx.assets.model` hands back for a glTF: the scene it carries and its authored clips. */
type Glb = { animations: AnimationClip[]; scene: Object3D };

/** The one camera this fixture frames through, narrowed: `defineGame` below asks for perspective. */
function perspectiveOf(ctx: ICtx): PerspectiveCamera {
  if (!(ctx.camera instanceof PerspectiveCamera))
    throw new Error("The locomotion fixture frames through a perspective camera.");
  return ctx.camera;
}

/** The three unmodified CC0 KayKit files, loaded as project assets by name, in load order. */
const KAYKIT_FILES = [
  "kaykit-rig-medium-general.glb",
  "kaykit-rig-medium-movement-basic.glb",
  "kaykit-rig-medium-movement-advanced.glb",
] as const;

/** Two CC0 mannequin rigs under one scripted speed trace, plus the KayKit rig under a direction one. */
class VqLocomotion extends Scene {
  #model: Glb | undefined;
  #kaykit: Glb[] = [];

  override async load(ctx: ICtx): Promise<void> {
    this.#model = await ctx.assets.model("mannequin.glb");
    this.#kaykit = await Promise.all(KAYKIT_FILES.map((file) => ctx.assets.model<Glb>(file)));
  }

  override enter(ctx: ICtx) {
    if (this.#model === undefined) throw new Error("Mannequin did not load.");
    ctx.scene.background = new Color(0x263346);
    ctx.add(new AmbientLight(0xd5e3ff, 2));
    const key = new DirectionalLight(0xffe4c4, 3);
    key.position.set(3, 5, 4);
    ctx.add(key);
    const floor = new Mesh(
      new PlaneGeometry(9, 9),
      new MeshStandardMaterial({ color: 0x526474, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    ctx.add(floor);
    const trace = createLocomotionTrace(this.#model, this.#kaykit);
    // Neither rig translates: this fixture animates, and the first-person one stands under the
    // camera whose eye height it measures. The third-person one stands across the floor in front,
    // turned to face back. Both face the camera's forward direction, so neither is seen from behind.
    trace.third.group.position.set(0, 0, -3);
    trace.third.group.rotation.y = Math.PI;
    trace.first.group.rotation.y = Math.PI;
    // The directional rig stands beside the other two, inside the same framing and at the same
    // depth, so one screenshot shows the speed trace and the direction trace on the same floor.
    trace.kaykit.group.position.copy(KAYKIT_PLACEMENT);
    trace.kaykit.group.scale.setScalar(KAYKIT_SCALE);
    // Its authored material is metallic grey, which an ambient-lit scene renders near black; a
    // diffuse material keeps the gait readable in the evidence frames.
    trace.kaykit.group.traverse((node) => {
      const material = (node as Mesh).material;
      if (material instanceof MeshStandardMaterial) {
        material.metalness = 0;
        material.roughness = 0.8;
      }
    });
    ctx.add(trace.third.group);
    ctx.add(trace.kaykit.group);
    // A first-person body never draws its own head and torso, and a clipping group is the seam the
    // renderer's projection already walks: one world plane at the head bone's own height stops the
    // skull being submitted, so no material is edited, no second mesh exists and the rig still
    // plays the clips the driver asked for. Measured, not authored: the rig decides where its head
    // is.
    trace.first.head.updateWorldMatrix(true, false);
    trace.first.head.getWorldPosition(eye);
    const viewBody = new ClippingGroup();
    viewBody.clippingPlanes = [new Plane(new Vector3(0, -1, 0), eye.y)];
    // The eye sits just above and in front of the head bone, which is where a face is.
    eye.add(EYE_OFFSET);
    ctx.camera.position.copy(eye);
    viewBody.add(trace.first.group);
    ctx.add(viewBody);
    // Pitched down far enough that the body's own arms and legs are in frame under the horizon.
    const firstPersonAt = new Vector3(
      eye.x,
      eye.y - Math.sin(LOOK_DOWN) * 5,
      eye.z - Math.cos(LOOK_DOWN) * 5,
    );
    ctx.camera.lookAt(firstPersonAt);
    // The two views are this fixture's own framing, so switching between them is three numbers and
    // no rig moves. The first person one stays the default and the only one the trace plays by.
    const firstPerson = { at: firstPersonAt, eye: eye.clone(), fov: perspectiveOf(ctx).fov };
    const gait = {
      at: KAYKIT_PLACEMENT.clone().add(GAIT_VIEW.at),
      eye: KAYKIT_PLACEMENT.clone().add(GAIT_VIEW.eye),
      fov: GAIT_VIEW.fov,
    };
    ctx.entities.add("third-person-locomotion", {
      debug: trace.third.report,
      mesh: trace.third.group,
    });
    ctx.entities.add("first-person-locomotion", {
      debug: trace.first.report,
      mesh: trace.first.group,
    });
    ctx.entities.add("kaykit-directional-locomotion", {
      debug: trace.kaykit.report,
      mesh: trace.kaykit.group,
    });
    let gaitView = false;
    let started = false;
    let reported = false;
    return (frameCtx: ICtx) => {
      // One ternary, not a branch per view: this callback is already at the cognitive complexity
      // limit, and the toggle must not be what pushes it over.
      gaitView = frameCtx.input.justPressed("gait") ? !gaitView : gaitView;
      const view = gaitView ? gait : firstPerson;
      const camera = perspectiveOf(frameCtx);
      camera.position.copy(view.eye);
      camera.lookAt(view.at);
      camera.fov = view.fov;
      camera.updateProjectionMatrix();
      if (frameCtx.input.justPressed("start")) started = true;
      if (!started || trace.observation.complete) return;
      trace.step();
      frameCtx.state.set(trace.observation);
      if (trace.observation.complete && !reported) {
        reported = true;
        frameCtx.state.flush();
        console.log(`TN_VQ_LOCOMOTION:${JSON.stringify(trace.observation)}`);
      }
    };
  }
}

export default defineGame({
  initialState: {},
  camera: { projection: "perspective", fov: 85, near: 0.05, far: 50 },
  input: { gait: { keys: ["KeyC"] }, start: { keys: ["Space"] } },
  plugins: [playtest()],
  render: { preferWebGPU: true },
  scenes: { locomotion: VqLocomotion },
  start: "locomotion",
});
