/**
 * three's `renderer.shadowMap`, shared by both engine back ends (PRD-540; moved from the V8 player's
 * core-webgpu.mjs). The renderer hands `enabled` and `type` to the engine with its other settings
 * before each frame. A type the engine has no filter for is refused when it is set, as well as there.
 */
export class ShadowMap {
  enabled = false;
  #type = 1; // PCFShadowMap, three's default

  get type(): number {
    return this.#type;
  }

  set type(value: number) {
    if (value !== 1 && value !== 2)
      throw new Error(
        "TN_NATIVE_SHADOWMAP_TYPE_UNSUPPORTED: renderer.shadowMap.type must be PCFShadowMap or PCFSoftShadowMap",
      );
    this.#type = value;
  }
}
