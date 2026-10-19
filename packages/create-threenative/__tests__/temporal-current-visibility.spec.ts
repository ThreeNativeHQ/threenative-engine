import {
  Bone,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Fog,
  FogExp2,
  InstancedMesh,
  Material,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { context, vec4, velocity } from "three/tsl";
import {
  BundleGroup,
  ClippingGroup,
  type Node,
  WGSLNodeBuilder,
  WebGPURenderer,
} from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import {
  VelocityTracker,
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
} from "../../core/src/render/velocity.js";
import {
  currentVisibilityEligible,
  currentVisibilityMaterial,
} from "../templates/starter/src/render/temporalCurrentVisibility.js";

function renderer() {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(renderer.backend, "renderer", renderer);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65536,
  );
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  return renderer;
}

describe("matched cheap visibility material", () => {
  it("keeps ordinary standard PBR at pixel frequency and retains frozen instance/skin vertex paths", () => {
    const r = renderer();
    const camera = new PerspectiveCamera();
    const scene = new Scene();
    const tracker = new VelocityTracker();
    const source = new MeshStandardMaterial();
    const geometry = new PlaneGeometry();
    geometry.setAttribute(
      "skinIndex",
      new Uint16BufferAttribute(
        new Uint16Array(defined(geometry.attributes.position).count * 4),
        4,
      ),
    );
    const weights = new Float32Array(defined(geometry.attributes.position).count * 4);
    for (let i = 0; i < weights.length; i += 4) weights[i] = 1;
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    const skin = new SkinnedMesh(geometry, source);
    const bone = new Bone();
    skin.add(bone);
    skin.bind(new Skeleton([bone]));
    const instance = new InstancedMesh(new PlaneGeometry(), source, 2);
    scene.add(skin, instance);
    tracker.update(scene);
    const frozenBones = readVelocityPreviousBoneMatrices(skin);
    const frozenInstances = readVelocityPreviousMatrices(instance);
    const build = (object: Mesh, material: Material, policy: Record<string, unknown>) => {
      object.material = material;
      r.contextNode = context(policy);
      const b = new WGSLNodeBuilder(object, r) as WGSLNodeBuilder & {
        build(): void;
        vertexShader: string;
        fragmentShader: string;
      };
      Reflect.set(b, "camera", camera);
      Reflect.set(b, "scene", scene);
      b.build();
      return b;
    };
    try {
      expect(currentVisibilityEligible(scene)).toBe(true);
      for (const object of [instance, skin]) {
        const beauty = build(object, source, {
          invariantPosition: true,
          sampleInterpolation: (material: Material) => material.alphaTest > 0,
        });
        expect(beauty.fragmentShader).toMatch(/roughness/i);
        expect(beauty.fragmentShader).toMatch(/metalness/i);
        expect(beauty.fragmentShader).not.toContain(", sample )");
        const replay = currentVisibilityMaterial(r, source, velocity as unknown as Node<"vec2">);
        const cheap = build(object, replay, { invariantPosition: true, sampleInterpolation: true });
        for (const b of [beauty, cheap])
          expect(b.vertexShader).toContain("@invariant @builtin( position )");
        expect(cheap.vertexShader).toContain("positionPrevious");
        expect(cheap.fragmentShader).not.toMatch(/roughness/i);
        if (object === instance) {
          for (const b of [beauty, cheap]) {
            const arrays = Reflect.get(b, "bufferAttributes").map(
              (attribute: { node: { value: { array: Float32Array } } }) =>
                attribute.node.value.array,
            );
            expect(arrays).toContain(instance.instanceMatrix.array);
            expect(new Set(arrays).size).toBeGreaterThanOrEqual(2);
          }
        } else {
          expect(beauty.vertexShader).toContain("skinWeight");
          expect(cheap.vertexShader).toContain("skinWeight");
        }
        object.material = source;
        replay.dispose();
      }
      expect(readVelocityPreviousBoneMatrices(skin)).toBe(frozenBones);
      expect(readVelocityPreviousMatrices(instance)).toBe(frozenInstances);
    } finally {
      skin.material = source;
      instance.material = source;
      tracker.clear();
      source.dispose();
      geometry.dispose();
      instance.geometry.dispose();
    }
  });

  it("declines clipping bundles and unscheduled morph/displacement while retaining ordinary/empty controls", () => {
    const scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(), new MeshStandardMaterial());
    const group = new ClippingGroup();
    scene.add(group);
    group.add(mesh);
    Reflect.set(
      mesh,
      Symbol.for("threenative.velocity.previousWorldMatrix"),
      mesh.matrixWorld.clone(),
    );
    expect(currentVisibilityEligible(scene)).toBe(true);
    for (const field of ["onBeforeShadow", "onAfterShadow"] as const) {
      const ordinary = mesh[field];
      mesh[field] = () => {
        mesh.position.x += 1;
      };
      expect(currentVisibilityEligible(scene), field).toBe(false);
      mesh[field] = ordinary;
      expect(currentVisibilityEligible(scene)).toBe(true);
    }
    group.clippingPlanes = [new Plane(new Vector3(1, 0, 0), 0)];
    expect(currentVisibilityEligible(scene)).toBe(false);
    group.enabled = false;
    expect(currentVisibilityEligible(scene)).toBe(true);
    group.enabled = true;
    group.clippingPlanes = [];
    const bundle = new BundleGroup();
    scene.add(bundle);
    expect(currentVisibilityEligible(scene)).toBe(false);
    scene.remove(bundle);
    mesh.material.displacementMap = new DataTexture();
    expect(currentVisibilityEligible(scene)).toBe(false);
    mesh.material.displacementMap = null;
    mesh.geometry.morphAttributes.position = [defined(mesh.geometry.attributes.position).clone()];
    expect(currentVisibilityEligible(scene)).toBe(false);
    mesh.geometry.morphAttributes = {};
    expect(currentVisibilityEligible(scene)).toBe(true);
    for (const field of [
      "fragmentNode",
      "vertexNode",
      "positionNode",
      "depthNode",
      "maskNode",
      "outputNode",
      "mrtNode",
      "alphaTestNode",
      "opacityNode",
    ]) {
      Reflect.set(mesh.material, field, vec4(0));
      expect(currentVisibilityEligible(scene)).toBe(false);
      Reflect.deleteProperty(mesh.material, field);
    }
    expect(currentVisibilityEligible(scene)).toBe(true);
    for (const field of ["fogNode", "environmentNode", "backgroundNode", "customNode"]) {
      Reflect.set(scene, field, vec4(0));
      expect(currentVisibilityEligible(scene), field).toBe(false);
      Reflect.deleteProperty(scene, field);
    }
    const light = new DirectionalLight();
    scene.add(light);
    for (const [owner, field] of [
      [light, "colorNode"],
      [light.shadow, "shadowNode"],
      [light.shadow, "biasNode"],
      [light.shadow, "filterNode"],
    ] as const) {
      Reflect.set(owner, field, vec4(0));
      expect(currentVisibilityEligible(scene), field).toBe(false);
      Reflect.deleteProperty(owner, field);
    }
    scene.fog = new Fog(0, 1, 5);
    scene.environment = new DataTexture();
    expect(currentVisibilityEligible(scene)).toBe(true);
    scene.fog = new FogExp2(0);
    expect(currentVisibilityEligible(scene)).toBe(true);
    scene.background = new DataTexture();
    expect(currentVisibilityEligible(scene)).toBe(false);
  });
  it("retains the original standard material's alpha/depth/vertex path while omitting PBR lighting", () => {
    const r = renderer();
    const source = new MeshStandardMaterial({
      map: new DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1),
      alphaTest: 0.5,
    });
    source.depthFunc = 3;
    source.polygonOffset = true;
    source.polygonOffsetFactor = 2;
    const replay = currentVisibilityMaterial(r, source, velocity as unknown as Node<"vec2">);
    r.contextNode = context({ invariantPosition: true, sampleInterpolation: true });
    const builder = new WGSLNodeBuilder(
      new Mesh(new PlaneGeometry(), replay),
      r,
    ) as WGSLNodeBuilder & { build(): void; vertexShader: string; fragmentShader: string };
    Reflect.set(builder, "camera", new PerspectiveCamera());
    Reflect.set(builder, "scene", new Scene());
    builder.build();
    expect(Reflect.get(replay, "map")).toBe(source.map);
    expect(replay.alphaTest).toBe(source.alphaTest);
    expect(replay.depthFunc).toBe(source.depthFunc);
    expect(replay.polygonOffsetFactor).toBe(2);
    expect(builder.fragmentShader).toContain("discard");
    expect(builder.fragmentShader).toContain("@interpolate( perspective, sample )");
    expect(builder.vertexShader).toContain("@invariant @builtin( position )");
    expect(builder.fragmentShader).not.toContain("roughness");
    expect(builder.fragmentShader).not.toContain("metalness");
    expect(source.onBeforeCompile).toBe(Material.prototype.onBeforeCompile);
    expect(Reflect.get(source, "outputNode")).toBeUndefined();
  });

  it("declines transparent, custom, hashed, A2C and unfrozen motion inputs", () => {
    const scene = new Scene();
    const mesh = new Mesh(new PlaneGeometry(), new MeshStandardMaterial());
    scene.add(mesh);
    const previous = Symbol.for("threenative.velocity.previousWorldMatrix");
    expect(currentVisibilityEligible(scene)).toBe(false);
    Reflect.set(mesh, previous, mesh.matrixWorld.clone());
    expect(currentVisibilityEligible(scene)).toBe(true);
    for (const field of ["transparent", "alphaHash", "alphaToCoverage"] as const) {
      mesh.material[field] = true;
      expect(currentVisibilityEligible(scene)).toBe(false);
      mesh.material[field] = false;
    }
    mesh.onBeforeRender = () => {};
    expect(currentVisibilityEligible(scene)).toBe(false);
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Missing test fixture value.");
  return value;
}
