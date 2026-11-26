// Tyre grip on a friction ellipse (reference card carmageddon/tyre-grip-limit).
// A tyre has one grip budget. Cornering and driving share it, so a tyre that is turning hard has
// little left to accelerate with, and the car understeers out of a corner.

/** Grip grows with the square root of the load on the tyre (car.c:2436). */
export const TYRE = {
  /** The local friction coefficient on tarmac. The combined demand below is a half sum. */
  mu: 0.5,
  /** Where a sliding tyre blends toward, so it never becomes frictionless (car.c:2436-2437). */
  slidingMu: 0.6,
  lateralBlendDivisor: 10,
  /** The lateral and longitudinal demands combine into one length: half their sum (car.c:2423). */
  vectorDivisor: 2,
  /** Traction control trims the engine to 1% over the exact limit instead of cutting it (car.c:2450). */
  tractionOvershoot: 1.01,
} as const;

export interface ITyreAxle {
  /** Weight on this axle, in newtons, as the springs carry it. */
  readonly load: number;
  /** The load the axle carries standing still. */
  readonly staticLoad: number;
  /** Sideways speed of the axle over the road, in m/s. */
  readonly lateralSpeed: number;
  /** The sideways force the driver's steering asks for, in newtons. */
  readonly lateralDemand: number;
  /** The drive force the engine asks this axle for, in newtons (0 on the undriven axle). */
  readonly driveDemand: number;
}

export interface ITyreResult {
  /** Grip budget in newtons: coefficient times the square root of load (scaled to static load). */
  readonly budget: number;
  /** 1 when the demand fits. Below 1: the share of the drive force the tyre can pass on. */
  readonly driveScale: number;
  readonly slipping: boolean;
  /** Grip factor to give the physics wheel, 1 at the static load on tarmac. */
  readonly grip: number;
}

export function solveAxle(axle: ITyreAxle): ITyreResult {
  const blend = Math.min(1, Math.abs(axle.lateralSpeed) / TYRE.lateralBlendDivisor);
  const mu = TYRE.mu + (TYRE.slidingMu - TYRE.mu) * blend;
  const loadRatio = Math.max(0.05, axle.load / axle.staticLoad);
  const budget = mu * axle.staticLoad * Math.sqrt(loadRatio);
  const length = (axle.lateralDemand + axle.driveDemand) / TYRE.vectorDivisor;
  const slipping = length > budget;
  // The surplus is lost: the drive force shrinks until the combined length just fits.
  const room = Math.max(0, budget * TYRE.vectorDivisor - axle.lateralDemand);
  const driveScale =
    !slipping || axle.driveDemand <= 0
      ? 1
      : Math.min(1, (room / axle.driveDemand) * TYRE.tractionOvershoot);
  return { budget, driveScale, grip: (mu / TYRE.mu) * Math.sqrt(loadRatio), slipping };
}
