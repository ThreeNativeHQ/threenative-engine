import { BoxGeometry, type BufferGeometry, Group, Mesh, type MeshStandardMaterial } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type XYZ = [number, number, number];

export class StaticKitMesh<Finish extends string> {
  private readonly parts = new Map<Finish, BufferGeometry[]>();

  block(finish: Finish, size: XYZ, center: XYZ, bevel = 0.035, tilt = 0): void {
    const shape =
      bevel > 0.018 ? new RoundedBoxGeometry(...size, 1, bevel) : new BoxGeometry(...size);
    if (tilt) shape.rotateZ(tilt);
    shape.translate(...center);
    this.add(finish, shape);
  }

  add(finish: Finish, shape: BufferGeometry): void {
    const geometry = shape.index ? shape.toNonIndexed() : shape;
    if (geometry !== shape) shape.dispose();
    const bucket = this.parts.get(finish);
    if (bucket) bucket.push(geometry);
    else this.parts.set(finish, [geometry]);
  }

  finish(name: string, materials: Record<Finish, MeshStandardMaterial>): Group {
    const group = new Group();
    group.name = name;
    for (const [finish, shapes] of this.parts) {
      const geometry = mergeGeometries(shapes);
      for (const shape of shapes) shape.dispose();
      if (!geometry) throw new Error(`Could not merge ${name} ${finish}`);
      const mesh = new Mesh(geometry, materials[finish]);
      mesh.name = materials[finish].name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}
