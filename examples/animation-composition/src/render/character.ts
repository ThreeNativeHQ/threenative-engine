import type { ICtx } from "@threenative/core";
import {
  Bone,
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";

/** Eight animated bones plus a game-owned positional IK target; no redistributed asset. */
export function characterSource() {
  const root = new Group();
  const bones: Bone[] = [];
  const joint = (parent: Group | Bone, name: string, x: number, y: number, z: number) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent.add(bone);
    bones.push(bone);
    return bone;
  };
  const hips = joint(root, "Hips", 0, 0, 0);
  joint(hips, "LeftLeg", -0.17, -0.05, 0);
  joint(hips, "RightLeg", 0.17, -0.05, 0);
  const spine = joint(hips, "Spine", 0, 0.15, 0);
  joint(spine, "Head", 0, 0.5, 0);
  const arm = joint(spine, "Arm", 0.23, 0.38, 0);
  const forearm = joint(arm, "Forearm", 0.32, 0, 0);
  joint(forearm, "RightHand", 0.28, 0, 0);
  joint(root, "Target", 0.65, 0.53, 0.2);
  const boxes = [
    [0, 0, 0, 0, 0.4, 0.18, 0.25],
    [1, -0.17, -0.4, 0, 0.2, 0.7, 0.2],
    [2, 0.17, -0.4, 0, 0.2, 0.7, 0.2],
    [3, 0, 0.3, 0, 0.42, 0.42, 0.24],
    [4, 0, 0.68, 0, 0.28, 0.28, 0.28],
    [5, 0.39, 0.53, 0, 0.32, 0.13, 0.13],
    [6, 0.69, 0.53, 0, 0.28, 0.12, 0.12],
    [7, 0.85, 0.53, 0, 0.12, 0.14, 0.14],
  ] as const;
  const parts = boxes.map(([bone, x, y, z, w, h, d]) => {
    const geometry = new BoxGeometry(w, h, d).translate(x, y, z);
    const count = geometry.getAttribute("position").count;
    const indices = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      indices[i * 4] = bone;
      weights[i * 4] = 1;
    }
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(indices, 4));
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    return geometry;
  });
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (geometry === null) throw new Error("Composition character geometry did not merge.");
  const material = new MeshStandardMaterial({ color: 0x55c4ae, roughness: 0.7 });
  const skin = new SkinnedMesh(geometry, material);
  skin.name = "characterSkin";
  root.add(skin);
  root.updateMatrixWorld(true);
  skin.bind(new Skeleton(bones));
  return { root, skin, geometry, material };
}

export function cloneCharacter(source: ReturnType<typeof characterSource>) {
  const root = clone(source.root) as Group;
  const skin = root.getObjectByName("characterSkin");
  if (!(skin instanceof SkinnedMesh)) throw new Error("Composition cloned skin is missing.");
  return { root, skin, bones: skin.skeleton.bones };
}

export function courseLook(ctx: Pick<ICtx, "scene" | "camera" | "add">, crowd: boolean) {
  ctx.scene.background = new Color(0x111b22);
  ctx.add(new HemisphereLight(0xc8e7ef, 0x3f504c, 3));
  const floorGeometry = new BoxGeometry(22, 0.1, 24);
  const wallGeometry = new BoxGeometry(12, 2, 0.5);
  const floorMaterial = new MeshStandardMaterial({ color: 0x334a4b, roughness: 0.9 });
  const wallMaterial = new MeshStandardMaterial({ color: 0xdc9567, roughness: 0.8 });
  const floor = new Mesh(floorGeometry, floorMaterial);
  floor.position.set(0, -0.1, 3);
  ctx.add(floor);
  const wall = new Mesh(wallGeometry, wallMaterial);
  wall.position.set(0, 1, 6);
  if (!crowd) ctx.add(wall);
  const camera = ctx.camera as PerspectiveCamera;
  camera.position.set(crowd ? 15 : 5, crowd ? 14 : 4, crowd ? 20 : -6);
  camera.lookAt(0, crowd ? 1 : 0.8, crowd ? 0 : 3);
  return () => {
    floorGeometry.dispose();
    wallGeometry.dispose();
    floorMaterial.dispose();
    wallMaterial.dispose();
  };
}
