import { Vector2 } from "three";
import { Fn, float, mix, rtt, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import type { Node, NodeBuilder } from "three/webgpu";

/** r185 BloomNode.setup/updateBefore: bright pass, five separable mip blurs, composite.
 * Keep highPassFn authored by the caller. RTT nodes carry the actual pass boundaries.
 */
interface IBloomInput {
  inputNode: Node;
  strength: Node;
  radius: Node;
  threshold: Node;
  smoothWidth: Node;
  _resolutionScale: number;
  highPassFn(inputs: { input: Node; threshold: Node; smoothWidth: Node }): Node;
}
export function bloomGraph(node: IBloomInput): unknown {
  const bright = rtt(
    node.highPassFn({
      input: node.inputNode,
      threshold: node.threshold,
      smoothWidth: node.smoothWidth,
    }),
  );
  bright.setResolutionScale(node._resolutionScale);
  let input = bright;
  const mips = [];
  for (const [mip, radius] of [6, 10, 14, 18, 22].entries()) {
    const sigma = radius / 3;
    const coefficients = Array.from(
      { length: radius },
      (_, i) => (0.39894 * Math.exp((-0.5 * i * i) / (sigma * sigma))) / sigma,
    );
    for (const direction of [vec2(1, 0), vec2(0, 1)]) {
      const source = input;
      const scale = node._resolutionScale / 2 ** mip;
      const shader = Fn(() => {
        // invSize is the destination mip size, including the first downsampled horizontal pass.
        const invSize = vec2(1).div(uniform(new Vector2(1, 1)).setName("postTargetSize"));
        const sum = source.sample(uv()).rgb.mul(coefficients[0]).toVar();
        for (let i = 1; i < radius; i++) {
          const offset = direction.mul(invSize).mul(i);
          sum.addAssign(
            source
              .sample(uv().add(offset))
              .rgb.add(source.sample(uv().sub(offset)).rgb)
              .mul(coefficients[i]),
          );
        }
        return vec4(sum, 1);
      })();
      input = rtt(shader).setResolutionScale(scale);
    }
    mips.push(input);
  }
  return rtt(
    Fn(() => {
      let sum = vec4(0);
      for (const [i, mip] of mips.entries()) {
        const factor = float(1 - i * 0.2);
        sum = sum.add(
          mip.mul(mix(factor, float(1.2).sub(factor), node.radius)).mul(vec4(vec3(1), 1)),
        );
      }
      return sum.mul(node.strength);
    })(),
  ).setResolutionScale(node._resolutionScale);
}

/** Use upstream's RCAS operations directly rather than maintain a second copy of its formula. */
export function sharpenGraph(
  node: { setup(builder: NodeBuilder): unknown; _material: { fragmentNode: Node } },
  builder: NodeBuilder,
): unknown {
  node.setup(builder);
  return rtt(node._material.fragmentNode);
}
