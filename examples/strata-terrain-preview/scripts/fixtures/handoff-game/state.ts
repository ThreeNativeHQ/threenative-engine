export type GameState = {
  placements: number;
  meshes: number;
  glbLights: number;
  glbCameras: number;
  colliderRows: number;
  colliderColumns: number;
  sunIntensity: number;
  sunElevation: number;
  fillIntensity: number;
  exposure: number;
  fogDensity: number;
  groundError: number;
  groundMeasured: number;
  frames: number;
};

export const initialState: GameState = {
  placements: 0,
  meshes: 0,
  glbLights: -1,
  glbCameras: -1,
  colliderRows: 0,
  colliderColumns: 0,
  sunIntensity: 0,
  sunElevation: 0,
  fillIntensity: 0,
  exposure: 0,
  fogDensity: 0,
  groundError: -1,
  groundMeasured: 0,
  frames: 0,
};
