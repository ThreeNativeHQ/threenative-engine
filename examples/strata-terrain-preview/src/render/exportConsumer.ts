import { type ICtx, Scene, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  Box3,
  Color,
  DirectionalLight,
  type Group,
  HemisphereLight,
  Mesh,
  type PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";

// Receiving-game appearance: this proof imports no terrain authoring/editor module.
const initialState = {
  placements: 0,
  meshes: 0,
  pbrMaps: 0,
  cameras: 0,
  animations: 0,
  frames: 0,
  manualX: 0,
  manualY: 0,
  manualZ: 0,
  manualScaleX: 0,
  manualScaleY: 0,
  manualScaleZ: 0,
};
type State = typeof initialState;
class ExportConsumer extends Scene<State> {
  static override readonly initialState = initialState;
  #world: Group | undefined;
  override async load(ctx: ICtx<State>): Promise<void> {
    const gltf = await ctx.assets.model<{
      scene: Group;
      cameras: unknown[];
      animations: unknown[];
    }>("world.glb");
    this.#world = gltf.scene;
    gltf.scene.updateMatrixWorld(true);
    let placements = 0;
    let meshes = 0;
    let pbrMaps = 0;
    let manual = false;
    gltf.scene.traverse((object) => {
      const id = object.userData.placementId;
      if (typeof id === "string") {
        placements++;
        if (id.endsWith(":0")) {
          const position = new Vector3();
          const scale = new Vector3();
          object.matrixWorld.decompose(position, new Quaternion(), scale);
          ctx.state.set({
            manualX: position.x,
            manualY: position.y,
            manualZ: position.z,
            manualScaleX: scale.x,
            manualScaleY: scale.y,
            manualScaleZ: scale.z,
          });
          manual = true;
        }
      }
      if (!(object instanceof Mesh)) return;
      meshes++;
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        pbrMaps += [material.map, material.normalMap, material.roughnessMap, material.aoMap].filter(
          Boolean,
        ).length;
    });
    // The whole exported world: terrain, two PBR sets and a river, the 100 placements' 200 draws,
    // and the water's one. The counts are measured, not assumed, so a partial load fails here.
    if (!manual || placements !== 100 || meshes !== 202 || pbrMaps !== 404)
      throw new Error("Portable GLB consumer did not load the complete export fixture");
    ctx.state.set({
      placements,
      meshes,
      pbrMaps,
      cameras: gltf.cameras.length,
      animations: gltf.animations.length,
    });
    ctx.add(gltf.scene);
  }
  override enter(ctx: ICtx<State>): void {
    if (!this.#world) throw new Error("world.glb did not load");
    ctx.scene.background = new Color(0xa6c5d3);
    ctx.add(new HemisphereLight(0xd6e9ef, 0x403c2e, 1.2));
    const sun = new DirectionalLight(0xffedd4, 2.8);
    sun.position.set(-180, 240, 120);
    ctx.add(sun);
    // engine-override: GLB already uses metres; measure camera framing without rescaling saved terrain/placement poses.
    const bounds = new Box3().setFromObject(this.#world);
    const at = bounds.getCenter(new Vector3());
    const radius = bounds.getSize(new Vector3()).length() / 2;
    const camera = ctx.camera as PerspectiveCamera;
    camera.fov = 60;
    camera.near = 0.1;
    camera.far = 5000;
    camera.position
      .copy(at)
      .add(
        new Vector3(0.7, 0.65, 1)
          .normalize()
          .multiplyScalar((radius / Math.sin(Math.PI / 6)) * 1.1),
      );
    camera.lookAt(at);
    camera.updateProjectionMatrix();
    ctx.add(camera);
  }
  override update(ctx: ICtx<State>): void {
    ctx.state.set({ frames: ctx.state.getState().frames + 1 });
  }
}
export default defineGame({
  input: {},
  plugins: [playtest()],
  assets: { basePath: "artifacts/playtest/world-export", sourcePath: "" },
  render: { preferWebGPU: true },
  scenes: { exported: ExportConsumer },
  start: "exported",
});
