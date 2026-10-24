import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { uv, vec4 } from "three/tsl";
import { startRealismEffectsScene } from "./realism-effects-scene.js";

export function startScene(canvas, dimensions) {
  return startRealismEffectsScene(canvas, dimensions, "SSGIEffect", ({ color, depth, normal, camera }) => {
    const node = ssgi(color, depth, normal, camera);
    // Both independent render targets must reach the image: GI on the left, scalar AO on the right.
    return { node, outputNode: uv().x.lessThan(0.5).select(vec4(node.getGINode().rgb, 1), vec4(node.getAONode().rrr, 1)) };
  }, { velocityNode: vec4(0) });
}
