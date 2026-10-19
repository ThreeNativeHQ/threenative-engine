// Generated for you. The boot is a look decision: this profile is what a footprint looks like.
// Change the sole, the tread or the rim here; `SnowField` only presses whatever shape it is given.

/** One sample of a contact profile, in the shape `SnowField.stamp` reads. */
interface IPrintSample {
  readonly bank: number;
  readonly coverage: number;
  readonly disturbance: number;
  readonly relief: number;
  readonly shape: number;
}

const NOTHING: IPrintSample = { bank: 0, coverage: 0, disturbance: 0, relief: 0, shape: 0 };

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The sole's area, m². Load over this is the pressure a planted boot puts on the snow. */
export const BOOT_AREA = 0.074;

/**
 * A rounded boot sole — a slightly wider toe than heel — with raised chevrons, a centre groove,
 * and a rim of displaced snow around it. Local z runs heel to toe.
 */
export const bootPrint: {
  readonly extent: number;
  readonly sample: (x: number, z: number) => IPrintSample;
} = {
  extent: 0.48,
  sample: (x, z) => {
    const width = 0.13 + smoothstep(-0.22, 0.15, z) * 0.013;
    const qx = Math.abs(x) - (width - 0.052);
    const qz = Math.abs(z) - (0.255 - 0.052);
    const sdf =
      Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - 0.052;
    if (sdf > 0.105) return NOTHING;
    const tread = Math.max(0, Math.cos(z * 83 + Math.abs(x) * 30)) ** 8;
    const groove = (1 - smoothstep(0.009, 0.023, Math.abs(x))) * 0.004;
    const rim = sdf > 0 ? Math.exp(-(((sdf - 0.027) / 0.027) ** 2)) : 0;
    return {
      bank: rim * (0.78 + 0.22 * Math.sin(x * 94 + z * 63)),
      coverage: 1 - smoothstep(-0.038, 0.008, sdf),
      disturbance: rim * 0.5,
      relief: 0.012 * tread + groove,
      shape: 0.9 + 0.1 * smoothstep(-0.2, 0.15, z),
    };
  },
};
