/**
 * three's `DataUtils` (r185, MIT): binary16 conversion as plain JS, shared by both engine back ends.
 *
 * It touches no engine object, so it runs as JS instead of crossing the ABI once per value; a ripple
 * field packs 147,456 values per update. The tables are three's, so every result is bit-identical,
 * including its truncation (not rounding) to binary16 and its clamp to ±65504.
 */

const floatView = new Float32Array(1);
const uint32View = new Uint32Array(floatView.buffer);
const baseTable = new Uint32Array(512);
const shiftTable = new Uint32Array(512);
const mantissaTable = new Uint32Array(2048);
const exponentTable = new Uint32Array(64);
const offsetTable = new Uint32Array(64);

for (let i = 0; i < 256; ++i) {
  const e = i - 127;
  let base: number;
  let shift: number;
  if (e < -27) [base, shift] = [0x0000, 24];
  else if (e < -14) [base, shift] = [0x0400 >> (-e - 14), -e - 1];
  else if (e <= 15) [base, shift] = [(e + 15) << 10, 13];
  else [base, shift] = [0x7c00, e < 128 ? 24 : 13];
  baseTable[i] = base;
  baseTable[i | 0x100] = base | 0x8000;
  shiftTable[i] = shiftTable[i | 0x100] = shift;
}
for (let i = 1; i < 1024; ++i) {
  let m = i << 13;
  let e = 0;
  while ((m & 0x00800000) === 0) {
    m <<= 1;
    e -= 0x00800000;
  }
  mantissaTable[i] = (m & ~0x00800000) | (e + 0x38800000);
}
for (let i = 1024; i < 2048; ++i) mantissaTable[i] = 0x38000000 + ((i - 1024) << 13);
for (let i = 1; i < 31; ++i) exponentTable[i] = i << 23;
exponentTable[31] = 0x47800000;
exponentTable[32] = 0x80000000;
for (let i = 33; i < 63; ++i) exponentTable[i] = 0x80000000 + ((i - 32) << 23);
exponentTable[63] = 0xc7800000;
for (let i = 1; i < 64; ++i) if (i !== 32) offsetTable[i] = 1024;

/** A number's binary16 bits, as three stores them in a `HalfFloatType` Uint16Array. */
export function toHalfFloat(value: number): number {
  floatView[0] = Math.max(-65504, Math.min(65504, value));
  const f = uint32View[0] ?? 0;
  const e = (f >> 23) & 0x1ff;
  return (baseTable[e] ?? 0) + ((f & 0x007fffff) >> (shiftTable[e] ?? 0));
}

/** The number binary16 `bits` encode. */
export function fromHalfFloat(bits: number): number {
  const m = bits >> 10;
  uint32View[0] =
    (mantissaTable[(offsetTable[m] ?? 0) + (bits & 0x3ff)] ?? 0) + (exponentTable[m] ?? 0);
  return floatView[0] ?? 0;
}

/** three's static `DataUtils` namespace. */
export const DataUtils = { toHalfFloat, fromHalfFloat } as const;
