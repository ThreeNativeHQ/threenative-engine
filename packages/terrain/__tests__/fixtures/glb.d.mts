export interface IGlbFixtureOptions {
  /** Metres per model unit before node scale. */
  readonly unit?: number;
  readonly external?: boolean;
  readonly nan?: boolean;
  readonly extras?: boolean;
}

export function buildGlb(options?: IGlbFixtureOptions): Uint8Array<ArrayBuffer>;
