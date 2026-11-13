import * as THREE from "three/webgpu";
import {
  color,
  convertToTexture,
  mrt,
  normalView,
  output,
  pass,
  rtt,
  vec3,
  vec4,
} from "three/tsl";
import { ScreenProbeGather, ShortRangeAO, TracedReflections } from "@threenative/core";
import { startVisualScene } from "./scene-support.js";

// PRD-640: the screen-probe gather reads bounce light through probes instead of per-pixel rays, a ray that leaves the
// screen walks the scene's triangles to the radiance cache, and short-range AO darkens the contact that the gathered
// light cannot resolve. A room with a red, a green and a white wall, one box on the floor and a ceiling emitter: the
// walls' colour bleeds onto the box and the floor only if the gather answers, and the box's foot darkens only if the
// horizon search does.
//
// Both lanes run the same TSL program through `@threenative/core` (`--engine threenative`), which is exactly what this
// row compares: the Wasm engine in Chromium against the native engine player. Upstream three has neither the probes nor
// the engine's chain vocabulary, so the three.js lane renders the room without the gather.
export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "screen-probe-gather", ({ renderer, scene, camera }) => {
    const owned = renderer.info.engine !== undefined;
    camera.position.set(0, 1.15, 3.4);
    camera.lookAt(0, 0.55, -0.4);
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a2622, 1.2));
    const sun = new THREE.DirectionalLight(0xfff2e0, 2.4);
    sun.position.set(-1.4, 2.2, 1.6);
    scene.add(sun);
    const surface = (hex, roughness = 0.85) =>
      new THREE.MeshStandardNodeMaterial({ color: hex, roughness });
    const add = (mesh, x, y, z, rotationY = 0) => {
      mesh.position.set(x, y, z);
      mesh.rotation.y = rotationY;
      scene.add(mesh);
      return mesh;
    };
    add(new THREE.Mesh(new THREE.PlaneGeometry(6, 6), surface(0xb9b2a6)), 0, 0, 0).rotation.x =
      -Math.PI / 2;
    add(new THREE.Mesh(new THREE.PlaneGeometry(6, 3), surface(0xe6e2d8)), 0, 1.5, -1.6);
    add(new THREE.Mesh(new THREE.PlaneGeometry(6, 3), surface(0xd8503c)), -1.6, 1.5, 0, Math.PI / 2);
    add(new THREE.Mesh(new THREE.PlaneGeometry(6, 3), surface(0x4f9e4a)), 1.6, 1.5, 0, -Math.PI / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), surface(0xcfc7b8, 0.8)), 0.35, 0.4, -0.35);
    const glow = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
    glow.emissiveNode = color(0xffffff).mul(1.6);
    add(new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.5), glow), 0, 2.92, -0.5).rotation.x =
      Math.PI / 2;

    const scenePass = pass(scene, camera);
    scenePass.setMRT(mrt({ output, normal: normalView }));
    const pipeline = new THREE.RenderPipeline(renderer);
    const base = convertToTexture(scenePass.getTextureNode("output"));
    if (!owned) {
      pipeline.outputNode = rtt(vec4(base.rgb, 1));
      return { detail: { screenProbeGather: false }, render: () => pipeline.render() };
    }
    const trace = new TracedReflections(scene, { marker: false });
    const gather = new ScreenProbeGather({
      camera,
      viewport: { width: dimensions.width, height: dimensions.height },
      downsampleFactor: 16,
      tracingOctahedronResolution: 4,
      // A stand-in radiance cache: this row compares two engines running the same program, not two looks. A ray that
      // leaves the screen reads it where its walk through the room ended.
      radiance: () => vec3(0.22, 0.24, 0.3),
      trace,
      marker: false,
    });
    const gi = gather.gather(
      base,
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("normal"),
    );
    const shortRange = new ShortRangeAO({
      camera,
      viewport: { width: dimensions.width, height: dimensions.height },
      marker: false,
    });
    const contact = shortRange.occlusion(
      scenePass.getTextureNode("depth"),
      scenePass.getTextureNode("normal"),
    );
    // The gathered light through the surface's own colour, then the contact occlusion over the indirect part only.
    const indirect = gi.rgb.mul(vec3(0.7)).mul(contact.a);
    pipeline.outputNode = rtt(vec4(base.rgb.add(indirect), 1));
    return {
      detail: {
        screenProbeGather: gather.report,
        shortRangeAO: shortRange.report,
        traced: trace.report.triangles,
      },
      render: () => pipeline.render(),
    };
  });
}
