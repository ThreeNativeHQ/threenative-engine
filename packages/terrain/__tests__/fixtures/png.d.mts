export type RgbaPixel = readonly [number, number, number, number];
export type RgbPixel = readonly [number, number, number];

export function buildPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => RgbaPixel,
): Uint8Array<ArrayBuffer>;
export function solidPng(width: number, height: number, rgba: RgbaPixel): Uint8Array<ArrayBuffer>;
export function jpegHeader(width: number, height: number): Uint8Array<ArrayBuffer>;
export function webpLossless(width: number, height: number): Uint8Array<ArrayBuffer>;
export function radianceHdr(width: number, height: number): Uint8Array<ArrayBuffer>;
export function openExr(
  width: number,
  height: number,
  compression?: number,
): Uint8Array<ArrayBuffer>;
export function buildHdr(
  width: number,
  height: number,
  pixel: (x: number, y: number) => RgbPixel,
): Uint8Array<ArrayBuffer>;
export function undecodablePng(width: number, height: number): Uint8Array<ArrayBuffer>;
