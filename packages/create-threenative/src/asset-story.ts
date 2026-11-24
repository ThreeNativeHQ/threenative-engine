// `defineAssetStory` (PRD-915): the one browser-safe export a code story imports. A story is any
// `src/**/*.story.ts` whose default export this returns; `/__assets/` lists it under Code stories.
import type { IAssetControl, IAssetStory } from "./asset-library/types.js";

export type { IAssetControl, IAssetStory };

/**
 * Declares a code story: a prop, an entity, a TSL material or a mini-scene, built from props the
 * Asset Library's controls tune live (`range`, `select`, `toggle`, `text`, `color`, `vec3`).
 *
 * @example
 * export default defineAssetStory({
 *   title: "Crate",
 *   controls: [{ key: "size", label: "Size (m)", type: "range", min: 0.2, max: 3, step: 0.1, default: 1 }],
 *   create: ({ size }) => new Mesh(new BoxGeometry(size, size, size), new MeshStandardMaterial()),
 * });
 */
export function defineAssetStory<P extends Record<string, unknown> = Record<string, unknown>>(
  story: IAssetStory<P>,
): IAssetStory<P> {
  return story;
}
