import type { RenderTarget } from "three";
import { type NodeMaterial, QuadMesh, type Renderer } from "three/webgpu";

// PRD-828: one QuadMesh per pass material, made on first use. Reassigning QuadMesh.material each
// pass is an engine crossing on the owned engine; a material dropped by its pass frees its quad.
const quads = new WeakMap<NodeMaterial, QuadMesh>();

/** Draws one full-screen pass of `material` into `target`. */
export function drawQuadPass(
  renderer: Renderer,
  material: NodeMaterial,
  target: RenderTarget | null,
): void {
  let quad = quads.get(material);
  if (quad === undefined) {
    quad = new QuadMesh(material);
    quads.set(material, quad);
  }
  renderer.setRenderTarget(target);
  quad.render(renderer);
}
