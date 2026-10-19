import {
  type BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  MeshStandardMaterial as StandardMaterial,
  Texture,
} from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { type ICtx, Scene } from "../src/scene.js";

type State = { frames: number };
type Model = { scene: Group };
const names = ["meshopt", "draco"] as const;

/**
 * The renderer's live tally, counting the way three's backends count: a geometry or texture is
 * live from the frame that drew it until its own `dispose` event. Registering on draw rather than
 * on construction is what makes the numbers comparable with `info.memory`, which only grows for
 * something a frame actually uploaded.
 */
class LiveTally {
  readonly geometries = new Set<BufferGeometry>();
  readonly textures = new Set<Texture>();

  /** One frame's draw: every visible geometry and every texture a visible material samples. */
  draw(scene: Object3D): void {
    scene.traverse((object) => {
      if (object.visible !== true) return;
      const mesh = object as Mesh;
      const geometry = mesh.geometry;
      if (geometry !== undefined && !this.geometries.has(geometry)) {
        this.geometries.add(geometry);
        geometry.addEventListener("dispose", () => this.geometries.delete(geometry));
      }
      const material = mesh.material;
      if (material === undefined || material === null) return;
      for (const surface of Array.isArray(material) ? material : [material])
        for (const value of Object.values(surface as unknown as Record<string, unknown>)) {
          if (!isTexture(value) || this.textures.has(value)) continue;
          this.textures.add(value);
          value.addEventListener("dispose", () => this.textures.delete(value));
        }
    });
  }

  /** What is still live, named: the message a failing count has to carry. */
  get live(): string {
    const parts: string[] = [];
    for (const geometry of this.geometries)
      parts.push(`${geometry.name || "geometry"}#${geometry.id}`);
    for (const texture of this.textures) parts.push(`${texture.name || "texture"}#${texture.id}`);
    return parts.join(", ");
  }
}

function isTexture(value: unknown): value is Texture {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { isTexture?: boolean }).isTexture === true
  );
}

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/** The fixture's stage, unchanged in shape: three solid plinths and one textured panel. */
function stage(scene: Object3D, png: Texture): Mesh[] {
  const objects: Mesh[] = [];
  for (const x of [-2.4, 0, 2.4]) {
    const plinth = new Mesh(
      new CylinderGeometry(1.03, 1.1, 0.25, 8),
      new StandardMaterial({ color: 0x263951 }),
    );
    plinth.geometry.name = "plinth";
    plinth.position.x = x;
    scene.add(plinth);
    objects.push(plinth);
  }
  const panel = new Mesh(new PlaneGeometry(1.6, 1.6), new StandardMaterial({ map: png }));
  panel.geometry.name = "panel";
  scene.add(panel);
  objects.push(panel);
  return objects;
}

/** One glb: a group holding a textured mesh, exactly the shape the fixture's models have. */
function fixtureModel(name: string): Model {
  const albedo = new StandardMaterial({ name: `${name}-albedo` });
  const mesh = new Mesh(new PlaneGeometry(1, 1), albedo);
  mesh.geometry.name = `${name}-mesh`;
  const scene = new Group();
  scene.name = name;
  scene.add(mesh);
  return { scene };
}

/** The geometry and every material a stage mesh owns, which is what the game's exit disposes. */
function disposeMesh(mesh: Mesh): void {
  mesh.geometry.dispose();
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    material.dispose();
}

/**
 * The fixture's own scene: two models through `ctx.assets`, a stage the game owns, and an `exit`
 * that releases all of it. `releases: false` is the counter-probe — the same scene with an exit path
 * that forgets — so the guard below is known to see a leak when there is one.
 */
function assetScene(releases: boolean) {
  return class extends Scene<State> {
    static override readonly initialState: State = { frames: 0 };
    #models: Model[] = [];
    #png: Texture | undefined;
    #owned: Mesh[] = [];

    override async load(ctx: ICtx<State>): Promise<void> {
      this.#models = await Promise.all(names.map((name) => ctx.assets.model<Model>(`${name}.glb`)));
      this.#png = await ctx.assets.texture("checker.png", {});
    }

    override enter(ctx: ICtx<State>) {
      if (this.#png === undefined) throw new Error("PNG did not load");
      this.#owned = stage(ctx.scene, this.#png);
      for (const model of this.#models) ctx.add(model.scene);
      let frames = 0;
      return (_ctx: ICtx<State>) => {
        ctx.state.set({ frames: ++frames });
      };
    }

    override exit(ctx: ICtx<State>): void {
      for (const mesh of this.#owned) {
        if (releases) disposeMesh(mesh);
        mesh.removeFromParent();
      }
      this.#owned.length = 0;
      if (releases) this.#png?.dispose();
      this.#png = undefined;
      this.#models.length = 0;
      if (!releases) return;
      for (const name of names) ctx.assets.release("model", `${name}.glb`);
      ctx.assets.release("texture", "checker.png");
    }
  };
}

/** The empty scene the asset scene leaves for, as the lifecycle fixture's `void`. */
class VoidScene extends Scene<State> {
  static override readonly initialState: State = { frames: 0 };
}

/**
 * The real mechanism: a game's scene loads through `ctx.assets`, is entered, is left through
 * `ctx.goto`, and is entered again — three times — with the live tally read on a drawn frame each
 * time. Returns how many geometries and textures the cycles left live.
 */
async function countLiveAcrossCycles(
  releases: boolean,
): Promise<{ geometries: number; textures: number; live: string }> {
  const tally = new LiveTally();
  const canvas = testCanvas();
  let renderFrame: ((time: number) => void) | undefined;
  const requestFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      renderFrame = callback;
      return 1;
    },
  });
  const game = defineGame<State>({
    initialState: { frames: 0 },
    assets: {
      basePath: "/assets",
      model: async (url) => fixtureModel(url.replace(/^.*\//u, "").replace(/\.glb$/u, "")),
      texture: async (url) => {
        const texture = new Texture();
        texture.name = url.replace(/^.*\//u, "");
        return texture;
      },
    },
    renderer: {
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        dispose: () => undefined,
        domElement: canvas,
        render: (scene: Object3D) => {
          tally.draw(scene);
        },
        setSize: () => undefined,
      }),
    },
    scenes: { assets: assetScene(releases), void: VoidScene },
    start: "assets",
  });

  const draw = (): void => {
    if (renderFrame === undefined) throw new Error("Game did not schedule a frame.");
    renderFrame(16);
  };

  try {
    await game.start();
    draw();
    const baseline = { geometries: tally.geometries.size, textures: tally.textures.size };
    // Leaving must not wait for the next frame's reconcile: every tally below is taken on a drawn
    // frame, so anything the exit path drops only is gone by the time the next enter draws.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await game.goto("void");
      await game.goto("assets");
      draw();
    }
    return {
      geometries: tally.geometries.size - baseline.geometries,
      textures: tally.textures.size - baseline.textures,
      live: tally.live,
    };
  } finally {
    game.stop();
    if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
  }
}

describe("asset lifetime across a scene change", () => {
  it("leaves no live geometry or texture behind after leave/re-enter cycles", async () => {
    const { live, ...growth } = await countLiveAcrossCycles(true);

    expect(growth, `still live after 3 leave/re-enter cycles: ${live}`).toEqual({
      geometries: 0,
      textures: 0,
    });
  });

  it("sees the growth an exit path that does not release leaves behind", async () => {
    // Without this the guard above could pass by never measuring anything.
    const { live, ...growth } = await countLiveAcrossCycles(false);

    expect(growth, `still live after 3 leave/re-enter cycles: ${live}`).toEqual({
      geometries: 12,
      textures: 3,
    });
  });
});
