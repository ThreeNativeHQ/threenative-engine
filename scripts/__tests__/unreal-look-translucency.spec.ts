import { Color, DoubleSide, MeshStandardMaterial, PointLight, SpotLight } from "three";
import { positionWorld, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { pointLightMean, translucentTwin } from "../unreal-look/scaffold/render/translucency.js";

describe("translucent surfaces take the light every direction receives (PRD-643)", () => {
  it("is an unlit material that keeps the source's blending state and takes its colour from the light", () => {
    const source = new MeshStandardMaterial({
      color: new Color(0.85, 0.5, 0.25),
      opacity: 0.5,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });
    const seen: unknown[] = [];
    const twin = translucentTwin(source, (position) => {
      seen.push(position);
      return vec3(1, 1, 1);
    });
    expect(twin).toBeInstanceOf(MeshBasicNodeMaterial);
    expect(twin.transparent).toBe(true);
    expect(twin.opacity).toBe(0.5);
    expect(twin.side).toBe(DoubleSide);
    expect(twin.depthWrite).toBe(false);
    expect(twin.colorNode).not.toBeNull();
    // The light is asked for at the fragment's world position.
    expect(seen).toEqual([positionWorld]);
  });

  it("refuses a spot light rather than light a pane from outside its cone", () => {
    const spot = new SpotLight(0xffffff, 100);
    spot.name = "Lamp";
    expect(() => pointLightMean([spot], positionWorld)).toThrow(
      /TN_TRANSLUCENT_LIGHT: Lamp is a SpotLight/,
    );
  });

  it("builds a node for point lights, and a dark one for none", () => {
    const lamp = new PointLight(0xffffff, 100, 20, 2);
    expect(pointLightMean([lamp], positionWorld)).toBeDefined();
    expect(pointLightMean([], positionWorld)).toBeDefined();
  });
});
