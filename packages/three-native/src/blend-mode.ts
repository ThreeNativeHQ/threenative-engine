/**
 * three/webgpu's `BlendMode`: the per-output blending record `mrt(...).setBlendMode(name, mode)` takes
 * (renderers/common/BlendMode.js, r185). The engine's scene pass keeps the material's own blending on
 * every target (pass-node.ts), so this is data only, with three's defaults and its `copy`/`clone`.
 */
const NORMAL_BLENDING = 1;
const ADD_EQUATION = 100;
const SRC_ALPHA_FACTOR = 204;
const ONE_MINUS_SRC_ALPHA_FACTOR = 205;

export class BlendMode {
  blending: number;
  blendSrc = SRC_ALPHA_FACTOR;
  blendDst = ONE_MINUS_SRC_ALPHA_FACTOR;
  blendEquation = ADD_EQUATION;
  blendSrcAlpha: number | null = null;
  blendDstAlpha: number | null = null;
  blendEquationAlpha: number | null = null;
  premultiplyAlpha = false;

  constructor(blending = NORMAL_BLENDING) {
    this.blending = blending;
  }

  copy(source: BlendMode): this {
    Object.assign(this, source);
    return this;
  }

  clone(): BlendMode {
    return new BlendMode().copy(this);
  }
}
