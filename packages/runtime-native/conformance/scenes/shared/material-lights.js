import * as THREE from "three/webgpu";
import { lights } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// NodeMaterial.lightsNode = lights([...]): a material sums only the lights it lists. A camera-parented cockpit lights
// its interior with its own cabin lamp while a strong sun and the ambient light the world keeps stay off it (the
// Starlance friction, 2026-11-05). Left: the world material (sun, ambient and cabin lamp). Right and the panel below
// the view: cabin lamp only. The sun's colour is blue so a leak onto the right knot shows as a hue shift.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "material-lights", ({ scene, camera }) => {
    const sun = new THREE.DirectionalLight(0xa0c0ff, 4);
    sun.position.set(-3, 4, 2);
    const ambient = new THREE.AmbientLight(0x406080, 0.6);
    const cabin = new THREE.PointLight(0xffc070, 6, 6, 2);
    cabin.position.set(0, 0.6, -0.4);
    camera.add(cabin);
    scene.add(sun, ambient, camera);

    const cabinOnly = lights([cabin]);
    const geometry = new THREE.TorusKnotGeometry(0.42, 0.14, 96, 16);
    const world = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardNodeMaterial({ color: 0xd0d0d0, roughness: 0.45 }),
    );
    world.position.x = -0.75;
    const interior = new THREE.MeshStandardNodeMaterial({ color: 0xd0d0d0, roughness: 0.45 });
    interior.lightsNode = cabinOnly;
    const inside = new THREE.Mesh(geometry, interior);
    inside.position.x = 0.75;
    inside.rotation.set(0.3, 0.45, 0);
    world.rotation.copy(inside.rotation);

    // A dashboard panel parented to the camera, as a cockpit is: lit by the cabin lamp, never by the sun.
    const panelMaterial = new THREE.MeshStandardNodeMaterial({ color: 0x808890, roughness: 0.6 });
    panelMaterial.lightsNode = cabinOnly;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.25, 0.6), panelMaterial);
    panel.position.set(0, -0.95, -1.6);
    panel.rotation.x = 0.35;
    camera.add(panel);
    scene.add(world, inside);
    return { world, inside, panel };
  });
}
