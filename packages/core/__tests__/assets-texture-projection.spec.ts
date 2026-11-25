import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";

/**
 * A texture as three's GLTFLoader hands it back for a cooked image whose extras carry the asset
 * MCP's `threenative.textureProjection` marker: `assignExtrasToUserData(texture, sourceDef)`.
 */
function projectedTexture(anisotropy?: number): Texture {
  const texture = new Texture();
  texture.userData = {
    threenative: {
      textureProjection: {
        atlas: 4096,
        runId: "run-1",
        ...(anisotropy === undefined ? {} : { anisotropy }),
      },
    },
  };
  return texture;
}

/** One mesh under a scene group, which is the shape `ctx.assets.model()` resolves. */
function sceneWith(material: MeshStandardMaterial): Group {
  return new Group().add(new Mesh(new BoxGeometry(1, 1, 1), material));
}

/** Loads through the injected model seam: no network, no GPU, no manifest. */
async function load(scene: Group): Promise<void> {
  const assets = createAssetLoader({ model: async () => ({ scene }) });
  await assets.model("https://cdn.test/level.glb");
}

describe("texture-projection anisotropy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should give every material map of a projected atlas anisotropic filtering", async () => {
    const map = projectedTexture();
    const emissive = projectedTexture();
    const unmarked = new Texture();
    await load(sceneWith(new MeshStandardMaterial({ emissiveMap: emissive, map })));

    expect(map.anisotropy).toBe(8);
    expect(emissive.anisotropy).toBe(8);
    // No marker, no convention: this texture is whatever the author asked for.
    expect(unmarked.anisotropy).toBe(1);
  });

  it("should leave an unmarked map at three's default of 1", async () => {
    const map = new Texture();
    await load(sceneWith(new MeshStandardMaterial({ map })));
    expect(map.anisotropy).toBe(1);
  });

  it("should let the marker's own anisotropy win over the default", async () => {
    const map = projectedTexture(4);
    await load(sceneWith(new MeshStandardMaterial({ map })));
    expect(map.anisotropy).toBe(4);
  });

  it("should leave a level the author already set above the default", async () => {
    const map = projectedTexture();
    map.anisotropy = 16;
    await load(sceneWith(new MeshStandardMaterial({ map })));
    expect(map.anisotropy).toBe(16);
  });

  it("should report the convention once per model, naming model, count and value", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const map = projectedTexture();
    const emissive = projectedTexture();
    await load(sceneWith(new MeshStandardMaterial({ emissiveMap: emissive, map })));

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(
      /^TN_TEXTURE_PROJECTION_ANISOTROPY https:\/\/cdn\.test\/level\.glb: 2 projected atlas texture\(s\) at anisotropy 8$/u,
    );
  });

  it("should say override when the marker set the value", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const map = projectedTexture(4);
    await load(sceneWith(new MeshStandardMaterial({ map })));

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(
      /: 1 projected atlas texture\(s\) at anisotropy 4 \(override\)$/u,
    );
  });
});
