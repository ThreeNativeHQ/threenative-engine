import * as THREE from "three/webgpu";
import { Discard, Fn, float, int, ivec2, textureLoad, uniform, uv, vec3, vec4 } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// The TSL the Ultra Elements spell port needs (PRD-777): Discard(condition), a Matrix3 and a
// Matrix4 uniform, textureLoad on a DataTexture itself, and a plain object of nodes as a Fn argument.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "tsl-spell-port-nodes", ({ scene }) => {
    // Four texels: red, green, blue, white; textureLoad picks one per quarter of the plane.
    const texels = new THREE.DataTexture(
      new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
      2,
      2,
    );
    texels.needsUpdate = true;
    // A mat3 that swaps red and blue, and a mat4 that scales by 0.75: both read every fragment.
    const swap = new THREE.Matrix3().set(0, 0, 1, 0, 1, 0, 1, 0, 0);
    const swapNode = uniform(swap);
    const scaleNode = uniform(new THREE.Matrix4().makeScale(0.75, 0.75, 0.75));
    const tint = Fn(([light, base]) => base.mul(light.colour).mul(light.gain));
    const shade = Fn(() => {
      const p = uv();
      // a hole in the middle, and a cut-off left strip
      Discard(p.sub(0.5).length().lessThan(0.12));
      const texel = textureLoad(texels, ivec2(int(p.x.mul(2)), int(p.y.mul(2))), int(0)).rgb;
      const swapped = swapNode.mul(texel);
      const scaled = scaleNode.mul(vec4(swapped, 1)).xyz;
      const lit = tint({ colour: vec3(1, 0.9, 0.8), gain: float(1.1) }, scaled);
      return vec4(lit, 1);
    });
    // Upstream three writes a bare Discard() as `discard;` with the return after it, which naga
    // (wgpu-native: the Android lane) refuses. A condition that holds on every fragment cuts the same
    // plate on every lane; the owned engine's bare Discard() is proven by the discard_ends ctest.
    const cut = Fn(() => {
      Discard(uv().x.greaterThanEqual(0));
      return vec4(1, 0, 1, 1);
    });
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = shade();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), material);
    scene.add(plane);
    // Discard on every fragment: this whole magenta plate is cut, so nothing of it reaches the frame.
    const hidden = new THREE.MeshBasicNodeMaterial();
    hidden.colorNode = cut();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8), hidden);
    plate.position.set(1.2, 0.6, 0.2);
    scene.add(plate);
    return { detail: { discard: true, matrixUniforms: 2, textureLoad: true } };
  });
}
