import { Terrain, bakeMesh } from "@threenative/terrain";
import { toGeometry } from "@threenative/terrain/three";
import {
  BoxGeometry,
  DataTexture,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  ObjectSpaceNormalMap,
  SRGBColorSpace,
  ShaderMaterial,
  TangentSpaceNormalMap,
} from "three";
import { describe, expect, it } from "vitest";

async function fixture() {
  const { exportWorldGLB } = await import("@threenative/terrain/export");
  const state = new Terrain({ size: 16, resolution: 17 })
    .scatter({ id: "trees", asset: "pine", count: 1, avoidWater: false })
    .evaluate();
  const texture = (colour = false) => {
    const value = new DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    if (colour) value.colorSpace = SRGBColorSpace;
    return value;
  };
  const material = new MeshStandardMaterial({
    map: texture(true),
    normalMap: texture(),
    roughnessMap: texture(),
    aoMap: texture(),
  });
  const terrain = new Mesh(toGeometry(bakeMesh(state)), material);
  const asset = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  const id = state.instances[0]?.id;
  if (!id) throw new Error("Scatter fixture did not place its model");
  const input = {
    revision: "a".repeat(64),
    snapshotTime: 3,
    state,
    terrain,
    assets: new Map([["pine", asset]]),
    transforms: new Map([[id, new Matrix4()]]),
  };
  return { exportWorldGLB, input, id };
}

describe("public full-world GLB export", () => {
  it("imports without DOM globals and rejects missing resolved models/matrices", async () => {
    expect(typeof document).toBe("undefined");
    const { exportWorldGLB, input, id } = await fixture();
    await expect(exportWorldGLB({ ...input, assets: new Map() })).rejects.toThrow("pine");
    await expect(exportWorldGLB({ ...input, transforms: new Map() })).rejects.toThrow(id);
    expect(input.assets.get("pine")?.parent).toBeNull();
  });

  it("rejects noncanonical terrain, invalid transforms and unsupported shader materials", async () => {
    const { exportWorldGLB, input, id } = await fixture();
    const positions = input.terrain.geometry.getAttribute("position");
    positions.setY(0, 1);
    await expect(exportWorldGLB(input)).rejects.toThrow("terrain");
    positions.setY(0, 0);
    const bad = new Matrix4().makeScale(-1, 1, 1);
    await expect(exportWorldGLB({ ...input, transforms: new Map([[id, bad]]) })).rejects.toThrow(
      id,
    );
    const model: Mesh | undefined = input.assets.get("pine");
    if (!model) throw new Error("Model missing");
    model.material = new ShaderMaterial();
    model.material.name = "unbaked-pine-wind";
    await expect(exportWorldGLB(input)).rejects.toThrow("unbaked-pine-wind");
  });

  it("rejects shear, invisible models and unbaked surface displacement", async () => {
    const { exportWorldGLB, input, id } = await fixture();
    const sheared = new Matrix4();
    sheared.elements[4] = 0.25;
    await expect(
      exportWorldGLB({ ...input, transforms: new Map([[id, sheared]]) }),
    ).rejects.toThrow("shear");
    const asset = input.assets.get("pine");
    if (!asset) throw new Error("Model missing");
    asset.visible = false;
    await expect(exportWorldGLB(input)).rejects.toThrow("no static meshes");
    asset.visible = true;
    asset.material.displacementMap = input.terrain.material.map;
    await expect(exportWorldGLB(input)).rejects.toThrow("displacementMap");
  });

  it("requires baked terrain PBR maps with correct data colour spaces", async () => {
    const { exportWorldGLB, input } = await fixture();
    input.terrain.material.normalMap = null;
    await expect(exportWorldGLB(input)).rejects.toThrow("normalMap");
    input.terrain.material.normalMap = input.terrain.material.map;
    await expect(exportWorldGLB(input)).rejects.toThrow("normalMap");
  });

  it("requires representable normal maps and complete byte RGBA data", async () => {
    const { exportWorldGLB, input } = await fixture();
    input.terrain.material.normalMapType = ObjectSpaceNormalMap;
    await expect(exportWorldGLB(input)).rejects.toThrow("normal");
    input.terrain.material.normalMapType = TangentSpaceNormalMap;
    input.terrain.material.normalScale.set(1, 2);
    await expect(exportWorldGLB(input)).rejects.toThrow("normal");
    input.terrain.material.normalScale.set(1, 1);
    const map = input.terrain.material.normalMap;
    if (!map) throw new Error("Normal map missing");
    map.image = { width: 1, height: 1, data: new Uint8Array(3) };
    await expect(exportWorldGLB(input)).rejects.toThrow("RGBA");
  });

  it("resolves a per-placement model before the shared asset model", async () => {
    const { exportWorldGLB, input, id } = await fixture();
    // Two variants of one tree share an asset id, so the resolved model is keyed by placement. The
    // bespoke model is an unsupported material and its own name is what the encoder reports, which
    // is how this proves the placement's own model was examined rather than the shared `pine` one.
    const rejected = new Mesh(new BoxGeometry(), new ShaderMaterial());
    rejected.name = "bespoke-variant";
    await expect(exportWorldGLB({ ...input, models: new Map([[id, rejected]]) })).rejects.toThrow(
      "bespoke-variant",
    );
    // A models map alone cannot hide a missing asset: with no shared asset, a placement the caller
    // did not model fails closed rather than exporting an empty node.
    await expect(
      exportWorldGLB({
        ...input,
        assets: new Map(),
        models: new Map([["no-such-placement", new Mesh()]]),
      }),
    ).rejects.toThrow("pine");
    // A placement with no model at all still fails closed rather than exporting an empty node.
    await expect(exportWorldGLB({ ...input, assets: new Map() })).rejects.toThrow("pine");
  });

  it("fails closed for omitted, stale or incoherent water instead of omitting it", async () => {
    const { exportWorldGLB, input } = await fixture();
    const state = new Terrain({ size: 16, resolution: 17 })
      .water({ id: "sea", kind: "ocean", level: 2 })
      .evaluate();
    const model = new Group();
    model.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    const base = { ...input, state, transforms: new Map() };
    await expect(exportWorldGLB(base)).rejects.toThrow("sea");
    await expect(
      exportWorldGLB({ ...base, water: [{ id: "sea", object: model, time: 3, staleFrames: 1 }] }),
    ).rejects.toThrow("stale");
    await expect(
      exportWorldGLB({ ...base, water: [{ id: "sea", object: model, time: 2, staleFrames: 0 }] }),
    ).rejects.toThrow("time");
  });
});
