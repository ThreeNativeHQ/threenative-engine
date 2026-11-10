import { BoxGeometry, Mesh } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

// PRD-860: a streamed model resolves with its coarse companion; core marks that geometry.
vi.mock("@threenative/core", () => ({
  isStreamedGeometry: (geometry: { userData: { streamed?: boolean } }) =>
    geometry.userData.streamed === true,
}));

const { CollisionShape3D } = await import("../src/CollisionShape3D.js");

afterEach(() => vi.restoreAllMocks());

describe("CollisionShape3D.fromMesh on a streamed coarse model", () => {
  it("names the coarse copy and the { whole: true } override, and still builds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const coarse = new Mesh(new BoxGeometry());
    coarse.name = "deck";
    coarse.geometry.userData.streamed = true;
    expect(CollisionShape3D.fromMesh(coarse, "trimesh")).toBeDefined();
    expect(warn.mock.calls.flat().join("\n")).toMatch(/TN_COLLIDER_COARSE.*"deck".*whole: true/u);
  });

  it("stays quiet for a whole model and for a bounds-only shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    CollisionShape3D.fromMesh(new Mesh(new BoxGeometry()), "trimesh");
    const coarse = new Mesh(new BoxGeometry());
    coarse.geometry.userData.streamed = true;
    CollisionShape3D.fromMesh(coarse, "box");
    expect(warn).not.toHaveBeenCalled();
  });
});
