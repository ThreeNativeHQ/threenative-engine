export function compareCaptures(
  referenceContents: Uint8Array,
  candidateContents: Uint8Array,
  /** Channel levels a pixel may differ by and still match (default 0). */
  levels?: number,
): {
  readonly height: number;
  readonly perceptualDeltaE: number;
  readonly pixelMismatchRatio: number;
  readonly width: number;
};

export function inspectCapture(contents: Uint8Array): {
  readonly height: number;
  readonly png: { readonly data: Uint8Array };
  readonly uniform: false;
  readonly width: number;
};
