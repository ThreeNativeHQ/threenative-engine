/**
 * The reference harness's ladder layer: `?tnRef=L<n>` on the reference scene, `?layer=L<n>` (a tier suffix may follow) on
 * a calibration scene; 9 (everything on) when there is none. A calibration scene's frame below L7 holds no gather.
 */
export function harnessLayer(): number {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const layer = /^L(\d)/.exec(params.get("tnRef") ?? params.get("layer") ?? "")?.[1];
  return layer === undefined ? 9 : Number(layer);
}
