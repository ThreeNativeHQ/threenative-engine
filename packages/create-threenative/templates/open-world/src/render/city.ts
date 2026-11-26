// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The city's look, drawn from `city/layout.ts`: asphalt, kerbed sidewalks, grey grid towers, the
// lane paint, and the landmark blocks (hospital, police, respray garage, the job's drop-off lot).
// Every solid is also returned as a box, so the colliders are exactly what is drawn.
//
// Three builders, for three lifetimes: `buildCity` is what stays (ground, boundary, paint, markers),
// `buildBlock` is one block's detail that `systems/streaming.ts` builds and frees by distance, and
// `buildSkyline` is every block's solids as one instanced draw, the far field nothing streams.
import { InstancedBatch } from "@threenative/core";
import { BoxGeometry, CylinderGeometry, Group, Mesh, PlaneGeometry, Vector3 } from "three";
import {
  BLOCKS,
  BOUNDARY,
  CITY_HALF,
  type IBlock,
  KERB,
  LANES,
  PLACES,
  SIDEWALK,
} from "../city/layout.js";
import {
  copMaterial,
  floorMaterial,
  laneMarkMaterial,
  markerMaterial,
  propMaterial,
  roadMaterial,
  skylineMaterial,
  structureMaterial,
  worldGridUVs,
} from "./materials.js";

export interface ISolid {
  readonly center: Vector3;
  readonly size: Vector3;
}

export interface IBuilt {
  /** Everything drawn, unmerged; the caller merges it by material once it is in place. */
  readonly root: Group;
  /** Every box a body collides with. */
  readonly solids: readonly ISolid[];
}

export interface ICity extends IBuilt {
  /** The respray pad and the drop-off pad, which glow only while they mean something. */
  readonly respraySign: Mesh;
  readonly dropoffPad: Mesh;
  readonly phoneMarker: Mesh;
}

/** A stable pseudo-random tower height, so the skyline is the same every run. */
function towerHeight(seed: number): number {
  return 9 + ((seed * 7919) % 11) * 2.6;
}

function builder(name: string) {
  const root = new Group();
  root.name = name;
  const solids: ISolid[] = [];
  const box = (
    size: readonly [number, number, number],
    center: readonly [number, number, number],
    material = structureMaterial,
    collide = true,
  ): Mesh => {
    const geometry = new BoxGeometry(size[0], size[1], size[2]);
    geometry.translate(center[0], center[1], center[2]);
    const mesh = new Mesh(worldGridUVs(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    if (collide)
      solids.push({
        center: new Vector3(center[0], center[1], center[2]),
        size: new Vector3(size[0], size[1], size[2]),
      });
    return mesh;
  };
  return { box, root, solids };
}

/** The ground, the boundary wall, the lane paint and the glowing markers: built once, kept. */
export function buildCity(): ICity {
  const { box, root, solids } = builder("city");
  // Asphalt under the whole grid, the plain ground out to the boundary, and the boundary wall.
  const asphalt = new PlaneGeometry(CITY_HALF * 2, CITY_HALF * 2).rotateX(-Math.PI / 2);
  const road = new Mesh(worldGridUVs(asphalt), roadMaterial);
  road.receiveShadow = true;
  root.add(road);
  const outside = new PlaneGeometry(BOUNDARY * 6, BOUNDARY * 6).rotateX(-Math.PI / 2);
  outside.translate(0, -0.02, 0);
  const ground = new Mesh(worldGridUVs(outside), floorMaterial);
  ground.receiveShadow = true;
  root.add(ground);
  for (const sign of [-1, 1]) {
    box([BOUNDARY * 2 + 1, 3, 1], [0, 1.5, sign * BOUNDARY]);
    box([1, 3, BOUNDARY * 2 - 1], [sign * BOUNDARY, 1.5, 0]);
  }

  // Dashed centre lines between the stop lines.
  for (const lane of LANES) {
    if (lane.from > lane.to) continue;
    const length = lane.start.distanceTo(lane.end);
    const along = lane.direction;
    const centre = new Vector3()
      .addVectors(lane.start, lane.end)
      .multiplyScalar(0.5)
      .addScaledVector(new Vector3(-along.z, 0, along.x), -2.75);
    for (let d = -length / 2 + 1; d < length / 2 - 1; d += 4) {
      const dash = new BoxGeometry(along.x === 0 ? 0.15 : 2, 0.01, along.x === 0 ? 2 : 0.15);
      dash.translate(centre.x + along.x * d, 0.006, centre.z + along.z * d);
      root.add(new Mesh(dash, laneMarkMaterial));
    }
  }

  const respraySign = new Mesh(new BoxGeometry(5.5, 0.02, 7.5), markerMaterial);
  respraySign.position.set(PLACES.respray.x, KERB + 0.02, PLACES.respray.z);
  root.add(respraySign);
  const dropoffPad = new Mesh(new CylinderGeometry(4, 4, 0.04, 32), markerMaterial);
  dropoffPad.position.set(PLACES.dropoff.x, KERB + 0.03, PLACES.dropoff.z);
  dropoffPad.visible = false;
  root.add(dropoffPad);
  const phoneMarker = new Mesh(new CylinderGeometry(0.9, 0.9, 2.4, 24, 1, true), markerMaterial);
  phoneMarker.position.set(PLACES.phone.x, KERB + 1.2, PLACES.phone.z);
  root.add(phoneMarker);
  return { dropoffPad, phoneMarker, respraySign, root, solids };
}

/** One block's slab and what stands on it: what `systems/streaming.ts` builds near the player. */
export function buildBlock(target: IBlock): IBuilt {
  const { box, root, solids } = builder(`block-${target.i}-${target.j}`);
  const { x, z } = target.center;
  // The kerbed slab: sidewalk and lot are one raised block, which is what a car climbs.
  box([target.size, KERB, target.size], [x, KERB / 2, z], floorMaterial);
  const lot = target.size - SIDEWALK * 2;
  const top = KERB;
  switch (target.kind) {
    case "buildings": {
      const span = lot / 2 - 2;
      let k = 0;
      for (const ox of [-1, 1])
        for (const oz of [-1, 1]) {
          const height = towerHeight(target.i * 31 + target.j * 17 + k * 5 + 3);
          k += 1;
          box([span, height, span], [x + (ox * lot) / 4, top + height / 2, z + (oz * lot) / 4]);
        }
      break;
    }
    case "plaza": {
      // Low planters at the corners and a phone booth where the job starts.
      for (const ox of [-1, 1])
        for (const oz of [-1, 1]) box([6, 0.8, 6], [x + ox * 8, top + 0.4, z + oz * 8]);
      box([0.9, 2.2, 0.9], [PLACES.phone.x - 1.6, KERB + 1.1, PLACES.phone.z], propMaterial);
      break;
    }
    case "hospital":
      box([lot - 4, 14, lot - 8], [x, top + 7, z - 2]);
      // A white cross on the roof edge facing the street: the landmark you respawn under.
      box([6, 1.4, 0.4], [x, top + 11, z - 2 + (lot - 8) / 2 + 0.2], laneMarkMaterial, false);
      box([1.4, 6, 0.4], [x, top + 11, z - 2 + (lot - 8) / 2 + 0.2], laneMarkMaterial, false);
      break;
    case "police":
      box([lot - 4, 10, lot - 8], [x, top + 5, z + 2]);
      box([8, 1.2, 0.4], [x, top + 8, z + 2 - (lot - 8) / 2 - 0.2], copMaterial, false);
      break;
    case "respray": {
      // A drive-in garage open to the south road: two side walls, a back wall and a roof.
      const pad = PLACES.respray;
      const depth = 8;
      const width = 6;
      const back = pad.z - depth / 2;
      box([0.5, 4, depth], [pad.x - width / 2, top + 2, pad.z]);
      box([0.5, 4, depth], [pad.x + width / 2, top + 2, pad.z]);
      box([width + 0.5, 4, 0.5], [pad.x, top + 2, back]);
      box([width + 0.5, 0.4, depth], [pad.x, top + 4.2, pad.z]);
      box([lot - 4, 6, lot / 2 - 6], [x, top + 3, z - lot / 4 - 1]);
      break;
    }
    case "dropoff":
      // An open lot with a low wall at the back: the job's car goes onto the glowing pad.
      box([lot, 1, 0.5], [x, top + 0.5, z + lot / 2]);
      break;
  }
  return { root, solids };
}

/**
 * The far field: every block's solids as one instanced box draw with no grid, no colliders and no
 * shadow. Each box sits 5 cm inside the solid it stands for, so a streamed block's own faces hide
 * it wherever that block is built, and it shows only where the block is not.
 */
export function buildSkyline(): Mesh | undefined {
  const batch = new InstancedBatch({
    geometry: new BoxGeometry(1, 1, 1),
    material: skylineMaterial,
  });
  for (const target of BLOCKS) {
    const { root, solids } = buildBlock(target);
    for (const solid of solids)
      batch.place({
        position: [solid.center.x, solid.center.y, solid.center.z],
        scale: [solid.size.x - 0.1, solid.size.y - 0.1, solid.size.z - 0.1],
      });
    root.traverse((node) => {
      if (node instanceof Mesh) node.geometry.dispose();
    });
  }
  return batch.build({ name: "skyline" });
}
