export interface IFluidParticlesState extends Record<string, unknown> {
  count: number;
  steps: number;
  meanCompression: number;
  maxSpeed: number;
  frontX: number;
  peakFrontX: number;
  minY: number;
  maxY: number;
  inBounds: number;
  released: number;
  staleFrames: number;
  /** Coupling scene: 99 until the body exists, then metres. */
  sphereY: number;
  sphereSpeed: number;
  boxY: number;
  /** |box centre - heightAt(box)|, 99 until the surface has landed. */
  boxSurfaceGap: number;
  /** Largest |surface - resting level| seen at the drop point after the sphere is released. */
  surfaceDisturbance: number;
  surface: number;
  /** Surface height at the drop point before the sphere arrives. */
  surfaceRest: number;
}

export const INITIAL_STATE: IFluidParticlesState = {
  count: 0,
  steps: 0,
  meanCompression: 1,
  maxSpeed: 99,
  frontX: 0,
  peakFrontX: 0,
  minY: 0,
  maxY: 0,
  inBounds: 0,
  released: 0,
  staleFrames: 0,
  sphereY: 99,
  sphereSpeed: 99,
  boxY: 99,
  boxSurfaceGap: 99,
  surfaceDisturbance: 0,
  surface: 0,
  surfaceRest: 0,
};
