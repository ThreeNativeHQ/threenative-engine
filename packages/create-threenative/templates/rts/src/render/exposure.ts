// Generated for you: these controls are the game's exposure policy. Edit freely.
// Core owns exposureMeter, adaptation, validation and readback.

export interface IExposureSettings {
  enabled: boolean;
  /** Middle-grey target; increase to brighten the metered subject. */
  key: number;
  /** Exposure limits in stops. Expand only if the scene needs more range. */
  minStops: number;
  maxStops: number;
  /**
   * Percent of metered weight, dark to bright, ignored at each end of the histogram.
   * Raise highPercent's gap (lower it) when a large bright backdrop still sets the exposure.
   */
  lowPercent: number;
  highPercent: number;
  /** Exponential response per second in log2 space. Up opens the eye; down squints. */
  rateUp: number;
  rateDown: number;
  /** Stop error where cut acceleration begins / reaches its authored maximum. */
  snapLo: number;
  snapHi: number;
  snapGain: number;
  /** Seed for known cuts. reset() without a value adopts the next measured target. */
  initialExposure: number;
  settleStops: number;
  /** Limit catch-up after a suspended frame, avoiding an unrequested cut. */
  maxDelta: number;
  /** Readback/marker cadence in seconds. Metering still runs on every drawn frame. */
  reportInterval: number;
}

export const exposureSettings: Readonly<IExposureSettings> = {
  enabled: true, // Authored meter policy under the core filmic curve.
  key: 0.18,
  minStops: -12,
  maxStops: 12,
  lowPercent: 10,
  highPercent: 90,
  rateUp: 2,
  rateDown: 4,
  snapLo: 3,
  snapHi: 8,
  snapGain: 1,
  initialExposure: 1,
  settleStops: 0.25,
  maxDelta: 0.1,
  reportInterval: 0.5,
};
