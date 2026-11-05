import * as THREE from "three/webgpu";
import { color, float } from "three/tsl";
import { startVisualScene } from "./scene-support.js";

// three's CustomBlending (separate colour and alpha state), premultipliedAlpha and the two blend modes that need it
// (Subtractive, Multiply): six translucent quads over one backdrop, each a blend state of its own (PRD-777).
const QUADS = [
  // dst - 0.6 src stays positive over the backdrop (a negative result is undefined in a float target); the alpha
  // state keeps the frame's alpha at 1, since the page composites a translucent canvas over its own background.
  {
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.ReverseSubtractEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    blendEquationAlpha: THREE.AddEquation,
  },
  {
    blending: THREE.CustomBlending,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  },
  { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, blendEquationAlpha: THREE.AddEquation },
  { blending: THREE.NormalBlending, premultipliedAlpha: true },
  { blending: THREE.SubtractiveBlending, premultipliedAlpha: true },
  { blending: THREE.MultiplyBlending, premultipliedAlpha: true },
];
const COLOURS = [0x302010, 0x40c0ff, 0x80ff60, 0xff40c0, 0x6060ff, 0xffe070];

export async function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "material-custom-blending", ({ scene }) => {
    const backdrop = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 2.4),
      new THREE.MeshBasicNodeMaterial({ colorNode: color(0x8a6f3a) }),
    );
    backdrop.position.z = -0.2;
    scene.add(backdrop);
    QUADS.forEach((state, i) => {
      // WebGPU takes Min/Max equations with One factors only, so the MaxEquation quad uses those.
      const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, ...state });
      material.colorNode = color(COLOURS[i]);
      material.opacityNode = float(0.6);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.85), material);
      quad.position.set(-1.15 + (i % 3) * 1.15, i < 3 ? 0.5 : -0.5, 0);
      scene.add(quad);
    });
    return { detail: { quads: QUADS.length } };
  }, { background: 0x203040 });
}
