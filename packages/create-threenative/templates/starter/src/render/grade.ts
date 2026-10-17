// Generated for you: ordinary Three.js; ThreeNative does not read this file.
//
// The last two stages of this game's frame: a colour grade, and the film grain over it. Both are
// *authored* stages — `postprocessing.ts` hands their factories to `WorldEnvironment`, which owns
// the order, the tier and the report, so `TN_RENDER_CHAIN` names each one as applied or refused
// with a reason instead of this file guessing whether it ran.
//
// The table in `public/grade.cube` is this game's, written by `tools/make-grade-lut.mjs`. Replace
// that one file with any `.cube` from any grading tool and nothing else here changes. `quality.ts`
// owns how strong the grade is, how much grain there is, and which tier runs each.
//
// **Why `afterOutputTransform`.** A `.cube` table is authored against the picture a person sees:
// sRGB, tone-mapped, 0–1. This stage therefore reads the frame *after* the output transform and
// asks the chain to install the graph with the renderer's automatic transform switched off — the
// same arrangement three's own FXAA example uses. `renderOutput` below is the pipeline's own
// tone curve and encode, applied once and by hand, so the frame keeps exactly one output
// transform whether this stage runs or not.
//
// The alternative, mapping scene-referred light onto the table's domain and back, was measured and
// dropped: an 8-bit table quantises in 1/255 steps, and no bijection of the two-parameter family
// recovered the frame to within one 8-bit step per channel — the best of them cost 2.0, and
// `(x/W)^g / (1 + (x/W)^g)` with `W = 4, g = 1/2.2` cost 4.3. `__tests__/grade.spec.ts` holds the
// arithmetic; the value of the transform's own seat is that an identity table there is under one
// step by construction rather than by a fitted curve.
import { type Data3DTexture, DataUtils, FloatType, HalfFloatType } from "three";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { lut3D } from "three/addons/tsl/display/Lut3DNode.js";
import { float, renderOutput, texture3D, time, uv } from "three/tsl";
import type { Node } from "three/webgpu";
import type { QualityTier } from "./quality.js";
import type { ChainStage } from "./worldEnvironment.js";

/**
 * What `TN_RENDER_CHAIN` prints when a stage is refused. Never blank, and never the same answer
 * twice: a stage that quietly ran at zero strength looks exactly like one this game turned on.
 * Module-local because the report is the contract, not the binding: a scenario reads these strings
 * out of the marker, and `__tests__/grade.spec.ts` pins them as literals for that reason.
 */
const GRADE_REASONS = {
  gradeOff: "gradeIntensity:0",
  grainOff: "grainIntensity:0",
  lutPending: "lut:pending",
} as const;

/** What this game's tiers decide about its grade. `quality.ts` is the only writer. */
export interface IGradeSettings {
  /** How far the table's colour is mixed over the frame. Zero refuses the stage. */
  readonly gradeIntensity: number;
  /** Whether the grain moves. A still frame gets the still pattern instead. */
  readonly grainAnimated: boolean;
  /** How much grain. Zero refuses the stage. */
  readonly grainIntensity: number;
  /** The tier these numbers were chosen for; reported with the decision. */
  readonly tier: QualityTier;
}

/** The loaded table: the parsed `.cube` as a filterable texture, and the size `lut3D` has to be told. */
export interface IGradeTable {
  readonly size: number;
  readonly texture: Data3DTexture;
}

/**
 * The table `LUTCubeLoader` parsed as `FloatType`, uploaded as half floats so the GPU can filter it.
 *
 * The float parse keeps the file's own numbers. But three's WGSL builder samples a float32 3D
 * texture without filtering unless the device has the optional `float32-filterable` feature. Then
 * every lookup reads one of the nine cells, and the frame posterises. Half floats filter on every
 * device and hold each number from 0 to 1 within a quarter of an 8-bit step. Any other input throws,
 * because converting its bytes would build a wrong table.
 */
export function filterableTable(texture: Data3DTexture): Data3DTexture {
  const { data } = texture.image;
  if (texture.type !== FloatType || !(data instanceof Float32Array))
    throw new Error(
      `grade table must be a Float32Array parsed with setType(FloatType); got type ${texture.type}, ${data?.constructor.name}.`,
    );
  texture.image.data = Uint16Array.from(data, (value) => DataUtils.toHalfFloat(value));
  texture.type = HalfFloatType;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Whether one authored stage runs, or the reason it does not.
 *
 * An intensity of zero refuses rather than running at zero, so a tier that turned the look off is
 * reported as off instead of reading as applied. `tableLoaded` is the grade's own: until the file
 * has arrived there is nothing to look up, and the frame is better ungraded than wrongly graded.
 *
 * Module-local because the stages are the surface: what a scenario reads is what the chain asked
 * each stage, so `__tests__/grade.spec.ts` calls `available()` on the returned stages rather than
 * this function.
 */
function refusal(
  name: "grade" | "grain",
  settings: IGradeSettings,
  tableLoaded: boolean,
): true | string {
  if (name === "grain") return settings.grainIntensity > 0 ? true : GRADE_REASONS.grainOff;
  if (!(settings.gradeIntensity > 0)) return GRADE_REASONS.gradeOff;
  return tableLoaded ? true : GRADE_REASONS.lutPending;
}

/**
 * The two stages, in order.
 *
 * `grade` takes the output transform's seat and is last by construction; `grain` is anchored after
 * it, so the grain sits over the graded picture — which is where a grain belongs, since a noise
 * added before the tone curve is crushed in the shadows and blown out in the highlights.
 */
export function gradeStages(
  settings: IGradeSettings,
  table: IGradeTable | undefined,
): readonly ChainStage[] {
  const loaded = table !== undefined;
  return [
    {
      name: "grade",
      supportsResolutionSubrect: true,
      afterOutputTransform: true,
      available: () => refusal("grade", settings, loaded),
      build: (input) => {
        if (table === undefined)
          throw new Error(
            "grade built before its table loaded; available() should have refused it.",
          );
        // The pipeline's own transform, applied here because `afterOutputTransform` took it away
        // from the renderer. Same tone curve, same encode, same exposure — applied once.
        const display = renderOutput(input as Node<"vec4">);
        const graded = lut3D(
          display,
          texture3D(table.texture),
          table.size,
          float(settings.gradeIntensity),
        );
        // The addon's declaration types its own return as the raw node class, which omits the
        // element API the proxied object carries at runtime. An assertion and nothing else, the
        // same one `worldEnvironment.ts` makes for the denoise node: no node is added here.
        return graded as unknown as Node<"vec4">;
      },
    },
    {
      name: "grain",
      supportsResolutionSubrect: true,
      after: "grade",
      available: () => refusal("grain", settings, loaded),
      build: (input) =>
        film(
          input as Node<"vec4">,
          float(settings.grainIntensity),
          // `film()` adds the clock to whatever uv it is handed, so a still grain hands it back.
          settings.grainAnimated ? undefined : uv().sub(time),
        ),
    },
  ];
}
