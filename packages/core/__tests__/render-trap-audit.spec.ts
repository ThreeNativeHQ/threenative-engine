import {
  CubeTexture,
  DataTexture,
  EquirectangularReflectionMapping,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
} from "three";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_TOO_SMALL_MARKER,
  OPACITY_IGNORED_MARKER,
  renderTrapAudit,
} from "../src/profiling/render-trap-audit.js";

function environment(width: number): DataTexture {
  const texture = new DataTexture(new Uint8Array(width * 65 * 4), width, 65);
  texture.mapping = EquirectangularReflectionMapping;
  return texture;
}

describe("renderTrapAudit", () => {
  it("reports an 8 px environment with its fix", () => {
    const scene = new Scene();
    scene.environment = environment(8);
    expect(renderTrapAudit(scene)).toEqual([
      expect.stringContaining(`${ENVIRONMENT_TOO_SMALL_MARKER}:`),
    ]);
    expect(renderTrapAudit(scene)[0]).toContain("64 pixels");
  });

  it("accepts the 64 px PMREM boundary", () => {
    const scene = new Scene();
    scene.environment = environment(64);
    expect(renderTrapAudit(scene)).toEqual([]);
  });

  it.each([null, new CubeTexture()])("ignores null/cube environments (%s)", (texture) => {
    const scene = new Scene();
    scene.environment = texture;
    expect(renderTrapAudit(scene)).toEqual([]);
  });

  it.each([
    new Mesh(undefined, new MeshBasicMaterial({ opacity: 0.5 })),
    new Points(undefined, new PointsMaterial({ opacity: 0.5 })),
    new Line(undefined, new LineBasicMaterial({ opacity: 0.5 })),
    new Sprite(new SpriteMaterial({ opacity: 0.5, transparent: false })),
  ])("reports ignored opacity on each drawable kind (%s)", (object) => {
    const scene = new Scene();
    scene.add(object);
    const lines = renderTrapAudit(scene);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(OPACITY_IGNORED_MARKER);
    expect(lines[0]).toContain("transparent: true");
  });

  it.each([
    { opacity: 0.5, transparent: true },
    { opacity: 0.5, alphaHash: true },
    { opacity: 1 },
    { opacity: 0.5, visible: false },
  ])("accepts materials that do not draw ignored opacity (%j)", (parameters) => {
    const scene = new Scene();
    scene.add(new Mesh(undefined, new MeshBasicMaterial(parameters)));
    expect(renderTrapAudit(scene)).toEqual([]);
  });

  it("prunes invisible meshes and subtrees", () => {
    const scene = new Scene();
    const mesh = new Mesh(undefined, new MeshBasicMaterial({ opacity: 0.5 }));
    mesh.visible = false;
    scene.add(mesh);
    const group = new Group();
    group.visible = false;
    group.add(new Mesh(undefined, new MeshBasicMaterial({ opacity: 0.5 })));
    scene.add(group);
    expect(renderTrapAudit(scene)).toEqual([]);
  });

  it("dedupes materials, handles arrays, and caps examples at five", () => {
    const scene = new Scene();
    const materials = Array.from(
      { length: 9 },
      (_, index) => new MeshBasicMaterial({ name: `water-${index}`, opacity: 0.5 }),
    );
    scene.add(new Mesh(undefined, materials), new Mesh(undefined, materials));
    const line = renderTrapAudit(scene)[0];
    expect(line).toContain('"materials":9');
    for (let index = 0; index < 5; index++) expect(line).toContain(`water-${index}`);
    expect(line).not.toContain("water-5");
  });

  it("reads structural Node materials and uses their type when unnamed", () => {
    const scene = new Scene();
    const mesh = new Mesh();
    mesh.material = { opacity: 0.5, type: "MeshBasicNodeMaterial" } as MeshBasicMaterial;
    scene.add(mesh);
    expect(renderTrapAudit(scene)[0]).toContain("MeshBasicNodeMaterial");
  });

  it("reports both traps in one audit", () => {
    const scene = new Scene();
    scene.environment = environment(8);
    scene.add(new Mesh(undefined, new MeshBasicMaterial({ opacity: 0.5 })));
    expect(renderTrapAudit(scene)).toHaveLength(2);
  });
});
