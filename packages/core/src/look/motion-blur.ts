import { Fn, Loop, deltaTime, float, int, screenSize, uv, vec2, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

/** The look: Scene.cpp defaults. */
const motionBlurSettings = {
  amount: 0.5,
  /** The longest blur, as a percent of the screen width. */
  maxPercent: 5,
  /** The frame rate whose frame time the blur lasts for. */
  targetFps: 30,
} as const;

/** Taps along the blur: enough to hide the steps at the 5 percent limit on a 1080p frame. */
const SAMPLES = 16;

/** The frame blurred along each pixel's velocity, from the colour and the velocity texture nodes. */
export function motionBlur(colour: TextureNode, velocity: TextureNode): Node<"vec4"> {
  const { amount, maxPercent, targetFps } = motionBlurSettings;
  return Fn(() => {
    const c = uv();
    const v = velocity.sample(c).xy;
    const timeScale = float(1 / targetFps).div(deltaTime.max(1e-4));
    // Normalised device units to pixels: half the frame size per unit, and the screen's y runs down.
    const half = v
      .mul(vec2(1, -1))
      .mul(screenSize)
      .mul(0.5)
      .mul(timeScale.mul(amount * 0.5));
    const limit = screenSize.x.mul(0.5 * (maxPercent / 100));
    const length = half.length();
    const clamped = half.mul(float(1).min(limit.div(length.max(1e-4))));
    const sum = vec4(0).toVar();
    Loop({ start: int(0), end: int(SAMPLES), type: "int" }, ({ i }) => {
      const t = float(i)
        .div(SAMPLES - 1)
        .mul(2)
        .sub(1);
      sum.addAssign(colour.sample(c.add(clamped.mul(t).div(screenSize))).level(float(0)));
    });
    return length.lessThan(0.25).select(colour.sample(c), sum.div(SAMPLES));
  })();
}
