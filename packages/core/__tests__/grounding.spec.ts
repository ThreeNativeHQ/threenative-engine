import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { GroundSnap } from "../src/index.js";

function model(): { root: Group; mesh: Mesh } {
  const root = new Group();
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.position.y = 1;
  root.add(mesh);
  root.updateWorldMatrix(true, true);
  return { root, mesh };
}

describe("GroundSnap", () => {
  it("rests the lowest posed point on the surface", () => {
    const { root, mesh } = model();
    root.position.y = 0.75;
    const snap = new GroundSnap(root, { meshes: [mesh] });

    snap.apply(root, 0, 1 / 60);

    expect(snap.clearance).toBeCloseTo(0, 6);
    expect(root.position.y).toBeCloseTo(-0.5, 6);
  });

  it("keeps reporting clearance while disabled", () => {
    const { root, mesh } = model();
    root.position.y = 0.75;
    const snap = new GroundSnap(root, { enabled: false, meshes: [mesh] });

    snap.apply(root, 0, 1 / 60);

    expect(root.position.y).toBeCloseTo(0.75, 6);
    expect(snap.clearance).toBeGreaterThan(0.5);
  });

  it("does not exceed maxRate when damping", () => {
    const { root, mesh } = model();
    root.position.y = 0.75;
    const snap = new GroundSnap(root, { maxRate: 0.25, meshes: [mesh] });

    snap.apply(root, 0, 1);

    expect(root.position.y).toBeCloseTo(0.5, 6);
    expect(snap.clearance).toBeCloseTo(1, 6);
  });

  it("raises a sunken pose at once even with maxRate", () => {
    const { root, mesh } = model();
    root.position.y = -1;
    const snap = new GroundSnap(root, { maxRate: 0.25, meshes: [mesh] });

    snap.apply(root, 0, 1 / 60);

    expect(snap.clearance).toBeCloseTo(0, 6);
    expect(root.position.y).toBeCloseTo(-0.5, 6);
  });

  it("converts a world correction through a scaled and rotated parent", () => {
    const parent = new Group();
    parent.position.set(3, -2, 1);
    parent.rotation.z = Math.PI / 4;
    parent.scale.set(2, 3, 1);
    const { root, mesh } = model();
    root.position.y = 0.75;
    parent.add(root);
    parent.updateWorldMatrix(true, true);
    const snap = new GroundSnap(root, { meshes: [mesh] });

    snap.apply(root, 0, 1 / 60);

    expect(snap.clearance).toBeCloseTo(0, 6);
  });

  it("can compare the cheap envelope with a precise measurement on demand", () => {
    const { root, mesh } = model();
    const snap = new GroundSnap(root, { meshes: [mesh] });

    expect(snap.audit()).toBeCloseTo(0, 6);
  });
});
