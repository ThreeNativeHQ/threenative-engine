// Ported from three.js r185 (three@0.185.1). The MIT License, Copyright © 2010-2026 three.js authors.
/**
 * `three/addons/geometries/DecalGeometry.js` over the classes `T` names: three's own clipping
 * algorithm, for both back ends. The upstream file is plain JavaScript over those classes, but a
 * published addon cannot enter the native bundle, so the port lives here and says nothing different.
 * decal-geometry.ts binds it to the engine's classes.
 */
import type * as Three from "three";

type Classes = Pick<
  typeof Three,
  "BufferGeometry" | "Euler" | "Float32BufferAttribute" | "Matrix3" | "Matrix4" | "Mesh" | "Vector3"
>;

export function defineDecalGeometry(T: Classes) {
  const { BufferGeometry, Euler, Float32BufferAttribute, Matrix3, Matrix4, Mesh, Vector3 } = T;
  type Vector3 = Three.Vector3;
  type Euler = Three.Euler;
  type Mesh = Three.Mesh;

  /** One vertex of a clipped face: a position, and a normal when the source geometry has them. */
  class DecalVertex {
    constructor(
      public position: Vector3,
      public normal: Vector3 | null = null,
    ) {}

    clone(): DecalVertex {
      return new DecalVertex(
        this.position.clone(),
        this.normal === null ? null : this.normal.clone(),
      );
    }
  }

  /** Where the clip plane `p` (offset `s`) cuts the edge `v0` to `v1`. */
  function clip(v0: DecalVertex, v1: DecalVertex, p: Vector3, s: number): DecalVertex {
    const d0 = v0.position.dot(p) - s;
    const d1 = v1.position.dot(p) - s;
    const s0 = d0 / (d0 - d1);
    const position = new Vector3(
      v0.position.x + s0 * (v1.position.x - v0.position.x),
      v0.position.y + s0 * (v1.position.y - v0.position.y),
      v0.position.z + s0 * (v1.position.z - v0.position.z),
    );
    let normal: Vector3 | null = null;
    if (v0.normal !== null && v1.normal !== null)
      normal = new Vector3(
        v0.normal.x + s0 * (v1.normal.x - v0.normal.x),
        v0.normal.y + s0 * (v1.normal.y - v0.normal.y),
        v0.normal.z + s0 * (v1.normal.z - v0.normal.z),
      );
    return new DecalVertex(position, normal);
  }

  /** Clips every face (three consecutive vertices) against one side of the projector box. */
  // quality-allow: three's own clipping stays in three's shape so the port reads against upstream.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: three's own clipping, kept in three's shape so the port reads against upstream.
  function clipGeometry(inVertices: DecalVertex[], plane: Vector3, size: Vector3): DecalVertex[] {
    const outVertices: DecalVertex[] = [];
    const s = 0.5 * Math.abs(size.dot(plane));
    for (let i = 0; i < inVertices.length; i += 3) {
      const a = inVertices[i] as DecalVertex;
      const b = inVertices[i + 1] as DecalVertex;
      const c = inVertices[i + 2] as DecalVertex;
      const v1Out = a.position.dot(plane) - s > 0;
      const v2Out = b.position.dot(plane) - s > 0;
      const v3Out = c.position.dot(plane) - s > 0;
      const total = (v1Out ? 1 : 0) + (v2Out ? 1 : 0) + (v3Out ? 1 : 0);
      if (total === 0) {
        // The whole face lies inside the plane.
        outVertices.push(a, b, c);
      } else if (total === 1) {
        // One vertex lies outside: the face becomes two.
        let nV1: DecalVertex;
        let nV2: DecalVertex;
        let nV3: DecalVertex;
        let nV4: DecalVertex;
        if (v1Out) {
          nV1 = b;
          nV2 = c;
          nV3 = clip(a, nV1, plane, s);
          nV4 = clip(a, nV2, plane, s);
        } else if (v2Out) {
          nV1 = a;
          nV2 = c;
          nV3 = clip(b, nV1, plane, s);
          nV4 = clip(b, nV2, plane, s);
          outVertices.push(nV3, nV2.clone(), nV1.clone(), nV2.clone(), nV3.clone(), nV4);
          continue;
        } else {
          nV1 = a;
          nV2 = b;
          nV3 = clip(c, nV1, plane, s);
          nV4 = clip(c, nV2, plane, s);
        }
        outVertices.push(nV1.clone(), nV2.clone(), nV3, nV4, nV3.clone(), nV2.clone());
      } else if (total === 2) {
        // Two vertices lie outside: one corner is left.
        if (!v1Out) {
          const nV1 = a.clone();
          outVertices.push(nV1, clip(nV1, b, plane, s), clip(nV1, c, plane, s));
        }
        if (!v2Out) {
          const nV1 = b.clone();
          outVertices.push(nV1, clip(nV1, c, plane, s), clip(nV1, a, plane, s));
        }
        if (!v3Out) {
          const nV1 = c.clone();
          outVertices.push(nV1, clip(nV1, a, plane, s), clip(nV1, b, plane, s));
        }
      }
      // Three outside: the face is dropped.
    }
    return outVertices;
  }

  /**
   * A decal mesh's geometry: `mesh`'s faces clipped to the box a projector at `position` and
   * `orientation` with `size` covers, with uvs across that box.
   */
  class DecalGeometry extends BufferGeometry {
    constructor(
      mesh: Mesh = new Mesh(),
      position: Vector3 = new Vector3(),
      orientation: Euler = new Euler(),
      size: Vector3 = new Vector3(1, 1, 1),
    ) {
      super();
      const vertices: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const plane = new Vector3();
      const normalMatrix = new Matrix3().getNormalMatrix(mesh.matrixWorld);
      // The projector's transformation, and its inverse.
      const projectorMatrix = new Matrix4();
      projectorMatrix.makeRotationFromEuler(orientation);
      projectorMatrix.setPosition(position);
      const projectorMatrixInverse = new Matrix4().copy(projectorMatrix).invert();

      // A vertex, taken to world space and then to projector space.
      const pushDecalVertex = (
        decalVertices: DecalVertex[],
        vertex: Vector3,
        normal?: Vector3,
      ): void => {
        vertex.applyMatrix4(mesh.matrixWorld);
        vertex.applyMatrix4(projectorMatrixInverse);
        if (normal !== undefined) {
          normal.applyNormalMatrix(normalMatrix);
          decalVertices.push(new DecalVertex(vertex.clone(), normal.clone()));
        } else {
          decalVertices.push(new DecalVertex(vertex.clone()));
        }
      };

      // quality-allow: three's own clipping stays in three's shape so the port reads against upstream.
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: three's own clipping, kept in three's shape so the port reads against upstream.
      const generate = (): void => {
        let decalVertices: DecalVertex[] = [];
        const vertex = new Vector3();
        const normal = new Vector3();
        const geometry = mesh.geometry;
        const positionAttribute = geometry.getAttribute("position");
        const normalAttribute = geometry.getAttribute("normal");
        if (!positionAttribute) return; // empty geometry (three throws on an indexed one with no positions)
        // Three consecutive DecalVertex objects are one face: the clipping works on faces.
        if (geometry.index !== null) {
          const index = geometry.index;
          for (let i = 0; i < index.count; i += 1) {
            vertex.fromBufferAttribute(positionAttribute, index.getX(i));
            if (normalAttribute) {
              normal.fromBufferAttribute(normalAttribute, index.getX(i));
              pushDecalVertex(decalVertices, vertex, normal);
            } else {
              pushDecalVertex(decalVertices, vertex);
            }
          }
        } else {
          for (let i = 0; i < positionAttribute.count; i += 1) {
            vertex.fromBufferAttribute(positionAttribute, i);
            if (normalAttribute) {
              normal.fromBufferAttribute(normalAttribute, i);
              pushDecalVertex(decalVertices, vertex, normal);
            } else {
              pushDecalVertex(decalVertices, vertex);
            }
          }
        }
        for (const axis of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ] as const)
          decalVertices = clipGeometry(decalVertices, plane.set(axis[0], axis[1], axis[2]), size);
        for (const decalVertex of decalVertices) {
          // Still in projector space: the uvs span the box, then the vertex goes back to world space.
          uvs.push(0.5 + decalVertex.position.x / size.x, 0.5 + decalVertex.position.y / size.y);
          decalVertex.position.applyMatrix4(projectorMatrix);
          vertices.push(decalVertex.position.x, decalVertex.position.y, decalVertex.position.z);
          if (decalVertex.normal !== null)
            normals.push(decalVertex.normal.x, decalVertex.normal.y, decalVertex.normal.z);
        }
      };

      generate();
      this.setAttribute("position", new Float32BufferAttribute(new Float32Array(vertices), 3));
      this.setAttribute("uv", new Float32BufferAttribute(new Float32Array(uvs), 2));
      if (normals.length > 0)
        this.setAttribute("normal", new Float32BufferAttribute(new Float32Array(normals), 3));
    }
  }

  return { DecalGeometry, DecalVertex };
}
