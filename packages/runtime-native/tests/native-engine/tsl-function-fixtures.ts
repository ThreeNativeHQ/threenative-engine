import type { Texture } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { sharpen } from "three/addons/tsl/display/SharpenNode.js";
import { Fn, If, Loop, float, int, rtt, screenUV, texture, vec2, vec4 } from "three/tsl";

export function functionFixtures(source: Texture) {
  return {
    FnNode: () => {
      const gain = Fn(([value, amount]) => {
        const result = value.toVar();
        If(amount.lessThan(0), () => {
          return value.negate();
        });
        Loop({ start: int(1), end: int(4) }, ({ i }) => {
          result.addAssign(float(i).mul(amount));
        });
        return result;
      }).setLayout({
        name: "gain",
        type: "float",
        inputs: [
          { name: "value", type: "float" },
          { name: "amount", type: "float" },
        ],
      });
      const rgb = Fn(([colour]) => colour.mul(0.5)).setLayout({
        name: "rgb",
        type: "vec3",
        inputs: [{ name: "colour", type: "vec3" }],
      });
      return vec4(rgb(vec4(1)), gain(int(3), float(0.5)).add(gain(float(0.25), float(-0.5))));
    },
    // A loop body reads at an explicit mip: under divergent control flow WGSL has no implicit derivatives to pick one.
    TextureLevel: () => {
      const blur = Fn(() => {
        const sum = vec4(0).toVar();
        Loop({ start: int(0), end: int(4) }, ({ i }) => {
          sum.addAssign(texture(source, screenUV.add(vec2(float(i).mul(0.01), 0))).level(float(0)));
        });
        return sum.div(4);
      }).setLayout({ name: "blur", type: "vec4", inputs: [] });
      return blur();
    },
    RTTNode: () => rtt(texture(source).mul(0.5), 64, 32).sample(),
    BloomNode: () => bloom(texture(source), 0.7, 0.4, 0.8),
    SharpenNode: () => sharpen(texture(source), 0.2, true),
  };
}
