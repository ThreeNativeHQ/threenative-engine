// The prop half of the bake: the game's streamed worlds, compiled once and written as containers.
//
// `@threenative/terrain` owns the compile (`compilePropBuckets`) and the container layout; the game
// owns the policy that decides which streamed world a placement joins and how far it draws
// (`streamedBucket`, `streamedReach`), and the authored pose the record stores
// (`withAuthoredPose`). This script is the call between them, so the game loads files and holds no
// compiler.
import { writeFile } from "node:fs/promises";
import { compilePropBuckets, propPackageFiles } from "@threenative/terrain";
import {
  propKey,
  streamedBucket,
  streamedReach,
  variantFor,
  withAuthoredPose,
} from "../../src/render/props/props.js";

/**
 * Write one world's prop package: the manifest the game fetches, and one container per streamed
 * world. Returns the bucket names and record counts, for the bake log.
 */
export async function writeProps(outputDir, name, placements, size) {
  const indices = new Map();
  const entries = placements.map((placement) => {
    const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
    const index = indices.get(variant) ?? 0;
    indices.set(variant, index + 1);
    const reach = streamedReach(placement, index);
    return {
      bucket: streamedBucket(placement, reach),
      key: propKey(placement),
      placement: withAuthoredPose(placement),
      reach,
    };
  });
  const pkg = compilePropBuckets(entries, {
    bounds: { minX: -size / 2, minZ: -size / 2, sizeX: size, sizeZ: size },
  });
  const { files, manifest } = propPackageFiles(pkg, name);
  await Promise.all([
    writeFile(new URL(`${name}.props.json`, outputDir), manifest),
    ...Object.entries(files).map(([file, bytes]) => writeFile(new URL(file, outputDir), bytes)),
  ]);
  return pkg.buckets.map((bucket) => `${bucket.bucket} ${bucket.ids.length}`).join(", ");
}
