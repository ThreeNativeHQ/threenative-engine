// Finite current estimator: piecewise constant radiance on the periodic raw4 Voronoi cells.
// Opaque PBR is still pixel-frequency radiance broadcast to covered sites: an explicit spatial
// approximation. These areas do not claim the exact continuous material integral.
export const CURRENT_SAMPLE_POSITIONS = [
  [3 / 8, 1 / 8],
  [7 / 8, 3 / 8],
  [1 / 8, 5 / 8],
  [5 / 8, 7 / 8],
] as const;
type Point = readonly [number, number];

export const CURRENT_SAMPLE_CELLS: readonly (readonly Point[])[] = [
  [
    [1 / 6, 1 / 3],
    [0, 0],
    [1 / 3, -1 / 6],
    [2 / 3, 1 / 6],
    [1 / 2, 1 / 2],
  ],
  [
    [5 / 6, 2 / 3],
    [1 / 2, 1 / 2],
    [2 / 3, 1 / 6],
    [1, 0],
    [7 / 6, 1 / 3],
  ],
  [
    [0, 1],
    [-1 / 6, 2 / 3],
    [1 / 6, 1 / 3],
    [1 / 2, 1 / 2],
    [1 / 3, 5 / 6],
  ],
  [
    [1 / 3, 5 / 6],
    [1 / 2, 1 / 2],
    [5 / 6, 2 / 3],
    [1, 1],
    [2 / 3, 7 / 6],
  ],
];
