import * as THREE from "three/webgpu";
import { mrt, normalView, normalize, output, pass, rtt, vec3, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// A material normalNode under a post chain that reads the scene pass's normal target (PRD-777: the spell port's
// debris shades with a rotated normal while the post chain reads normals). The output shows the normal target as
// colour: the left sphere's normalNode is one tilted direction (a flat colour), the right sphere keeps its own.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "post-normal-node", ({ renderer, scene, camera }) => {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2));
    const tilted = new THREE.MeshStandardNodeMaterial({ color: 0x80c0ff, roughness: 0.5 });
    tilted.normalNode = normalize(vec3(0.5, 0.5, 1));
    const left = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16), tilted);
    left.position.x = -0.7;
    const right = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 32, 16),
      new THREE.MeshStandardNodeMaterial({ color: 0xffc080, roughness: 0.5 }),
    );
    right.position.x = 0.7;
    scene.add(left, right);
    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const normal = scenePass.getTextureNode("normal");
    const pipeline = new THREE.RenderPipeline(renderer);
    // rtt: the normal is read inside a post pass, as an effect reads it (the output stage alone reads no aux target).
    pipeline.outputNode = rtt(vec4(normal.rgb.mul(0.5).add(0.5), 1));
    return { detail: { normalNode: true }, render: () => pipeline.render() };
  });
}
