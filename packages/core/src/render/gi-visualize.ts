import { vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * What a visualize mode shows. `off` is the finished frame; `indirectDiffuse` is the bounce light alone, the
 * counterpart of Unreal's `r.Lumen.Visualize.IndirectDiffuse`. Other GI work adds its modes here when its data exists.
 */
export const GI_VISUALIZE_MODES = ["off", "indirectDiffuse"] as const;

export type GIVisualizeMode = (typeof GI_VISUALIZE_MODES)[number];

export interface IGIVisualizeOptions {
  readonly mode: GIVisualizeMode;
  /** The finished frame, returned unchanged in `off` mode. */
  readonly beauty: Node<"vec4">;
  /**
   * The indirect diffuse light as the surface returns it: the gathered and cached light times the surface's own
   * albedo, in the frame's exposure. The game's chain builds it, because it owns what the chain gathers.
   */
  readonly indirectDiffuse?: Node<"vec3">;
}

/**
 * Shows one lighting term of a frame by itself, so a lighting difference against a reference can be told apart from a
 * scene difference. The game builds each term in its own chain and picks the mode; this class only selects, and it
 * fails when the chain did not build the term the mode needs, so a frame never claims to show a term it does not hold.
 */
export class GIVisualize {
  readonly mode: GIVisualizeMode;
  /** The node to output: `beauty` for `off`, the chosen term with an opaque alpha otherwise. */
  readonly node: Node<"vec4">;

  constructor(options: IGIVisualizeOptions) {
    if (!GI_VISUALIZE_MODES.includes(options.mode))
      throw new Error(
        `TN_GI_VISUALIZE_MODE: '${String(options.mode)}'. Use one of: ${GI_VISUALIZE_MODES.join(", ")}.`,
      );
    this.mode = options.mode;
    if (options.mode === "off") {
      this.node = options.beauty;
      return;
    }
    if (options.indirectDiffuse === undefined)
      throw new Error(
        "TN_GI_VISUALIZE_TERM: mode 'indirectDiffuse' needs the chain's indirectDiffuse node.",
      );
    this.node = vec4(options.indirectDiffuse, 1);
  }
}
