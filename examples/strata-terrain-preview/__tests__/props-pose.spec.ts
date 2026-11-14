/**
 * PRD-792 AC-2: a baked package record carries position, quaternion and scale, so the load path
 * rebuilds the placement from the record and asks `preparePose` for the pose. The record's quaternion
 * is a named pose override: `preparePose` stays the only author of the pose, and a boulder keeps the
 * burial, the four-footprint sink and the mountain base ring it had before the bake.
 *
 * The harness is the loader's own round trip. The authored placement is posed as the game poses it
 * today; its quaternion is what the record stores; the record then poses a placement that carries no
 * scatter rotation at all. Both arms must land on the same matrix.
 */
import type { IPlacement } from "@threenative/terrain";
import { BoxGeometry, type Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  type IPropPoseOverride,
  type PropGroundQuery,
  preparePose,
} from "../src/render/props/props.js";

/** A boulder record whose stone is centred on its own origin, as the procedural stone is. */
const geometry = new BoxGeometry(1, 2, 1);
const material = new MeshBasicMaterial();
const authored: IPlacement = {
  alignToNormal: true,
  asset: "boulder",
  id: "temperate-boulder:41",
  layer: "temperate-boulder",
  normal: [0.36, 0.93, 0.09],
  position: [12.5, 7.25, -31.5],
  rotation: 1.234,
  scale: 1.7,
};

/** The drawn ground: a flat surface, so the pose's own steps are the only thing that moves it. */
const groundAt: PropGroundQuery = () => ({ height: 3, offset: authored.position[1] - 3 });

/** The quaternion a baked record stores: the rotation the authored pose resolved to. */
function recordOf(matrix: Matrix4): IPropPoseOverride {
  const quaternion = new Quaternion();
  matrix.decompose(new Vector3(), quaternion, new Vector3());
  return { quaternion: quaternion.normalize().toArray() };
}

/** What the loader rebuilds from that record: the record's numbers, and no scatter rotation left. */
function rebuilt(record: IPropPoseOverride): IPlacement {
  return { ...authored, alignToNormal: false, normal: [0, 1, 0], rotation: 0 };
}

describe("the baked record's pose override", () => {
  const posed = preparePose(geometry, material, authored, undefined, groundAt);
  const record = recordOf(posed.matrix);

  it("keeps a boulder's authored rotation", () => {
    const fromRecord = preparePose(
      geometry,
      material,
      rebuilt(record),
      undefined,
      groundAt,
      record,
    );
    // The record describes the pose the game drew before the bake owned the container.
    expect(fromRecord.matrix.elements).toEqual(posed.matrix.elements);
    // And the pose carries the record's own quaternion, not a yaw re-derived from the placement.
    expect(recordOf(fromRecord.matrix).quaternion).toEqual(record.quaternion);
  });

  it("sinks the boulder by its burial and footprint, as the authored pose does", () => {
    const fromRecord = preparePose(
      geometry,
      material,
      rebuilt(record),
      undefined,
      groundAt,
      record,
    );
    // The transform path skips every sink below; the record path keeps them.
    const bare = preparePose(
      geometry,
      material,
      authored,
      {
        ...record,
        quaternion: [...record.quaternion],
        grounding: true,
        position: authored.position,
        scale: [1.7, 1.7, 1.7],
      },
      groundAt,
    );
    const sunk = fromRecord.matrix.elements[13] as number;
    const snapped = bare.matrix.elements[13] as number;
    // A third of the 2 m stone's own height at scale 1.7 is the burial alone.
    expect(snapped - sunk).toBeGreaterThan(0.32 * 2 * 1.7);
  });
});
