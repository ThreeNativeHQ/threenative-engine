// PRD-464 R3's characters for the web and legacy-host arms: the Fox decoded with the engine's own path,
// `createAssetLoader().model()` over `GLTFLoader`. The crowd itself is `fox-crowd.ts`'s.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createAssetLoader } from "../../../packages/core/src/assets.js";
import { type IFoxImport, foxCrowdFrom } from "./fox-crowd.js";
import type { ICharacterCrowd } from "./game.js";

// Stamped by `vite.config.ts` from the copy pinned in
// `benchmark/engine-load-test/sources.lock.json`, whose digest the runner checks before the build.
declare const __TN_BENCH_FOX_URL__: string;

export async function createFoxCrowd(): Promise<ICharacterCrowd> {
  // The engine's loader, with the source injected: one file, already reachable, and the same call a
  // game would make. A scene that decoded the model itself would be measuring a path no ThreeNative
  // game takes. The loader is handed the url rather than the bytes so the fetch stays inside it.
  const loader = createAssetLoader({
    model: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TN_BENCH_FOX_HTTP:${url} answered ${response.status}.`);
      const source = await response.arrayBuffer();
      return new Promise<unknown>((resolve, reject) => {
        new GLTFLoader().parse(source, "", resolve, reject);
      });
    },
  });
  return foxCrowdFrom(await loader.model<IFoxImport>(__TN_BENCH_FOX_URL__));
}
