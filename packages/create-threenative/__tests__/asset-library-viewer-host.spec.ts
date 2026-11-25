import { describe, expect, it } from "vitest";
import { createViewerHost } from "../src/asset-library/client/viewers.js";
import type { IAssetCatalog } from "../src/asset-library/types.js";

describe("the Asset Library viewer host", () => {
  it("hands viewers the catalog that arrived after it was made", () => {
    // `Object.assign` copied the getter's value at creation, an empty catalog, so the Scene
    // Bundler's model picker listed nothing in every real project.
    const host = createViewerHost({} as Parameters<typeof createViewerHost>[0]);
    const catalog: IAssetCatalog = {
      elements: [
        { id: "assets/crate.glb", name: "crate", kind: "model", source: "project", styleTags: [] },
      ],
      styles: {},
    };
    host.ready(catalog);
    expect(host.catalog.elements.map((e) => e.id)).toEqual(["assets/crate.glb"]);
  });
});
