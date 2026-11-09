import * as THREE from "three/webgpu";
import { float, mix, pass, rtt, step, uv, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// PRD-635: ambient occlusion darkens only the light that comes from around. A floor and a wall lit by a sun and a sky
// light, with a full occlusion (0) on the left half of the frame and none (1) on the right. The left half must keep the
// sun and lose the sky light exactly: the frame without its indirect diffuse share.
//
// The owned engine writes each lit draw's indirect diffuse light to its `indirectDiffuse` target, so its frame is
// `scene - indirect * (1 - ao)`. Upstream three has no such target, so it draws the same picture from a second copy of
// the scene with the sky light removed: `mix(sunOnly, scene, ao)`. The two engines agree only if the target holds the
// sky light's share and nothing of the sun's.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "ao-indirect-only", ({ renderer, scene, camera }) => {
    camera.position.set(0, 1.2, 3.2);
    camera.lookAt(0, 0.3, 0);
    const build = (target, sky) => {
      const sun = new THREE.DirectionalLight(0xfff2e0, 2.5);
      sun.position.set(-1, 2, 1.5);
      target.add(sun);
      if (sky) target.add(new THREE.HemisphereLight(0x9fc4ff, 0x4a3a2a, 2));
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(6, 6),
        new THREE.MeshStandardNodeMaterial({ color: 0xb8b0a0, roughness: 0.9 }),
      );
      floor.rotation.x = -Math.PI / 2;
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(3, 1.6, 0.2),
        new THREE.MeshStandardNodeMaterial({ color: 0x8fb8d8, roughness: 0.7 }),
      );
      wall.position.set(0, 0.8, -0.6);
      target.add(floor, wall);
    };
    build(scene, true);
    // The full occlusion on the left half, none on the right.
    const ao = step(float(0.5), uv().x);
    const full = pass(scene, camera);
    const pipeline = new THREE.RenderPipeline(renderer);
    const owned = renderer.info.engine !== undefined;
    let frame;
    if (owned) {
      const indirect = full.getTextureNode("indirectDiffuse").rgb;
      frame = full.getTextureNode("output").rgb.sub(indirect.mul(float(1).sub(ao)));
    } else {
      const sunOnly = new THREE.Scene();
      sunOnly.background = scene.background;
      build(sunOnly, false);
      frame = mix(pass(sunOnly, camera).getTextureNode("output").rgb, full.getTextureNode("output").rgb, ao);
    }
    // rtt: the target is read inside a post pass, as the AO stage reads it (the output stage alone reads no aux target).
    pipeline.outputNode = rtt(vec4(frame, 1));
    return { detail: { aoIndirectOnly: true, owned }, render: () => pipeline.render() };
  });
}
