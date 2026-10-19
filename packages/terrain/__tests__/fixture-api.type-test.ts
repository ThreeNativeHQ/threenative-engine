// Compile-only contracts: loss of a declaration or weakened input types must fail typecheck.
import { buildGlb } from "./fixtures/glb.mjs";
import {
  buildHdr,
  buildPng,
  jpegHeader,
  openExr,
  radianceHdr,
  solidPng,
  undecodablePng,
  webpLossless,
} from "./fixtures/png.mjs";

function fixtureApiTypes() {
  const bytes: Uint8Array<ArrayBuffer>[] = [
    buildGlb(),
    buildGlb({ unit: 0.3048, external: true, nan: false, extras: false }),
    buildPng(2, 1, (x, y) => [x, y, 0, 255]),
    solidPng(2, 1, [0, 0, 0, 255]),
    buildHdr(2, 1, (x, y) => [x, y, 4]),
    jpegHeader(2, 1),
    openExr(2, 1, 3),
    radianceHdr(2, 1),
    undecodablePng(2, 1),
    webpLossless(2, 1),
  ];
  // @ts-expect-error Model units must be numeric.
  buildGlb({ unit: "feet" });
  // @ts-expect-error Undeclared model options must be rejected.
  buildGlb({ unsupported: true });
  // @ts-expect-error Image dimensions must be numeric.
  buildPng("2", 1, () => [0, 0, 0, 255]);
  // @ts-expect-error PNG pixels require four RGBA channels.
  buildPng(2, 1, () => [0, 0, 0]);
  // @ts-expect-error HDR pixels require three RGB channels.
  buildHdr(2, 1, () => [0, 0, 0, 255]);
  // @ts-expect-error PNG channels must be numeric.
  solidPng(2, 1, ["red", 0, 0, 255]);
  // @ts-expect-error EXR compression is a numeric header value.
  openExr(2, 1, false);
  return bytes;
}
void fixtureApiTypes;
