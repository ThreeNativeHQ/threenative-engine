/** The prebuilt payload a key names, as the release's own lock describes it. */
export interface IPrebuiltRelease {
  key: string;
  url: string;
  sha256?: string;
  size?: number;
  tag?: string;
  version?: string;
}

/**
 * Reads one key out of a local release manifest. A missing manifest, a manifest that omits a
 * required key, or an incomplete entry throws with `PREBUILT_RELEASE_*` on `error.code`.
 */
export function readRelease(
  manifestPath: string,
  key: string,
  options?: { requireComplete?: boolean },
): IPrebuiltRelease;

/** The pinned manifest path, or nothing: an exported empty string means "unset", not the cwd. */
export function pinnedManifestPath(value?: string): string | undefined;

/** Downloads and verifies the native payload a first native build needs, once, under a lock. */
export function ensureNativeBinary(options?: {
  enginePlayer?: boolean;
  arch?: string;
  platform?: string;
  reuse?: boolean;
}): Promise<string>;
