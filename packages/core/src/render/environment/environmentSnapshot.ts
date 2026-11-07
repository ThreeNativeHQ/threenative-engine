// Generated for you. Borrowed environment provenance for stale-readback rejection.
import {
  EquirectangularReflectionMapping,
  LinearSRGBColorSpace,
  NoColorSpace,
  SRGBColorSpace,
  type Scene,
  type Texture,
} from "three";
/** Provenance stays outside the printable measurement; source/image references are borrowed. */
export interface IEnvironmentSourceSnapshot {
  readonly source: Texture | null;
  readonly intensity: number;
  readonly textureVersion: number | null;
  readonly sourceVersion: number | null;
  readonly colorSpace: string | null;
  readonly mapping: number | null;
  readonly image: unknown;
}
/**
 * The provenance of a scene's environment: which texture, at which intensity, in which colour space.
 *
 * @situation reject an environment readback that belongs to a different sky
 * @example const snapshot = captureEnvironmentSnapshot(scene);
 */
export function captureEnvironmentSnapshot(scene: Scene): IEnvironmentSourceSnapshot {
  const source = scene.environment;
  return {
    source,
    intensity: scene.environmentIntensity,
    textureVersion: source?.version ?? null,
    sourceVersion: source?.source.version ?? null,
    colorSpace: source?.colorSpace ?? null,
    mapping: source?.mapping ?? null,
    image: source?.image ?? null,
  };
}
/**
 * Whether the scene's environment still matches the snapshot a sample was taken from.
 *
 * @situation hold a material's fill light to the sky that is on screen now
 * @example if (environmentSnapshotCurrent(scene, snapshot)) draw(snapshot);
 */
export function environmentSnapshotCurrent(
  scene: Scene,
  snapshot: IEnvironmentSourceSnapshot,
): boolean {
  const source = scene.environment;
  return (
    source === snapshot.source &&
    scene.environmentIntensity === snapshot.intensity &&
    (source?.version ?? null) === snapshot.textureVersion &&
    (source?.source.version ?? null) === snapshot.sourceVersion &&
    (source?.colorSpace ?? null) === snapshot.colorSpace &&
    (source?.mapping ?? null) === snapshot.mapping &&
    (source?.image ?? null) === snapshot.image
  );
}

/**
 * Whether an environment texture's mapping and colour space are qualified for the bounded GPU sample.
 *
 * @situation know why an environment was not sampled on the GPU
 * @example if (samplingSourceSupported(source)) sample(source);
 */
export function samplingSourceSupported(source: NonNullable<Scene["environment"]>): boolean {
  return (
    source.mapping === EquirectangularReflectionMapping &&
    new Set<string>([NoColorSpace, LinearSRGBColorSpace, SRGBColorSpace]).has(source.colorSpace)
  );
}
