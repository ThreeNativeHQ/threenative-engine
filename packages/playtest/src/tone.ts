/** Display-referred Rec.709 luminance, quantized to 256 rounded byte bins. */
export interface IToneMetrics {
  readonly mean: number;
  readonly p1: number;
  readonly p50: number;
  readonly p99: number;
  /** Fraction in bin 255 (display white). */
  readonly clipFraction: number;
  /** Fraction in bin 0 (display black). */
  readonly blackFraction: number;
}

export const TONE_METRICS = ["mean", "p1", "p50", "p99", "clipFraction", "blackFraction"] as const;

/** Top-left coordinates in decoded PNG physical pixels; never CSS pixels. */
export interface IToneRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface IToneComparison {
  readonly region: IToneRegion;
  readonly metric: keyof IToneMetrics;
  readonly minDelta: number;
}

export interface IPlaytestToneObservation extends IToneMetrics {
  readonly code: "TN_TONE";
  readonly label: string;
  /** Absent for the convenience before/after captures. */
  readonly atStep?: string;
}

/** Regional failures carry an error and omit unmeasured metrics. */
export interface IPlaytestRegionalToneObservation extends Partial<IToneMetrics> {
  readonly code: "TN_TONE";
  readonly label: string;
  readonly atStep?: string;
  readonly assertionIndex: number;
  readonly region: IToneRegion;
  readonly reference?: {
    readonly region: IToneRegion;
    readonly metrics?: IToneMetrics;
    readonly error?: string;
  };
  readonly error?: string;
}
export type IPlaytestToneCaptureObservation =
  | IPlaytestToneObservation
  | IPlaytestRegionalToneObservation;
