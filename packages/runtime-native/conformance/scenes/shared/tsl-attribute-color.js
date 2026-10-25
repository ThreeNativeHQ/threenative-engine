import { attribute, vec4 } from "three/tsl";
import { THREE, startVisualScene } from "./scene-support.js";

// A colorNode reads the geometry's colour through TSL attribute("color"), with vertexColors off.
export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "tsl-attribute-color", ({ scene }) => {
    const geometry = new THREE.PlaneGeometry(2, 1.2);
    const colors = [];
    for (let i = 0; i < geometry.attributes.position.count; i += 1) colors.push(i % 2, 0.6, 1 - (i % 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec4(attribute("color", "vec3"), 1);
    scene.add(new THREE.Mesh(geometry, material));
  });
}
