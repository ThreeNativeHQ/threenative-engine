// How a changed light reaches the bounce light over frames (PRD-641 AC-2). The rule is Unreal's; the game's cache
// only has to say how many frames each stage takes. Three stages in series, all from UE 5.8.3:
//  1. The surface cache refreshes `1 / r.LumenScene.DirectLighting.UpdateFactor` of its atlas texels a frame, and at
//     least one physical page (`Engine/Source/Runtime/Renderer/Private/Lumen/LumenSceneLighting.cpp:98-125`). A scene
//     whose cards fill a small share of the atlas refreshes all of them in a frame or two.
//  2. The radiosity of a texel blends its history over `r.LumenScene.Radiosity.Temporal.MaxFramesAccumulated` updates
//     (`LumenRadiosity.cpp:145`). It carries the second bounce and later ones.
//  3. The screen probe gather blends each pixel's history by `1 / (1 + framesAccumulated)`, at most
//     `r.Lumen.ScreenProbeGather.Temporal.MaxFramesAccumulated` frames (`LumenScreenProbeGather.cpp:229`,
//     `Engine/Shaders/Private/Lumen/LumenScreenProbeGatherTemporal.usf:486-522`). It carries every bounce.

/** The texels per metre a card gets at most: `r.LumenScene.SurfaceCache.CardMaxTexelDensity` 0.2 per cm (`LumenSceneRendering.cpp:149`). */
const CARD_TEXELS_PER_METRE = 20;
/** The smallest update: one physical page of 128 x 128 texels (`Lumen.h:45`, `LumenSceneLighting.cpp:116`). */
const PAGE_TEXELS = 128 * 128;

export interface ILightResponse {
  /** `r.LumenScene.DirectLighting.UpdateFactor`. */
  readonly updateFactor: number;
  /** `r.LumenScene.Radiosity.UpdateFactor`. */
  readonly radiosityUpdateFactor: number;
  /** `r.LumenScene.Radiosity.Temporal.MaxFramesAccumulated`; 0 has no radiosity history. */
  readonly radiosityFramesAccumulated: number;
  /** `r.Lumen.ScreenProbeGather.Temporal.MaxFramesAccumulated`; 0 has no pixel history. */
  readonly framesAccumulated: number;
  /** `r.LumenScene.SurfaceCache.AtlasSize`. */
  readonly atlasSize: number;
}

/** What a stage needs: a count of 1 or more. */
function positive(value: number, name: string): void {
  if (!(value >= 1))
    throw new RangeError(`TN_GI_LIGHT_RESPONSE: ${name} needs 1 or more, got ${value}`);
}

export function checkLightResponse(response: ILightResponse): void {
  positive(response.updateFactor, "updateFactor");
  positive(response.radiosityUpdateFactor, "radiosityUpdateFactor");
  positive(response.atlasSize, "atlasSize");
  for (const [name, v] of [
    ["framesAccumulated", response.framesAccumulated],
    ["radiosityFramesAccumulated", response.radiosityFramesAccumulated],
  ] as const)
    if (!(v >= 0)) throw new RangeError(`TN_GI_LIGHT_RESPONSE: ${name} needs 0 or more, got ${v}`);
}

/**
 * Frames a stage of the surface cache needs to visit every texel its cards own: the cards' texels over the texels one
 * frame may update (`atlasSize^2 / factor`, never under one page).
 */
export function surfaceCacheCycle(areaMetres2: number, factor: number, atlasSize: number): number {
  const texels = areaMetres2 * CARD_TEXELS_PER_METRE ** 2;
  const perFrame = Math.max(PAGE_TEXELS, atlasSize ** 2 / factor);
  return Math.max(1, Math.ceil(texels / perFrame));
}

/**
 * One light's response to a change of its colour times intensity, as a scale per channel (1 = the baked light). Call
 * `set` when the light changes and `step` once per rendered frame.
 *
 * The bounce light of order `k` (the light after `k` bounces) shows a scale of its own. The first bounce reads the
 * surface cache's direct lighting. Each later bounce reads the radiosity of the one before, so it lags one radiosity
 * history more. The gather's pixel history then lags all of them alike.
 */
export class LightFade {
  private readonly cycle: number;
  private readonly radiosityRate: number;
  private readonly pixelRate: number;
  private readonly latched: number[][];
  private target = [1, 1, 1];
  private frame = 0;
  /** `radiosity[j]` is the direct lighting after `j + 1` radiosity histories, per channel. */
  private readonly radiosity: number[][];
  /** Per order, per channel: what the pixel history shows. */
  private readonly shown: number[][];

  constructor(
    response: ILightResponse,
    /** The area of the surfaces that own cards, in square metres. */
    areaMetres2: number,
    /** The bounces the cache keeps: the number of orders it shows. */
    readonly orders = 1,
  ) {
    checkLightResponse(response);
    if (!(orders >= 1) || !Number.isInteger(orders))
      throw new RangeError(
        `TN_GI_LIGHT_RESPONSE: orders needs a whole number of 1 or more, got ${orders}`,
      );
    this.cycle = surfaceCacheCycle(areaMetres2, response.updateFactor, response.atlasSize);
    const radiosityCycle = surfaceCacheCycle(
      areaMetres2,
      response.radiosityUpdateFactor,
      response.atlasSize,
    );
    // A texel updates once a cycle and blends `1 / (1 + n)` of the new light then, so it moves `1 / ((1 + n) * cycle)` a frame.
    this.radiosityRate = 1 / ((1 + response.radiosityFramesAccumulated) * radiosityCycle);
    this.pixelRate = 1 / (1 + response.framesAccumulated);
    this.latched = Array.from({ length: this.cycle }, () => [1, 1, 1]);
    this.radiosity = Array.from({ length: orders - 1 }, () => [1, 1, 1]);
    this.shown = Array.from({ length: orders }, () => [1, 1, 1]);
  }

  /** Frames the surface cache needs to refresh every texel. */
  get refreshFrames(): number {
    return this.cycle;
  }

  set(scale: readonly number[]): void {
    this.target = [...scale];
  }

  /** The scale each order shows after one more frame. */
  step(): readonly (readonly number[])[] {
    this.frame += 1;
    this.latched[this.frame % this.cycle] = [...this.target];
    for (let c = 0; c < 3; c += 1) {
      const move = (from: number, to: number, rate: number): number => from + (to - from) * rate;
      const direct = this.latched.reduce((sum, phase) => sum + (phase[c] ?? 1), 0) / this.cycle;
      let feed = direct;
      for (const stage of this.radiosity) {
        stage[c] = move(stage[c] ?? 1, feed, this.radiosityRate);
        feed = stage[c] as number;
      }
      for (let k = 0; k < this.shown.length; k += 1) {
        const order = this.shown[k] as number[];
        const reads = k === 0 ? direct : (this.radiosity[k - 1]?.[c] ?? direct);
        order[c] = move(order[c] ?? 1, reads, this.pixelRate);
      }
    }
    return this.shown;
  }

  /** Every stage shows the scale the light has now (a 1e-3 gap is under a half-float step). */
  get settled(): boolean {
    return this.target.every(
      (t, c) =>
        [...this.shown, ...this.radiosity].every((s) => Math.abs((s[c] ?? 1) - t) < 1e-3) &&
        this.latched.every((phase) => phase[c] === t),
    );
  }
}
