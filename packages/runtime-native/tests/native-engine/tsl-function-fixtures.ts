import type { Texture } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { sharpen } from "three/addons/tsl/display/SharpenNode.js";
import { Fn, If, Loop, float, int, rtt, texture, vec4 } from "three/tsl";

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
    RTTNode: () => rtt(texture(source).mul(0.5), 64, 32).sample(),
    BloomNode: () => bloom(texture(source), 0.7, 0.4, 0.8),
    SharpenNode: () => sharpen(texture(source), 0.2, true),
  };
}
