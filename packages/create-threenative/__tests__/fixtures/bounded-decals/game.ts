import {
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from "three";
import type { WebGPURenderer } from "three/webgpu";
import { type ICtx, Scene, baseGeometryOf, defineGame } from "../../../../core/dist/index.js";
import { playtest } from "../../../../core/dist/playtest.js";
import { DecalField, bulletHoleTexture } from "../../../templates/shooter/src/render/decals.js";

type ResidencySample = { renderCalls: number; geometries: number; textures: number; bytes: number };

/** The framework owns the loop: cumulative render calls, not info.frame or fixed ticks, advance. */
export function observeResidency(
  previous: ResidencySample & { stableFrames: number },
  current: ResidencySample,
  ready: boolean,
): void {
  if (!Object.values(current).every((value) => Number.isFinite(value) && value >= 0))
    throw new Error("Decal fixture renderer residency is unavailable.");
  if (!ready) {
    Object.assign(previous, current, { stableFrames: 0 });
    return;
  }
  if (current.renderCalls === previous.renderCalls) return;
  const stable =
    current.geometries === previous.geometries &&
    current.textures === previous.textures &&
    current.bytes === previous.bytes;
  Object.assign(previous, current, { stableFrames: stable ? previous.stableFrames + 1 : 1 });
}

/** Portable, opt-in runtime proof. Neither the shooter entry nor its authored look is changed. */
export function createDecalFixture(hideDecals = false, atlasFade = false, hideDuringFade = false) {
  let generation = 0;
  const residency: (ResidencySample & { generation: number; stableFrames: number })[] = [];
  class DecalRoom extends Scene {
    #source: Object3D | undefined;
    #dispose = () => {};
    #observeRenderedFrame = () => {};

    override async load(ctx: ICtx): Promise<void> {
      const model = await ctx.assets.model<{ scene: Object3D }>("receiver.glb");
      this.#source = model.scene;
    }

    override enter(ctx: ICtx) {
      generation += 1;
      ctx.state.set({ residencyGeneration: 0 });
      const source = this.#source?.getObjectByProperty("isMesh", true);
      if (!(source instanceof Mesh)) throw new Error("Decal fixture receiver did not load.");
      const camera = ctx.camera as PerspectiveCamera;
      camera.position.set(0, 4.5, 12);
      camera.lookAt(0, 2.3, 0);
      ctx.scene.background = new Color(0x17232f);
      const materials = [0xc7b493, 0x84a9ad, 0x36485a].map(
        (color) => new MeshStandardMaterial({ color, roughness: 0.9 }),
      );
      const left = source.clone();
      const right = source.clone();
      left.material = materials[0] as MeshStandardMaterial;
      right.material = materials[1] as MeshStandardMaterial;
      left.position.set(-2.5, 2.4, 0);
      right.position.set(2.5, 2.4, 0);
      ctx.add(left);
      ctx.add(right);
      const floorGeometry = new BoxGeometry(15, 0.15, 10);
      const floor = new Mesh(floorGeometry, materials[2]);
      floor.position.y = -0.1;
      ctx.add(floor);
      const sun = new DirectionalLight(0xffefd2, 3);
      sun.position.set(2, 7, 8);
      ctx.add(sun);
      ctx.add(new AmbientLight(0xdbeaff, 1.5));
      let map = bulletHoleTexture(64) as DataTexture;
      if (atlasFade) {
        // A two-cell authored atlas: impact on the left, a solid environment mark on the right.
        // Their different pixel coverage makes selecting the wrong atlas region observable.
        const data = new Uint8Array(128 * 64 * 4);
        const impact = map.image.data;
        if (impact === null) throw new Error("Decal fixture impact pixels are unavailable.");
        for (let y = 0; y < 64; y += 1) {
          for (let x = 0; x < 64; x += 1) {
            const target = (y * 128 + x) * 4;
            data.set(impact.subarray((y * 64 + x) * 4, (y * 64 + x + 1) * 4), target);
            data.set([20, 20, 20, x >= 3 && x < 61 && y >= 3 && y < 61 ? 255 : 0], target + 256);
          }
        }
        map.dispose();
        map = new DataTexture(data, 128, 64, RGBAFormat, UnsignedByteType);
        map.needsUpdate = true;
      }
      const field = new DecalField(ctx.scene, {
        countPerVariant: 256,
        map,
        offset: 0.008,
        size: 0.19,
        tints: { impact: 0xffffff },
      });
      field.settle();
      let created = 0;
      let released = 0;
      const stamp = (receiver: Mesh, x: number, y: number): void => {
        receiver.updateWorldMatrix(true, false);
        const origin = receiver.localToWorld(new Vector3(x, y, 2));
        const direction = new Vector3(0, 0, -1).transformDirection(receiver.matrixWorld);
        const hit = ctx.raycast({
          origin,
          direction,
          targets: receiver,
          exclude: receiver.children,
        });
        if (hit?.object !== receiver || hit.face === null || hit.face === undefined) {
          throw new Error("Decal fixture lost its authored picking surface.");
        }
        const normal = hit.face.normal.clone().transformDirection(receiver.matrixWorld);
        if (
          !field.project(receiver, baseGeometryOf(receiver), hit.point, normal, "impact", {
            depth: 0.1,
            ...(atlasFade
              ? {
                  uvRect: receiver === left ? ([0, 0, 0.5, 1] as const) : ([0.5, 0, 1, 1] as const),
                  fade: { duration: 2, opacity: (progress: number) => 1 - progress },
                }
              : {}),
          })
        ) {
          throw new Error("Decal fixture projection unexpectedly missed.");
        }
        const slot = receiver.children.at(-1);
        if (!(slot instanceof Mesh)) throw new Error("Decal fixture has no projected slot.");
        // Negative control: preserve real picking, projection, allocations and observations,
        // but suppress the material's actual draw. The pixel gate must reject this scene.
        slot.material.visible = !hideDecals;
        created += 1;
        slot.geometry.addEventListener("dispose", () => {
          released += 1;
        });
      };
      for (let hit = 0; hit < 320; hit += 1) {
        const index = Math.floor(hit / 2);
        stamp(
          hit % 2 === 0 ? left : right,
          -1.6 + (index % 16) * 0.213,
          -1.45 + Math.floor(index / 16) * 0.32,
        );
      }
      let moving = false;
      let fading = false;
      let elapsed = 0;
      let frames = 0;
      let motionError = 0;
      let lodHit = false;
      let maxDrawCalls = 0;
      let residencySampled = false;
      const residencyObservation = {
        renderCalls: (ctx.renderer.raw as WebGPURenderer).info.render.calls,
        stableFrames: 0,
        geometries: -1,
        textures: -1,
        bytes: -1,
      };
      let rendered: (ResidencySample & { drawCalls: number; ready: boolean }) | undefined;
      // This fixture has no depth-coupled output: Scene.render runs after its world draw.
      // Capture before Three's Animation callback can reset per-frame draw counters again.
      this.#observeRenderedFrame = () => {
        const info = (ctx.renderer.raw as WebGPURenderer).info;
        if (info.render.calls === residencyObservation.renderCalls) return;
        rendered = {
          renderCalls: info.render.calls,
          drawCalls: info.render.drawCalls,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          bytes: info.memory.total,
          ready:
            lodHit && left.geometry.index?.count === 6 && info.render.drawCalls >= field.capacity,
        };
      };
      const base = baseGeometryOf(left);
      if (base.index?.count !== 384)
        throw new Error("Decal fixture LOD0 must contain 128 triangles.");
      const observation = () => {
        const baseline = residency[1];
        let geometryBytes = 0;
        let active = 0;
        let opacitySum = 0;
        for (const receiver of [left, right]) {
          for (const child of receiver.children) {
            if (!(child instanceof Mesh)) continue;
            active += 1;
            opacitySum += child.material.opacity;
            const geometry: BufferGeometry = child.geometry;
            for (const attribute of Object.values(geometry.attributes)) {
              geometryBytes += attribute.array.byteLength;
            }
            geometryBytes += geometry.index?.array.byteLength ?? 0;
          }
        }
        return {
          generation,
          active,
          capacity: field.capacity,
          created,
          released,
          geometryBytes,
          maxDrawCalls,
          motionError,
          receiverMotion: Math.abs(right.rotation.y) + Math.abs(right.position.y - 2.4),
          lodHit,
          renderTriangles: (left.geometry.index?.count ?? 0) / 3,
          receiverRemoved: right.parent === null,
          atlasFade,
          averageOpacity: active === 0 ? 0 : opacitySum / active,
          residency,
          residencySamples: residency.length,
          stableResidencyFrames: residencyObservation.stableFrames,
          // Compare after the first reset, so one-time renderer startup caches are warmed.
          ...(baseline === undefined
            ? {}
            : {
                geometryGrowth: Math.max(
                  0,
                  ...residency.slice(1).map((sample) => sample.geometries - baseline.geometries),
                ),
                textureGrowth: Math.max(
                  0,
                  ...residency.slice(1).map((sample) => sample.textures - baseline.textures),
                ),
                memoryGrowth: Math.max(
                  0,
                  ...residency.slice(1).map((sample) => sample.bytes - baseline.bytes),
                ),
              }),
        };
      };
      ctx.entities.add("decals", { debug: observation });
      this.#dispose = () => {
        field.dispose();
        map.dispose();
        floorGeometry.dispose();
        for (const material of materials) material.dispose();
      };
      return (frame: ICtx, dt: number) => {
        // Consume only on the next update. Native replays/submits the previous RAF stream
        // before its next timer/mailbox/update iteration; fixed ticks alone cannot advance this.
        if (rendered !== undefined) {
          const { drawCalls, ready, ...sample } = rendered;
          maxDrawCalls = Math.max(maxDrawCalls, drawCalls);
          observeResidency(residencyObservation, sample, ready);
          rendered = undefined;
        }
        if (frame.input.justPressed("motion")) moving = !moving;
        if (frame.input.justPressed("fade")) {
          fading = true;
          // Suppress rendering only after the control has shown its real marks. The opacity
          // curve and owned geometry continue normally, so only positive fade pixels can reject it.
          if (hideDuringFade)
            for (const receiver of [left, right]) {
              for (const child of receiver.children)
                if (child instanceof Mesh) child.material.visible = false;
            }
        }
        if (frame.input.justPressed("remove")) right.removeFromParent();
        if (frame.input.justPressed("reset")) {
          void frame.goto("room");
          return;
        }
        if (moving) {
          elapsed += dt;
          right.rotation.y = Math.sin(elapsed) * 0.5;
          right.position.y = 2.4 + Math.sin(elapsed * 1.5) * 0.35;
        }
        field.update(fading ? dt : 0);
        right.updateWorldMatrix(true, true);
        const mark = right.children[0];
        if (mark instanceof Mesh) {
          const local = new Vector3().fromBufferAttribute(
            mark.geometry.getAttribute("position"),
            0,
          );
          motionError = Math.max(
            motionError,
            mark.localToWorld(local.clone()).distanceTo(right.localToWorld(local)),
          );
        }
        if (!lodHit && left.geometry !== base) {
          stamp(left, 1.7, 1.7);
          lodHit = true;
        }
        frames += 1;
        if (!residencySampled && residencyObservation.stableFrames >= 3) {
          residency.push({
            generation,
            ...residencyObservation,
          });
          // Retain the warm baseline and the latest samples even during manual repeated resets.
          if (residency.length > 8) residency.splice(2, 1);
          residencySampled = true;
          ctx.state.set({ residencyGeneration: generation });
          console.info(`TN_DECAL_FIXTURE:${JSON.stringify(observation())}`);
        }
        // Native exposes state resources, not the browser's component assertion family.
        ctx.state.set({ ...observation(), residencyGeneration: residencySampled ? generation : 0 });
        if (frames % 30 === 0) console.info(`TN_DECAL_FIXTURE:${JSON.stringify(observation())}`);
      };
    }

    override render(): void {
      this.#observeRenderedFrame();
    }

    override exit(): void {
      this.#observeRenderedFrame = () => {};
      this.#dispose();
      this.#dispose = () => {};
    }
  }
  return defineGame({
    camera: { far: 100, fov: 48, near: 0.1, projection: "perspective" },
    display: { maxFps: 60 },
    initialState: { residencyGeneration: 0 },
    input: {
      motion: { keys: ["KeyM"] },
      remove: { keys: ["KeyX"] },
      reset: { keys: ["KeyR"] },
      fade: { keys: ["KeyF"] },
    },
    plugins: [playtest({ holdUntilAttached: true })],
    renderer: { preferWebGPU: true },
    scenes: { room: DecalRoom },
    seed: 11,
    start: "room",
  });
}
