import {
  BoxGeometry,
  type Camera,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  type Vector2,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
import { vec2 } from "three/tsl";
import { describe, expect, it, vi } from "vitest";
import { WaterSurface3D } from "../src/water-surface.js";

const reflection = { resolutionScale: 0.5 } as const;

function isNode(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && (value as { isNode?: boolean }).isNode === true
  );
}

describe("WaterSurface3D", () => {
  it("rejects malformed options rather than defaulting them", () => {
    expect(
      () => new WaterSurface3D(undefined as unknown as { level: number; maxThickness: number }),
    ).toThrow(/requires options/u);
    expect(() => new WaterSurface3D({ level: Number.NaN, maxThickness: 2 })).toThrow(/level/u);
    expect(() => new WaterSurface3D({ level: 0, maxThickness: 0 })).toThrow(/maxThickness/u);
    expect(() => new WaterSurface3D({ level: 0, maxThickness: -1 })).toThrow(/maxThickness/u);
    expect(
      () => new WaterSurface3D({ level: 0, maxThickness: 2, reflection: { resolutionScale: 0 } }),
    ).toThrow(/resolutionScale/u);
    expect(
      () => new WaterSurface3D({ level: 0, maxThickness: 2, reflection: { resolutionScale: 1.5 } }),
    ).toThrow(/resolutionScale/u);
  });

  it("draws only the named layers in the mirrored pass, preserving explicit overrides", () => {
    // A reflection is a second draw of the world. `resolutionScale` decides how many pixels that
    // costs; this decides how much world, which on a crowded scene is the whole bill.
    const mask = (1 << 0) | (1 << 3);
    const surface = new WaterSurface3D({
      level: 0,
      maxThickness: 3,
      reflection: { ...reflection, layers: mask },
    });
    expect(surface.reflectionLayers).toBe(mask);

    const camera = new PerspectiveCamera();
    camera.layers.enableAll();
    expect(surface.reflectionCameraFor(camera)?.layers.mask).toBe(mask);
    // The same scene camera asked for twice is the same masked pass camera, not a fresh unmasked one.
    expect(surface.reflectionCameraFor(camera)?.layers.mask).toBe(mask);

    // Omitted masks use automatic object filtering while retaining the source camera layers.
    const plain = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    const source = new PerspectiveCamera();
    source.layers.set(5);
    expect(plain.reflectionLayers).toBeUndefined();
    expect(plain.reflectionCameraFor(source)?.layers.mask).toBe(source.layers.mask);

    // A surface with no reflection has no pass and says so rather than inventing a camera.
    expect(
      new WaterSurface3D({ level: 0, maxThickness: 3 }).reflectionCameraFor(camera),
    ).toBeUndefined();
  });

  it("refuses a layer mask that is not a non-negative integer", () => {
    for (const layers of [-1, 1.5, Number.NaN]) {
      expect(
        () =>
          new WaterSurface3D({ level: 0, maxThickness: 3, reflection: { ...reflection, layers } }),
      ).toThrow(/layers/u);
    }
  });

  it("puts the mirror plane at the water level facing up, and keeps it out of the scene graph", () => {
    const surface = new WaterSurface3D({ level: 12.5, maxThickness: 3, reflection });
    const target = surface.target;
    if (target === undefined) throw new Error("reflection target missing");

    // A water level is a world fact. Parenting the mirror to a scaled or rotated mesh — three's
    // own example does — skews the plane; this target belongs to no parent at all.
    expect(target.parent).toBeNull();
    expect(target.matrixWorld.elements[13]).toBeCloseTo(12.5, 6);
    const worldPosition = new Vector3().setFromMatrixPosition(target.matrixWorld);
    expect(worldPosition.y).toBeCloseTo(12.5, 6);

    // The reflector mirrors about the target's local +Z, so that axis has to be world up.
    const facing = new Vector3(0, 0, 1)
      .applyQuaternion(new Quaternion().setFromRotationMatrix(target.matrixWorld))
      .normalize();
    expect(facing.x).toBeCloseTo(0, 5);
    expect(facing.y).toBeCloseTo(1, 5);
    expect(facing.z).toBeCloseTo(0, 5);

    surface.setLevel(-4.25);
    expect(surface.level).toBe(-4.25);
    expect(new Vector3().setFromMatrixPosition(target.matrixWorld).y).toBeCloseTo(-4.25, 6);
    expect(() => surface.setLevel(Number.POSITIVE_INFINITY)).toThrow(/level/u);
  });

  it("refuses to move once released, and releases only once", () => {
    const surface = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    surface.dispose();
    expect(surface.released).toBe(true);
    surface.dispose();
    expect(() => surface.setLevel(2)).toThrow(/released/u);
  });

  it("has no reflection to hand out when none was asked for", () => {
    const surface = new WaterSurface3D({ level: 0, maxThickness: 3 });
    expect(surface.target).toBeUndefined();
    expect(() => surface.reflectionAt()).toThrow(/without reflection/u);
    // The two readings that need no second pass still work.
    expect(isNode(surface.refractionAt())).toBe(true);
    expect(isNode(surface.thicknessAt())).toBe(true);
  });

  it("returns nodes for every reading, offset or not", () => {
    const surface = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    const offset = vec2(0.01, -0.02);
    for (const node of [
      surface.reflectionAt(),
      surface.reflectionAt(offset),
      surface.refractionAt(),
      surface.refractionAt(offset),
      surface.thicknessAt(),
      surface.thicknessAt(offset),
    ])
      expect(isNode(node)).toBe(true);
  });
});

/**
 * `IWaterReflectionOptions.refreshInterval` is how often the mirrored pass redraws. It is the whole
 * render that costs, not the binding between renders, so skipping the pass on the frames between
 * leaves the previous target bound and the material sampling it. The default — no interval — is
 * today's behaviour: a redraw on every update.
 */
describe("WaterSurface3D reflection refresh interval", () => {
  interface IReflectorPass {
    updateBefore(frame: {
      scene: Scene;
      camera: Camera;
      renderer: IStubRenderer;
      material: { visible: boolean };
    }): void;
  }

  interface IStubRenderer {
    autoClear: boolean;
    coordinateSystem: number;
    getDrawingBufferSize(target: Vector2): Vector2;
    getMRT(): null;
    getRenderTarget(): null;
    setMRT(mrt: unknown): void;
    setRenderTarget(target: unknown): void;
    clear(): void;
    render(scene: Scene, camera: Camera): void;
  }

  function stubRenderer(renders: Camera[]): IStubRenderer {
    return {
      autoClear: true,
      coordinateSystem: WebGPUCoordinateSystem,
      getDrawingBufferSize: (target: Vector2): Vector2 => target.set(960, 540),
      getMRT: (): null => null,
      getRenderTarget: (): null => null,
      setMRT: (_mrt: unknown): void => {},
      setRenderTarget: (_target: unknown): void => {},
      clear: (): void => {},
      render: (_scene: Scene, camera: Camera): void => {
        renders.push(camera);
      },
    };
  }

  function passOf(surface: WaterSurface3D): IReflectorPass {
    const split = surface.reflectionAt() as unknown as {
      node: { _reflectorBaseNode: IReflectorPass };
    };
    return split.node._reflectorBaseNode;
  }

  /** The render target texture the material samples right now. */
  function boundTexture(surface: WaterSurface3D): unknown {
    return (surface.reflectionAt() as unknown as { node: { value: unknown } }).node.value;
  }

  function sceneCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(50, 1, 0.5, 8000);
    camera.position.set(0, 20, 60);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    return camera;
  }

  function drive(pass: IReflectorPass, camera: PerspectiveCamera, renders: Camera[]): void {
    pass.updateBefore({
      scene: new Scene(),
      camera,
      renderer: stubRenderer(renders),
      material: { visible: true },
    });
  }

  it("redraws every update when no interval is named — today's behaviour", () => {
    const surface = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    const pass = passOf(surface);
    const camera = sceneCamera();
    const renders: Camera[] = [];
    for (let i = 0; i < 4; i += 1) drive(pass, camera, renders);
    expect(renders).toHaveLength(4);
  });

  it("skips the render between refreshes and keeps sampling the previous target", () => {
    const surface = new WaterSurface3D({
      level: 0,
      maxThickness: 3,
      reflection: { ...reflection, refreshInterval: 2 },
    });
    expect(surface.reflectionRefreshInterval).toBe(2);
    const pass = passOf(surface);
    const camera = sceneCamera();
    const renders: Camera[] = [];

    drive(pass, camera, renders); // call 0 — render
    const first = boundTexture(surface);
    expect(first).toBeDefined();

    drive(pass, camera, renders); // call 1 — skipped
    expect(renders).toHaveLength(1);
    expect(boundTexture(surface)).toBe(first);

    drive(pass, camera, renders); // call 2 — render
    drive(pass, camera, renders); // call 3 — skipped
    expect(renders).toHaveLength(2);
  });

  it("still refreshes while the camera moves, on the interval's schedule", () => {
    const surface = new WaterSurface3D({
      level: 0,
      maxThickness: 3,
      reflection: { ...reflection, refreshInterval: 3 },
    });
    const pass = passOf(surface);
    const renders: Camera[] = [];
    for (let i = 0; i < 7; i += 1) {
      const camera = sceneCamera();
      camera.position.x = i * 5;
      camera.updateMatrixWorld();
      drive(pass, camera, renders); // calls 0, 3 and 6 render; the rest skip
    }
    expect(renders).toHaveLength(3);
    // The last redraw was taken from the camera presented at call 6, not a stale one: the virtual
    // camera is that camera mirrored through the water plane.
    const last = renders.at(-1);
    if (last === undefined) throw new Error("no reflection render");
    expect(last.position.x).toBeCloseTo(30, 5);
    expect(last.position.y).toBeCloseTo(-20, 5);
  });

  it("automatically reflects terrain and large casters while omitting instanced props", () => {
    const surface = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    const scene = new Scene();
    const material = new MeshBasicMaterial();
    const terrain = new Mesh(new BoxGeometry(200, 1, 200), material);
    const hills = new Mesh(new BoxGeometry(50, 12, 50), material);
    const cliff = new Mesh(new BoxGeometry(20, 40, 20), material);
    cliff.castShadow = true;
    const prop = new Mesh(new BoxGeometry(1, 1, 1), material);
    prop.castShadow = true;
    const forest = new InstancedMesh(new BoxGeometry(1, 15, 1), material, 3200);
    forest.castShadow = true;
    const hidden = new Mesh(new BoxGeometry(100, 1, 100), material);
    hidden.visible = false;
    scene.add(terrain, hills, cliff, prop, forest, hidden);
    scene.updateMatrixWorld(true);
    const seen: Mesh[][] = [];
    const renderer = stubRenderer([]);
    renderer.render = () => {
      seen.push(
        scene.children.filter(
          (node) => node.visible && node.layers.test(frame.camera.layers),
        ) as Mesh[],
      );
    };
    const warning = vi.spyOn(console, "info").mockImplementation(() => {});
    const frame = { scene, camera: sceneCamera(), renderer, material: { visible: true } };
    passOf(surface).updateBefore(frame);
    passOf(surface).updateBefore(frame);
    expect(seen).toEqual([
      [terrain, hills, cliff],
      [terrain, hills, cliff],
    ]);
    expect([terrain.visible, cliff.visible, prop.visible, forest.visible, hidden.visible]).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(
      warning.mock.calls.filter(([line]) => String(line).includes("TN_WATER_REFLECTION_DEFAULT")),
    ).toHaveLength(1);
    warning.mockRestore();
  });

  it("explicit layers bypass automatic filtering and failed mirror renders restore visibility", () => {
    const scene = new Scene();
    const prop = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 10);
    scene.add(prop);
    scene.updateMatrixWorld(true);
    const renderer = stubRenderer([]);
    const explicit = new WaterSurface3D({
      level: 0,
      maxThickness: 3,
      reflection: { ...reflection, layers: 1 },
    });
    renderer.render = () => {
      expect(prop.visible).toBe(true);
    };
    passOf(explicit).updateBefore({
      scene,
      camera: sceneCamera(),
      renderer,
      material: { visible: true },
    });
    const automatic = new WaterSurface3D({ level: 0, maxThickness: 3, reflection });
    renderer.render = () => {
      expect(prop.layers.mask).toBe(0);
      throw new Error("mirror failed");
    };
    expect(() =>
      passOf(automatic).updateBefore({
        scene,
        camera: sceneCamera(),
        renderer,
        material: { visible: true },
      }),
    ).toThrow("mirror failed");
    expect(prop.visible).toBe(true);
    expect(prop.layers.mask).toBe(1);
  });

  it("refuses an interval that is not a positive integer", () => {
    for (const refreshInterval of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new WaterSurface3D({
            level: 0,
            maxThickness: 3,
            reflection: { ...reflection, refreshInterval },
          }),
      ).toThrow(/refreshInterval/u);
    }
  });
});
