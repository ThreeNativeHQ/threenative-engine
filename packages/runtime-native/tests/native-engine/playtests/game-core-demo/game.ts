import { type ICtx, Scene, defineGame } from "@threenative/core";
import { BoxGeometry, DirectionalLight, Mesh, MeshStandardMaterial, PlaneGeometry } from "three";
import { platform } from "../../../../src/engine/player/core-host.mjs";

class Play extends Scene {
  static initialState = {};

  enter(ctx: ICtx) {
    const surface = new MeshStandardMaterial();
    surface.color.setHex(0xd95a33);
    const player = ctx.add(new Mesh(new BoxGeometry(1.4, 1.4, 1.4), surface));
    player.name = "player";
    player.position.y = 0.7;

    const ground = new MeshStandardMaterial();
    ground.color.setHex(0x383d47);
    const floor = ctx.add(new Mesh(new PlaneGeometry(40, 40), ground));
    floor.name = "floor";
    floor.rotation.x = -Math.PI / 2;
    const light = ctx.add(new DirectionalLight(0xffffff, 3));
    light.position.set(4, 8, 4);
    ctx.camera.position.set(3.4, 2.6, 4.4);
    ctx.camera.lookAt(0, 0.7, 0);

    return (_ctx: ICtx, dt: number) => {
      const move = ctx.input.vector("move");
      player.position.x += move.x * 6 * dt;
      player.position.z -= move.y * 6 * dt;
    };
  }
}

export default defineGame({
  platform,
  input: {
    move: { up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"] },
  },
  frameBudget: false,
  render: { projection: false, matrixWorld: "all" },
  scenes: { play: Play },
  start: "play",
});
