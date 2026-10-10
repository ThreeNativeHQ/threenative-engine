import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("three/addons/loaders/GLTFLoader.js");
  vi.resetModules();
});

// A page fetches at most six files per origin at once. A loader chunk requested only after the
// first model's bytes arrive queues behind every other model download, and no model parses
// until it lands.
it("requests the glTF loader module while the model bytes are still downloading", async () => {
  const imported = vi.fn();
  vi.doMock("three/addons/loaders/GLTFLoader.js", () => {
    imported();
    return { GLTFLoader: class {} };
  });
  vi.stubGlobal("fetch", (url: string) =>
    url.endsWith("assets.manifest.json")
      ? Promise.resolve(new Response("gone", { status: 404 }))
      : new Promise<Response>(() => undefined),
  );
  const { createAssetLoader } = await import("../src/assets.js");

  void createAssetLoader({ basePath: "/assets" }).model("ship.glb");

  await vi.waitFor(() => expect(imported).toHaveBeenCalledOnce());
});
