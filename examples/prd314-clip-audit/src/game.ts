import {
  AnimationPlayer,
  type ICtx,
  Scene,
  type SceneFrame,
  boneContact,
  clipBoneCoverage,
  clipPoseError,
  clipTrackBindings,
  defineGame,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { CHAIN, boneAtEnd, buildRig, retargetedClip, sourceClip } from "./rig.js";

/** Everything the four checks report, as numbers a scenario can assert. */
export interface IClipAuditState extends Record<string, unknown> {
  arm: string;
  pose: {
    meanDegrees: number;
    maxDegrees: number;
    worstBone: string;
    worstDegrees: number;
  };
  bindings: {
    tracks: number;
    bound: number;
    unbound: string[];
  };
  coverage: {
    bones: number;
    driven: number;
    undriven: string[];
  };
  contact: {
    handMetres: number;
    hipsMetres: number;
    hipsSeated: boolean;
  };
}

const initialState: IClipAuditState = {
  arm: "unmeasured",
  pose: { meanDegrees: -1, maxDegrees: -1, worstBone: "unmeasured", worstDegrees: -1 },
  bindings: { tracks: -1, bound: -1, unbound: [] },
  coverage: { bones: -1, driven: -1, undriven: [] },
  contact: { handMetres: -1, hipsMetres: -1, hipsSeated: false },
};

function brokenArm(): boolean {
  return new URLSearchParams(globalThis.location?.search ?? "").get("arm") === "broken";
}

class ClipAudit extends Scene<IClipAuditState> {
  static override readonly initialState = initialState;

  override enter(ctx: ICtx<IClipAuditState>): SceneFrame<IClipAuditState> {
    const broken = brokenArm();
    ctx.camera.position.set(2.4, 1.4, 2.4);
    ctx.camera.lookAt(0, 0.9, 0);
    ctx.scene.add(new AmbientLight(0xffffff, 1.4));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 4, 3);
    ctx.scene.add(key);

    // The reference rig is the one the clip was authored on; the played rig's Arm bone sits 90
    // degrees rolled at rest, which is the bind-convention difference a retarget has to convert.
    const reference = buildRig("reference", new MeshStandardMaterial({ color: 0x39506e }), 0);
    const played = buildRig("worker", new MeshStandardMaterial({ color: 0xd08a4a }), 90);
    reference.root.position.x = -1.7;
    ctx.add(reference.root);
    ctx.add(played.root);

    const source = sourceClip();
    const retargeted = retargetedClip(reference, played, source, {
      convert: broken ? "world" : "delta",
      drive: broken ? ["Hips", "Spine"] : CHAIN,
      misname: broken ? ["Hips"] : [],
    });

    // The desk goes where a correct retarget puts the hand, and stays there for both arms.
    const desk = new Mesh(
      new BoxGeometry(0.14, 0.03, 0.12),
      new MeshStandardMaterial({ color: 0x2f3b52 }),
    );
    desk.name = "keyboard";
    desk.position
      .copy(
        boneAtEnd(played, "Hand", retargetedClip(reference, played, source, { convert: "delta" })),
      )
      .add(new Vector3(0, -0.05, 0));
    ctx.add(desk);

    const player = new AnimationPlayer({ clips: [retargeted, source], root: played.root });
    player.play(retargeted.name, { mode: "once" });
    const referencePlayer = new AnimationPlayer({ clips: [source], root: reference.root });
    referencePlayer.play(source.name, { mode: "once" });

    const seat = new Mesh(
      new BoxGeometry(0.5, 0.12, 0.5),
      new MeshStandardMaterial({ color: 0x394a33 }),
    );
    seat.name = "seat";
    seat.position.set(0, 0.4, 0);
    ctx.add(seat);

    let audited: { pose: number; bound: number; tracks: number } | undefined;
    ctx.entities.add("clip-audit", {
      debug: () => audited ?? { pose: -1, bound: -1, tracks: -1 },
      dispose: () => undefined,
      mesh: played.root,
    });

    // The audit runs after the clip has played once, so a scenario drives it rather than reading a
    // number that was already on the board before it started.
    ctx.after(1.2, () => {
      const pose = clipPoseError(
        { root: played.root, clip: retargeted },
        { root: reference.root, clip: source },
      );
      const bindings = clipTrackBindings(played.root, retargeted);
      const coverage = clipBoneCoverage(played.root, retargeted);
      const worst = pose.bones[0];
      audited = { pose: pose.meanDegrees, bound: bindings.bound, tracks: bindings.tracks };
      ctx.state.set({
        arm: broken ? "broken" : "correct",
        pose: {
          meanDegrees: pose.meanDegrees,
          maxDegrees: pose.maxDegrees,
          worstBone: worst?.bone ?? "none",
          worstDegrees: worst?.meanDegrees ?? -1,
        },
        bindings: {
          tracks: bindings.tracks,
          bound: bindings.bound,
          unbound: bindings.unbound.map(({ track }) => track),
        },
        coverage: {
          bones: coverage.bones,
          driven: coverage.driven.length,
          undriven: [...coverage.undriven],
        },
      });
      ctx.state.flush();
      console.log(
        `TN_CLIP_AUDIT:${JSON.stringify({
          arm: broken ? "broken" : "correct",
          meanDegrees: pose.meanDegrees,
          unbound: bindings.unbound.map(({ track }) => track),
          undriven: coverage.undriven,
        })}`,
      );
    });

    // `boneContact` walks the desk's vertices, so it is sampled rather than run every frame.
    let frame = 0;
    return (frameCtx, dt) => {
      player.update(dt);
      referencePlayer.update(dt);
      frame += 1;
      if (frame < 72 || frame % 5 !== 0) return;
      played.root.updateMatrixWorld(true);
      const hand = boneContact(played.root, "Hand", desk);
      const hips = boneContact(played.root, "Hips", seat);
      frameCtx.state.set({
        contact: {
          handMetres: hand.distance,
          hipsMetres: hips.distance,
          hipsSeated: hips.inside,
        },
      });
    };
  }
}

const game = defineGame<IClipAuditState>({
  plugins: [playtest()],
  renderer: { preferWebGPU: true },
  scenes: { clipAudit: ClipAudit },
  start: "clipAudit",
});

export default game;
