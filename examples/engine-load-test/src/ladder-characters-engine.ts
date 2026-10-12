// PRD-464 R3's characters for the owned engine player: it has no GLTFLoader and no network, so the same
// Fox bytes arrive as a cooked package entry (`run-engine.ts` cooks `Fox.glb` beside the bundle) through
// core's loader, which the engine bundle swaps for the player's package reader.
import { createAssetLoader } from "../../../packages/core/src/assets.js";
import { type IFoxImport, foxCrowdFrom } from "./fox-crowd.js";
import type { ICharacterCrowd } from "./game.js";

/** The Fox's logical path in the cooked package. */
export const ENGINE_FOX_ASSET = "Fox.glb";

export async function createEngineFoxCrowd(): Promise<ICharacterCrowd> {
  return foxCrowdFrom(await createAssetLoader().model<IFoxImport>(ENGINE_FOX_ASSET));
}
