import { readFileSync } from "node:fs";
import {
  type Bone,
  BufferAttribute,
  type Object3D,
  PlaneGeometry,
  SkinnedMesh,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** The shipped mannequin at its bind pose, plus capes hung on it the way the example game does. */
export interface IMannequinBindPose {
  readonly scene: Object3D;
  readonly body: SkinnedMesh;
  readonly spine: Bone;
  /** A cape-like SkinnedMesh rigidly weighted to spine_03, behind the torso. */
  cape(): SkinnedMesh;
}

/** Loads `examples/character-dynamics/public/mannequin.glb` through three's GLTFLoader in node. */
export async function mannequinBindPose(): Promise<IMannequinBindPose> {
  const bytes = readFileSync(
    new URL("../../../examples/character-dynamics/public/mannequin.glb", import.meta.url),
  );
  const model = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const scene = model.scene;
  scene.updateMatrixWorld(true);
  const bodies: SkinnedMesh[] = [];
  scene.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh === true) bodies.push(object as SkinnedMesh);
  });
  const body = bodies[0];
  const spine = body?.skeleton.bones.find((bone) => bone.name === "spine_03") as Bone | undefined;
  if (body === undefined || spine === undefined)
    throw new Error("mannequin.glb has no SkinnedMesh with a spine_03 bone.");
  const skeleton = body.skeleton;
  const boneIndex = skeleton.bones.indexOf(spine);
  const centre = spine.getWorldPosition(new Vector3());
  return {
    scene,
    body,
    spine,
    cape(): SkinnedMesh {
      const geometry = new PlaneGeometry(0.5, 0.8, 4, 6).translate(
        centre.x,
        centre.y - 0.25,
        centre.z - 0.18,
      );
      const count = geometry.getAttribute("position").count;
      const index = new Uint16Array(count * 4);
      const weight = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        index[v * 4] = boneIndex;
        weight[v * 4] = 1;
      }
      geometry.setAttribute("skinIndex", new BufferAttribute(index, 4));
      geometry.setAttribute("skinWeight", new BufferAttribute(weight, 4));
      const cape = new SkinnedMesh(geometry, new MeshStandardNodeMaterial());
      scene.add(cape);
      cape.updateMatrixWorld(true);
      cape.bind(skeleton, cape.matrixWorld);
      scene.updateMatrixWorld(true);
      return cape;
    },
  };
}
