import {
  BackSide,
  BoxGeometry,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  type Side,
} from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { VirtualShadowNode } from "../src/render/virtual-shadow.js";

/**
 * A virtual page draws the front faces of a front-sided caster whose `shadowSide` is null, as
 * Unreal's sun does. three derives BackSide for it, and the back face of a wall box is the room's own
 * inner surface: the stored depth sat on the receiver and the sun leaked along every inner seam. A
 * shadowSide the author set is theirs, and the materials are put back once the level has drawn.
 */

const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

function wall(scene: Scene, side: Side, shadowSide: Side | null): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ side });
  material.shadowSide = shadowSide;
  const mesh = new Mesh(new BoxGeometry(2, 2, 0.2), material);
  mesh.position.set(scene.children.length * 3, 1, 0);
  mesh.castShadow = true;
  scene.add(mesh);
  return material;
}

describe("the faces a virtual page draws", () => {
  it("are the front faces of a front-sided caster, while a set shadowSide stays", () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(60, 200, -40);
    light.castShadow = true;
    scene.add(light, light.target);
    const camera = new PerspectiveCamera(60, 1, 0.1, 900);
    camera.position.set(0, 10, 0);
    scene.add(camera);
    const derived = wall(scene, FrontSide, null);
    const back = wall(scene, BackSide, null);
    const both = wall(scene, DoubleSide, null);
    const chosen = wall(scene, FrontSide, BackSide);
    scene.updateMatrixWorld(true);

    const node = new VirtualShadowNode(light, { clipExtents: [24], mapSize: 1024, marker: false });
    node.setup(builder);
    const drawn: (Side | null)[] = [];
    for (const levelNode of [...node.levelNodes, ...node.moverNodes])
      (levelNode as unknown as { updateShadow(frame: NodeFrame): void }).updateShadow = () => {
        drawn.push(derived.shadowSide, back.shadowSide, both.shadowSide, chosen.shadowSide);
      };
    node.updateBefore({ camera, renderer: {}, time: 1 } as unknown as NodeFrame);

    expect(drawn.length).toBeGreaterThan(0);
    // The derived BackSide material is drawn with FrontSide; the rest are left to three.
    expect(drawn.slice(0, 4)).toEqual([FrontSide, null, null, BackSide]);
    expect([derived.shadowSide, back.shadowSide, both.shadowSide, chosen.shadowSide]).toEqual([
      null,
      null,
      null,
      BackSide,
    ]);
  });
});
