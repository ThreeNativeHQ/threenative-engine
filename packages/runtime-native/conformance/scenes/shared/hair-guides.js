import * as THREE from "three/webgpu";
import { attribute } from "three/tsl";
import { HairStrands3D } from "@threenative/core";
import { startVisualScene } from "./scene-support.js";

// 24 guide strands on a moving head bone, simulated by the shipped `HairStrands3D` solver on both
// hosts and drawn as ribbon cards whose position node reads the solver buffer. The head moves for a
// fixed number of steps during setup; the frame loop only draws, so every host captures the same hair.
const STEPS = 60;
const GUIDES = 24;
const POINTS = 16;

export function assertHairGuidesProof(hair) {
  if (hair?.positions?.isStorageBufferNode !== true || hair.strandCount !== GUIDES) {
    throw new Error("Hair-guides proof requires a HairStrands3D position buffer.");
  }
  if (!(hair.warmupNodes?.length > 0)) {
    throw new Error("Hair-guides proof requires the solver's compute nodes.");
  }
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "hair-guides", async ({ camera, renderer, scene }) => {
    const root = new THREE.Group();
    const head = new THREE.Object3D();
    head.position.set(0, 1.7, 0);
    root.add(head);
    scene.add(root);
    root.updateMatrixWorld(true);
    const skull = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 32, 16),
      new THREE.MeshStandardNodeMaterial({ color: 0xb08a6a, roughness: 0.7 }),
    );
    head.add(skull);

    // Guides start on the back of the skull and fall back and down.
    const guides = new Float32Array(GUIDES * POINTS * 3);
    for (let g = 0; g < GUIDES; g++) {
      const x = ((g + 0.5) / GUIDES - 0.5) * 0.12;
      for (let p = 0; p < POINTS; p++)
        guides.set([x, 1.75 - p * 0.025, -0.11 - p * 0.008], (g * POINTS + p) * 3);
    }
    const hair = new HairStrands3D(guides, {
      pointsPerStrand: POINTS,
      bone: head,
      colliders: [{ bone: head, end: new THREE.Vector3(0, 0.001, 0), radius: 0.1 }],
    });
    scene.add(hair);
    assertHairGuidesProof(hair);

    const point = new Float32Array(GUIDES * POINTS * 2);
    const side = new Float32Array(GUIDES * POINTS * 2);
    const triangles = [];
    for (let i = 0; i < GUIDES * POINTS; i++) {
      point.set([i, i], i * 2);
      side.set([-0.003, 0.003], i * 2);
      if (i % POINTS !== POINTS - 1) triangles.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(point.length * 3), 3));
    geometry.setAttribute("guidePoint", new THREE.BufferAttribute(point, 1));
    geometry.setAttribute("side", new THREE.BufferAttribute(side, 1));
    geometry.setIndex(triangles);
    const source = new THREE.MeshStandardNodeMaterial({
      color: 0x3a2416,
      opacity: 0.7,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    // A strict-mode, three-style copy loop, as threejs-hair-shader's `toNodeMaterial` runs: three
    // hides the getter-only `id`, so the loop must not find it on either host.
    const material = new THREE.MeshStandardNodeMaterial();
    for (const key in source) {
      if (key === "uuid" || key === "type" || key === "userData") continue;
      const value = source[key];
      material[key] = value?.isColor ? value.clone() : value;
    }
    material.positionNode = hair.positions
      .element(attribute("guidePoint", "float").toUint())
      // Through three/webgpu's `TSL` namespace, as a vendored node graph reads TSL.
      .add(THREE.TSL.vec3(attribute("side", "float"), 0, 0));
    // The material's own opacity read back by name, as threejs-hair-shader reads it; the cards stay
    // opaque, so it scales the colour and the capture shows the read.
    // `.discard()` as a node method, as threejs-hair-shader's alpha-to-coverage pass calls it; its
    // condition is never true here, so the frame proves the call and not a cut.
    material.colorNode = THREE.TSL.Fn(() => {
      attribute("side", "float").greaterThan(1).discard();
      return THREE.TSL.materialColor.mul(THREE.TSL.materialReference("opacity", "float"));
    })();
    const cards = new THREE.Mesh(geometry, material);
    cards.frustumCulled = false;
    scene.add(cards);

    const key = new THREE.DirectionalLight(0xfff2e0, 3.2);
    key.position.set(1.2, 2.5, -2.6);
    scene.add(key, key.target, new THREE.AmbientLight(0x8fb8d8, 0.55));

    // A game warms its pipelines before the first frame.
    await renderer.compileAsync(scene, camera);
    // The head walks forward, turns and stops for one second; the hair trails and swings.
    for (let step = 0; step < STEPS; step++) {
      root.position.z = step < 40 ? 0.04 * step : 1.6;
      head.rotation.y = 0.6 * Math.sin(step / 8);
      root.updateMatrixWorld(true);
      hair.process(renderer);
    }
    camera.position.set(-0.35, 1.8, root.position.z - 0.7);
    camera.lookAt(0, 1.6, root.position.z);
    return {
      detail: { guides: GUIDES, pointsPerStrand: POINTS, steps: STEPS, substeps: hair.debug().substeps },
      mesh: cards,
    };
  });
}
