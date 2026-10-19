import { Color, Fog, type Scene } from "three";

/**
 * PRD-461's view-distance recipe fog (`docs/guides/world-streaming.md`): opaque at `ring · cellSize`,
 * where the near side of a newly loaded cell can be, and starting one cell out. The background takes
 * the fog colour, so a fogged edge matches the sky. The colour is this example's own.
 */
export function worldFog(scene: Scene, cellSize: number, ring: number): void {
  const color = new Color(0x0b1a2a);
  scene.background = color;
  scene.fog = new Fog(color, cellSize, ring * cellSize);
}
