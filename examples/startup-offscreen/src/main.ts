import { Scene, defineGame } from "@threenative/core";
import type { ICtx } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { Group, Mesh, MeshBasicMaterial, SphereGeometry } from "three";

/**
 * The fixture for PRD-744: a start scene that awaits one model the spawn camera sees and one
 * large model the manifest sizes at 48 MB. `?forest=behind` places the large one behind the camera,
 * so the reveal waited for 48 MB nobody sees; the default places it ahead, in view.
 *
 * The loader is synthetic on purpose: the property under test is the reveal's measurement, not
 * decoding, and the manifest (`public/assets.manifest.json`) is what gives each path its bytes.
 */
const behind = new URLSearchParams(location.search).get("forest") === "behind";

class Spawn extends Scene {
  static override readonly initialState = {};

  override async load(ctx: ICtx): Promise<void> {
    const near = await ctx.assets.model<Group>("near.glb");
    const forest = await ctx.assets.model<Group>("forest.glb");
    near.position.set(0, 0, -6);
    forest.position.set(0, 0, behind ? 40 : -30);
    ctx.scene.add(near, forest);
  }
}

void defineGame({
  assets: {
    // One sphere per model: enough geometry for the reveal to find bounds in or out of view.
    model: async () => {
      const root = new Group();
      root.add(new Mesh(new SphereGeometry(2, 16, 12), new MeshBasicMaterial({ color: 0x66aa88 })));
      return root;
    },
  },
  plugins: [playtest()],
  render: { preferWebGPU: true },
  scenes: { spawn: Spawn },
  start: "spawn",
}).start();
