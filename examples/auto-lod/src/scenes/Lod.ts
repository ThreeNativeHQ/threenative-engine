import { type ICtx, Scene, type SceneFrame, baseGeometryOf } from "@threenative/core";
import { AmbientLight, DirectionalLight, type Group, Mesh, type PerspectiveCamera } from "three";

/** Close enough that the model's own error projects past a one-pixel budget. */
const NEAR = 4;
/** Far enough that the coarsest baked level projects under it. */
const FAR = 140;

/**
 * One static model, a camera route with two ends, and nothing else. `assets.lod` cooks a
 * `TN_discrete_lod` chain into `hull.glb`; the engine selects the level; the scenarios read the
 * submitted triangle count at each end of the route.
 *
 * The count is published as scene state rather than only read from the renderer, because the
 * native playtest target carries the state channel and not the browser performance sampler. The
 * engine swaps `mesh.geometry` before the render, so a frame after a settle reads the selected level.
 */
export class Lod extends Scene {
  static override readonly initialState = {
    camera: "far",
    cardCopies: 0,
    cardTriangles: 0,
    triangles: 0,
  };

  #loaded = false;
  readonly #meshes: Mesh[] = [];
  /** The card crown: its levels draw scaled copies appended after LOD0's vertices (PRD-541). */
  readonly #cards: Mesh[] = [];

  override async load(ctx: ICtx): Promise<void> {
    const model = await ctx.assets.model<{ scene: Group }>("hull.glb");
    model.scene.name = "hull";
    model.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.name = "hull-mesh";
      this.#meshes.push(object);
    });
    ctx.scene.add(model.scene);
    const crown = await ctx.assets.model<{ scene: Group }>("cards.glb");
    crown.scene.name = "cards";
    crown.scene.position.set(3, 0, 0);
    crown.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.name = "cards-mesh";
      this.#cards.push(object);
    });
    ctx.scene.add(crown.scene);
    this.#loaded = true;
  }

  override enter(ctx: ICtx): SceneFrame {
    if (!this.#loaded) throw new Error("hull.glb did not load");
    const camera = ctx.camera as PerspectiveCamera;
    camera.fov = 60;
    camera.near = 0.1;
    camera.far = 1000;
    camera.position.set(0, 0, FAR);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    ctx.add(camera);
    ctx.scene.add(new AmbientLight(0xffffff, 1.5));
    const key = new DirectionalLight(0xffffff, 2.5);
    key.position.set(4, 6, 5);
    ctx.scene.add(key);

    return (frameCtx) => {
      let triangles = 0;
      for (const mesh of this.#meshes) {
        const drawn = mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count;
        triangles += Math.floor((drawn ?? 0) / 3);
      }
      // A level that reaches a vertex LOD0 never indexes is drawing the scaled card copies.
      let cardTriangles = 0;
      let cardCopies = 0;
      for (const mesh of this.#cards) {
        const drawn = mesh.geometry.index;
        const lod0 = baseGeometryOf(mesh).index;
        if (drawn === null || lod0 === null) continue;
        cardTriangles += Math.floor(drawn.count / 3);
        let lod0Max = 0;
        for (let at = 0; at < lod0.count; at += 1) lod0Max = Math.max(lod0Max, lod0.getX(at));
        for (let at = 0; at < drawn.count; at += 1)
          if (drawn.getX(at) > lod0Max) {
            cardCopies = 1;
            break;
          }
      }
      frameCtx.state.set({ cardCopies, cardTriangles, triangles });
      if (!frameCtx.input.justPressed("toggleNear")) return;
      // Toggle, so a scenario can drive the value and prove the selection follows the camera
      // rather than reporting a number that never changed.
      const wasNear = camera.position.z === NEAR;
      camera.position.set(0, 0, wasNear ? FAR : NEAR);
      camera.lookAt(0, 0, 0);
    };
  }
}
