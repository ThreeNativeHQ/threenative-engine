// The stage, built from the tables in `src/level.ts`: a floating block of dark grid with a light
// grid slab on top, and three blue pass-through platforms. Every surface uses the metre-grid
// materials, so a box you see is a box you stand on.
import { Group, Mesh } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { MAIN, PLATFORMS, STAGE_DEPTH } from "../level.js";
import { floorMaterial, propMaterial, structureMaterial, worldGridUVs } from "./materials.js";

const BEVEL = 0.04;
const SLAB = 0.14;
const PLATFORM_THICKNESS = 0.3;

function block(
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  material: Mesh["material"],
): Mesh {
  const geometry = new RoundedBoxGeometry(width, height, depth, 2, BEVEL);
  geometry.translate(x, y, 0);
  const mesh = new Mesh(worldGridUVs(geometry), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createStage(): Group {
  const stage = new Group();
  stage.name = "stage";
  const width = MAIN.x1 - MAIN.x0;
  const height = MAIN.y - MAIN.bottom;
  stage.add(
    block(
      width,
      height - SLAB,
      STAGE_DEPTH,
      0,
      MAIN.bottom + (height - SLAB) / 2,
      structureMaterial,
    ),
  );
  stage.add(block(width, SLAB, STAGE_DEPTH, 0, MAIN.y - SLAB / 2, floorMaterial));
  for (const platform of PLATFORMS)
    stage.add(
      block(
        platform.x1 - platform.x0,
        PLATFORM_THICKNESS,
        STAGE_DEPTH * 0.5,
        (platform.x0 + platform.x1) / 2,
        platform.y - PLATFORM_THICKNESS / 2,
        propMaterial,
      ),
    );
  return stage;
}
