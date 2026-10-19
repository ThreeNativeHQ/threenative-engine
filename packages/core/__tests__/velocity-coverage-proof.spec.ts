import {
  Bone,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { type Node, NodeFrame, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  velocityCoverageNode,
  velocityFixturePositions,
  velocityFixtureRadius,
} from "../../../examples/abyss-framework/src/render/velocityCoverage.js";

interface ICoverageBuilder extends WGSLNodeBuilder {
  setShaderStage(stage: string): void;
  flowStagesNode(node: Node, output: string): { code: string; result: string };
  buildUpdateNodes(): void;
  nodes: Set<Node>;
  updateNodes: Node[];
}

describe("velocity fixture coverage identity", () => {
  it("compiles binary coverage from actual object identity and fragment position, without shading or history", () => {
    const moving = new Mesh(new SphereGeometry(velocityFixtureRadius), new MeshBasicMaterial());
    const wall = new Mesh();
    const builder = new WGSLNodeBuilder(moving, { backend: {} } as never) as ICoverageBuilder;
    builder.setShaderStage("fragment");
    const shader = builder.flowStagesNode(velocityCoverageNode(moving, 960), "vec4");
    builder.buildUpdateNodes();
    expect(shader.result).toContain("480.0");
    expect(shader.result).toMatch(/fragCoord\.xy\.x/);
    expect(shader.code + shader.result).not.toMatch(
      /positionPrevious|diffuseColor|normal|bone|textureSample/,
    );
    const objectId = [...builder.nodes].find(
      (node) => Reflect.get(node, "name") === "velocityFixtureObject",
    );
    if (objectId === undefined) throw new Error("Compiled object coverage uniform missing.");
    const frame = new NodeFrame();
    for (const object of [moving, wall, moving]) {
      frame.object = object;
      frame.updateNode(objectId);
      expect(Reflect.get(objectId, "value")).toBe(object === moving ? 1 : 0);
    }
  });

  it("keeps every authored moving sphere vertex right of the coverage split for bone and root motion", () => {
    const geometry = new SphereGeometry(velocityFixtureRadius, 32, 24);
    const positions = geometry.getAttribute("position");
    geometry.setAttribute(
      "skinIndex",
      new Uint16BufferAttribute(new Uint16Array(positions.count * 4), 4),
    );
    const weights = new Float32Array(positions.count * 4);
    for (let index = 0; index < positions.count; index += 1) weights[index * 4] = 1;
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    const camera = new OrthographicCamera(-3, 3, 3.375, -3.375, 0.1, 20);
    camera.position.z = 8;
    camera.updateMatrixWorld();
    for (const rootMotion of [false, true]) {
      const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
      const bone = new Bone();
      mesh.position.x = 1.5;
      mesh.add(bone);
      mesh.bind(new Skeleton([bone]));
      for (const x of velocityFixturePositions) {
        if (rootMotion) mesh.position.x = x;
        else bone.position.x = x - 1.5;
        mesh.updateMatrixWorld(true);
        for (let index = 0; index < positions.count; index += 1) {
          const vertex = new Vector3().fromBufferAttribute(positions, index);
          const moving = mesh
            .applyBoneTransform(index, vertex.clone())
            .applyMatrix4(mesh.matrixWorld)
            .project(camera);
          const still = vertex.add(new Vector3(-1.5, 0, 0)).project(camera);
          expect(moving.x).toBeGreaterThan(0);
          expect(still.x).toBeLessThan(0);
        }
      }
    }
    // Every sphere triangle is inside the convex half-plane containing all its vertices.
  });
});
