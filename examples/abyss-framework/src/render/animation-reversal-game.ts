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
  PlaneGeometry,
} from "three";
import mannequinUrl from "../../../../packages/create-threenative/template-assets/assets/mannequin.glb?url";
import { createReversalTrace } from "./animation-reversal-trace.js";

/** CC0 Quaternius mannequin and its shipped locomotion clips, not a proxy skeleton. */
class AnimationReversal extends Scene {
  #model: { scene: Object3D; animations: AnimationClip[] } | undefined;

  override async load(ctx: ICtx): Promise<void> {
    this.#model = await ctx.assets.model(mannequinUrl);
  }

  override enter(ctx: ICtx) {
    if (this.#model === undefined) throw new Error("Mannequin did not load.");
    const limit = Number(new URLSearchParams(globalThis.location?.search ?? "").get("tick") ?? 108);
    if (!Number.isInteger(limit) || limit < 1 || limit > 108)
      throw new Error("Invalid capture tick.");
    ctx.camera.position.set(2.1, 1.6, 3.6);
    ctx.camera.lookAt(0, 0.95, 0);
    ctx.scene.background = new Color(0x263346);
    ctx.add(new AmbientLight(0xd5e3ff, 2));
    const key = new DirectionalLight(0xffe4c4, 3);
    key.position.set(3, 5, 4);
    ctx.add(key);
    const floor = new Mesh(
      new PlaneGeometry(7, 7),
      new MeshStandardMaterial({ color: 0x526474, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    ctx.add(floor);
    const trace = createReversalTrace(this.#model);
    ctx.add(trace.player.root);
    ctx.entities.add("locomotion", {
      animation: trace.player,
      mesh: trace.player.root,
      debug: trace.observation,
      dispose: () => trace.player.dispose(),
    });
    let started = false;
    let reported = false;
    return (frameCtx: ICtx) => {
      if (frameCtx.input.justPressed("start")) started = true;
      if (!started || trace.observation().tick >= limit) return;
      trace.step();
      frameCtx.state.set(trace.observation());
      if (trace.observation().tick === limit && !reported) {
        reported = true;
        frameCtx.state.flush();
        console.log(`TN_ANIMATION_REVERSAL:${JSON.stringify(trace.observation())}`);
      }
    };
  }
}

export default defineGame({
  initialState: {},
  camera: { projection: "perspective", fov: 42, near: 0.1, far: 50 },
  input: { start: { keys: ["Space"] } },
  plugins: [playtest()],
  render: { preferWebGPU: true },
  scenes: { reversal: AnimationReversal },
  start: "reversal",
});
