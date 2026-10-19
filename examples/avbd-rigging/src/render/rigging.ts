import {
  BoxGeometry,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  type Object3D,
  Uint32BufferAttribute,
} from "three";
import { attribute, cross, storage, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial, type StorageBufferAttribute } from "three/webgpu";
import type { IRiggingModel } from "../physics/model.js";
import type { IRiggingInput, IRiggingPatch } from "../physics/topology.js";
import { requiredAt } from "../physics/vendor/required-at.js";

const surface = (color: number) =>
  new MeshBasicNodeMaterial({ color, side: DoubleSide, toneMapped: false });

export function patchGeometry(patch: IRiggingPatch): BufferGeometry {
  const geometry = new BufferGeometry();
  const points = new Float32Array(patch.columns * patch.rows * 3);
  const uv = new Float32Array(patch.columns * patch.rows * 2);
  const indices: number[] = [];
  for (let row = 0; row < patch.rows; row++)
    for (let col = 0; col < patch.columns; col++) {
      const vertex = row * patch.columns + col;
      points.set(
        [
          patch.origin[0] + (col * patch.width) / (patch.columns - 1),
          patch.origin[1] - (row * patch.height) / (patch.rows - 1),
          patch.origin[2],
        ],
        vertex * 3,
      );
      uv.set([col / (patch.columns - 1), row / (patch.rows - 1)], vertex * 2);
      if (col + 1 < patch.columns && row + 1 < patch.rows)
        indices.push(
          vertex,
          vertex + patch.columns,
          vertex + 1,
          vertex + 1,
          vertex + patch.columns,
          vertex + patch.columns + 1,
        );
    }
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Read the exact pinned 40-float body layout; no CPU observation drives this draw. */
export function candidateDraw(
  input: IRiggingInput,
  model: IRiggingModel,
  bodyAttribute: StorageBufferAttribute,
): Group {
  const group = new Group();
  const bodies = storage(bodyAttribute, "vec4", model.solver.bodies.length * 10).toReadOnly();
  const bind = (geometry: BufferGeometry, ids: Uint32Array, color: number, name: string): void => {
    geometry.setAttribute("riggingBody", new Uint32BufferAttribute(ids, 1));
    const offset = attribute<"uint">("riggingBody", "uint").mul(10);
    const q = bodies.element(offset.add(1));
    const local = attribute<"vec3">("position", "vec3");
    const t = cross(q.xyz, local).mul(2);
    const solverPoint = local.add(t.mul(q.w)).add(cross(q.xyz, t)).add(bodies.element(offset).xyz);
    const material = surface(color);
    material.positionNode = vec3(solverPoint.x, solverPoint.z, solverPoint.y.negate());
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    // The CPU bind pose cannot bound a deformed GPU mesh.
    mesh.frustumCulled = false;
    group.add(mesh);
  };
  let offset = 0;
  for (const patch of input.patches) {
    const count = patch.columns * patch.rows;
    const geometry = patchGeometry(patch);
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute(model.localPositions.slice(offset * 3, (offset + count) * 3), 3),
    );
    bind(
      geometry,
      model.bodyIndices.slice(offset, offset + count),
      patch.name === "sail" ? 0xe4c592 : 0x5bbdb6,
      patch.name,
    );
    offset += count;
  }
  for (const rope of input.ropes) {
    const cylinder = new CylinderGeometry(
      0.0125,
      0.0125,
      Math.hypot(...rope.end.map((v, i) => v - requiredAt(rope.start, i))) / rope.segments,
      6,
    )
      .rotateZ(-Math.PI / 2)
      .toNonIndexed();
    const source = cylinder.getAttribute("position");
    const positions = new Float32Array(source.count * rope.segments * 3);
    const ids = new Uint32Array(source.count * rope.segments);
    for (let segment = 0; segment < rope.segments; segment++) {
      positions.set(source.array, segment * source.count * 3);
      ids.fill(
        requiredAt(model.bodyIndices, offset + segment),
        segment * source.count,
        (segment + 1) * source.count,
      );
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    cylinder.dispose();
    // A distinct authored hue lets captured pixels prove rope output independently of the stage.
    bind(geometry, ids, 0xd45ef0, rope.name);
    offset += rope.segments + 1;
  }
  return group;
}

export function riggingStage(scene: { background: unknown }): Group {
  scene.background = new Color(0x101c27);
  const group = new Group();
  const floor = new Mesh(new BoxGeometry(12, 0.2, 8), surface(0x273c4b));
  floor.position.set(0, -0.1, 0);
  group.add(floor);
  const beam = new Mesh(new BoxGeometry(7, 0.12, 0.12), surface(0x78909b));
  beam.position.set(0.5, 7.08, 0);
  group.add(beam);
  return group;
}

export function proxyDraw(
  size: [number, number, number],
  position: [number, number, number],
): Mesh {
  const material = surface(0x607585);
  material.wireframe = true;
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.position.set(...position);
  return mesh;
}

export function disposeDraw(group: Object3D): void {
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      material.dispose();
  });
}
