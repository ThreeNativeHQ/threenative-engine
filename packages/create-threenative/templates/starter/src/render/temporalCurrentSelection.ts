// Authenticate the ordinary raster/material/motion subset before borrowing raw sample sites.
import { Scene, Vector2 } from "three";
import { output } from "three/tsl";
import type { Node, PassNode, Renderer, TextureNode } from "three/webgpu";
import { currentVisibilityEligible } from "./temporalCurrentVisibility.js";
export interface IRawPass extends PassNode {
  readonly options: { samples?: number };
  getRawTextureNode(name?: string): TextureNode;
}
/** A composed colour, other camera or foreign depth/motion stays on the established provider. */
export function ownsCurrentInput(
  colour: Node,
  depth: TextureNode,
  motion: TextureNode,
  camera: PassNode["camera"],
  source?: PassNode,
): source is PassNode {
  return (
    source !== undefined &&
    source.scene instanceof Scene &&
    Reflect.get(source, "scope") === "color" &&
    source.renderTarget.samples <= 1 &&
    ((source as IRawPass).options.samples ?? 0) <= 1 &&
    source.overrideMaterial === null &&
    source.camera === camera &&
    colour === source.getTextureNode() &&
    depth === source.getTextureNode("depth") &&
    motion === source.getTextureNode("velocity")
  );
}
// Preserve the original fixture's constant-zero MRT control. Arbitrary graphs/uniform producers
// have no authenticated correspondence to the shared motion accessor and use the ordinary lane.
function knownMotion(node: Node | undefined, shared: Node): node is Node<"vec2"> {
  if (node === shared) return true;
  const constant =
    node !== undefined &&
    Reflect.get(node, "isVarNode") === true &&
    Reflect.get(node, "intent") === true &&
    (Reflect.get(node, "_beforeNodes") === null || Reflect.get(node, "_beforeNodes").length === 0)
      ? Reflect.get(node, "node")
      : node;
  return (
    constant !== undefined &&
    Reflect.get(constant, "isConstNode") === true &&
    Reflect.get(constant, "nodeType") === "vec2" &&
    Reflect.get(constant, "value") instanceof Vector2 &&
    Reflect.get(constant, "value").equals(new Vector2())
  );
}

export function currentPassEligible(
  beauty: PassNode,
  renderer: Renderer,
  buffer: Vector2,
  width: number,
  height: number,
  sharedMotion: Node,
) {
  const sourceMotion = beauty.getMRT()?.get("velocity");
  const sourceMRT = beauty.getMRT();
  const ordinaryMRT =
    sourceMRT?.get("output") === output &&
    Object.keys(Reflect.get(sourceMRT, "outputNodes")).every(
      (name) => name === "output" || name === "velocity",
    ) &&
    beauty.renderTarget.textures.length === 2;
  const flow = (
    renderer.contextNode as unknown as { getFlowContextData(): Record<string, unknown> }
  ).getFlowContextData();
  return (
    ordinaryMRT &&
    Object.keys(flow).length === 0 &&
    !Reflect.get(renderer.getOutputRenderTarget() ?? {}, "isXRRenderTarget") &&
    knownMotion(sourceMotion, sharedMotion) &&
    Reflect.get(renderer.backend, "isWebGPUBackend") === true &&
    !renderer.reversedDepthBuffer &&
    !renderer.logarithmicDepthBuffer &&
    renderer.getRenderObjectFunction() === null &&
    Reflect.get(renderer, "_opaqueSort") === null &&
    Reflect.get(beauty, "_viewport") === null &&
    Reflect.get(beauty, "_scissor") === null &&
    width > 2 &&
    height > 2 &&
    width <= buffer.x &&
    height <= buffer.y &&
    (width < buffer.x || height < buffer.y) &&
    currentVisibilityEligible(beauty.scene as Scene)
  );
}
