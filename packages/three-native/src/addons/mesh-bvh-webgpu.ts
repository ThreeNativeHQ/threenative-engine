/**
 * `three-mesh-bvh/webgpu` as the engine back ends provide it. The upstream module pulls in
 * three-mesh-bvh's whole CPU tree, which builds a `Line3` and extends `Triangle` at module scope,
 * and it extends three's node classes, so it cannot load over the engine. Core imports it for
 * `GPUSceneBVH`; each export refuses at use, by name, so a game that builds no GPU scene BVH boots.
 *
 * ponytail: refused at use; bind the TSL ray query when a native-engine game needs GPUSceneBVH.
 */
import { unsupportedExport } from "../refused.js";

export const bvhIntersectFirstHit = unsupportedExport("bvhIntersectFirstHit");
export const rayStruct = unsupportedExport("rayStruct");
export const bvhNodeStruct = unsupportedExport("bvhNodeStruct");
