import {
  ACESFilmicToneMapping,
  AmbientLight,
  BoxGeometry,
  CircleGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector2,
  Vector3,
} from "three";
import { pass } from "three/tsl";
import type { WebGPURenderer } from "three/webgpu";
import { type ICtx, Scene, defineGame } from "../../../../core/dist/index.js";
import { playtest } from "../../../../core/dist/playtest.js";
import { applyExposure } from "../../../template-assets/autoExposure.js";
import { exposureSettings } from "../../../template-assets/exposure.js";
import { WorldEnvironment } from "../../../template-assets/worldEnvironment.js";
import { createFixedExposureRooms } from "./fixedRooms.js";
import { ObservedExposureNode } from "./observedExposure.js";

export interface IExposureFixtureOptions {
  consumer?: boolean;
  enabled: boolean;
  bright: boolean;
  stops: number;
  snapGain: number;
  deterministic?: boolean;
  coldBoot?: boolean;
  cameraCut?: boolean;
  /** "sky": a band over the top 8% of the frame, 10 stops over the room. "disc": a 1% disc, 14 stops. */
  backlit?: "sky" | "disc";
  nativeValidation?: boolean;
  nativeValidationInject?: boolean;
}

/** A flat emissive patch fixed in front of the camera; it lights nothing, so only the meter sees it. */
function createBacklit(
  ctx: ICtx,
  camera: PerspectiveCamera,
  kind: IExposureFixtureOptions["backlit"],
  roomLuminance: number,
) {
  if (kind === undefined) return undefined;
  camera.updateMatrixWorld(true);
  const distance = 20;
  const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
  const aspect = 16 / 9;
  const stops = kind === "sky" ? 10 : 14;
  const material = new MeshBasicMaterial({
    color: new Color(1, 1, 1).multiplyScalar(roomLuminance * 2 ** stops),
    toneMapped: false,
  });
  const geometry =
    kind === "sky"
      ? new PlaneGeometry(height * aspect * 2, height * 0.08)
      : new CircleGeometry(Math.sqrt((0.01 * aspect) / Math.PI) * height, 48);
  const patch = new Mesh(geometry, material);
  const up = kind === "sky" ? height * (0.5 - 0.04) : height * 0.3;
  const right = kind === "sky" ? 0 : height * aspect * 0.25;
  patch.quaternion.copy(camera.quaternion);
  patch.position
    .copy(camera.position)
    .addScaledVector(camera.getWorldDirection(new Vector3()), distance)
    .addScaledVector(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion), up)
    .addScaledVector(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion), right);
  ctx.add(patch);
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Portable scene and engine loop. The browser entry only supplies controls and mounts the canvas. */
export function createExposureFixture(options: IExposureFixtureOptions) {
  class ExposureRoom extends Scene {
    #dispose = () => {};

    override enter(ctx: ICtx) {
      const camera = ctx.camera as PerspectiveCamera;
      camera.position.set(6, 4, 9);
      camera.lookAt(0, 1.2, 0);
      let bright = options.bright;
      const fixedRooms =
        options.cameraCut === true
          ? createFixedExposureRooms(ctx.scene, camera, options.stops)
          : undefined;
      let applyLight = () => {};
      let disposeRoom = () => {};
      if (fixedRooms === undefined) {
        const floor = new BoxGeometry(12, 0.2, 12);
        const block = new BoxGeometry(1, 1, 1);
        const materials = [0x9a9a9a, 0xa34a25, 0x246d95, 0xd9c989].map(
          (color) => new MeshStandardMaterial({ color, roughness: 0.85 }),
        );
        const ground = new Mesh(floor, materials[0]);
        ground.position.y = -0.1;
        ctx.add(ground);
        for (let i = 0; i < 12; i++) {
          const box = new Mesh(block, materials[i % materials.length]);
          box.position.set(
            (i % 4) * 1.8 - 2.7,
            0.5 + Math.floor(i / 4) * 0.2,
            Math.floor(i / 4) * 1.8 - 1.8,
          );
          box.scale.y = 1 + Math.floor(i / 4) * 0.4;
          ctx.add(box);
        }
        const sun = new DirectionalLight(0xfff4df, 1);
        sun.position.set(4, 7, 3);
        const fill = new AmbientLight(0xffffff, 1);
        ctx.add(sun);
        ctx.add(fill);
        applyLight = () => {
          const intensity = 0.01 * (bright ? 2 ** options.stops : 1);
          sun.intensity = intensity * 3;
          fill.intensity = intensity;
          ctx.scene.background = new Color(0x445565).multiplyScalar(intensity);
        };
        applyLight();
        const backlit = createBacklit(
          ctx,
          camera,
          options.backlit,
          options.bright ? 3.896 : 0.0019189,
        );
        disposeRoom = () => {
          backlit?.dispose();
          floor.dispose();
          block.dispose();
          for (const material of materials) material.dispose();
        };
      } else {
        fixedRooms.setPose(bright);
        disposeRoom = () => fixedRooms.dispose();
      }
      const renderer = ctx.renderer.raw as WebGPURenderer;
      const validationDevice =
        options.nativeValidation === true
          ? (
              renderer.backend as typeof renderer.backend & {
                device?: {
                  lost: Promise<{ reason: string; message: string }>;
                  pushErrorScope(filter: "internal" | "out-of-memory" | "validation"): void;
                  popErrorScope(): Promise<{ message: string } | null>;
                  createBuffer(descriptor: { size: number; usage: number }): unknown;
                };
              }
            ).device
          : undefined;
      let activeScene = true;
      let deviceLost = false;
      void validationDevice?.lost.then((info) => {
        if (
          info === undefined ||
          info === null ||
          typeof info.reason !== "string" ||
          typeof info.message !== "string"
        )
          return;
        deviceLost = true;
        console.error(`TN_EXPOSURE_NATIVE_DEVICE_LOST:${info.reason}:${info.message}`);
      });
      const validationScopes = ["internal", "out-of-memory", "validation"] as const;
      if (options.nativeValidation === true && validationDevice === undefined)
        throw new Error("Native exposure GPU validation device is unavailable.");
      for (const scope of validationScopes) validationDevice?.pushErrorScope(scope);
      if (options.nativeValidationInject === true)
        validationDevice?.createBuffer({ size: 4, usage: 0 });
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      const policy = {
        ...exposureSettings,
        enabled: options.enabled,
        snapGain: options.snapGain,
        reportInterval: options.deterministic === true || options.coldBoot === true ? 1e-6 : 0.1,
      };
      let ownedWorldPass: ReturnType<typeof pass> | undefined;
      const installation =
        options.consumer === true
          ? new WorldEnvironment({
              autoExposureEnabled: true,
              bloomEnabled: false,
              exposurePolicy: policy,
              screenSpaceAA: "disabled",
              exposure: 1,
            }).apply(ctx.renderer, ctx.scene, ctx.camera, {
              baseColour: (ownedPass) => {
                ownedWorldPass = ownedPass;
                return ownedPass.getTextureNode("output");
              },
            })
          : undefined;
      if (installation === undefined) ownedWorldPass = pass(ctx.scene, ctx.camera);
      if (ownedWorldPass === undefined) throw new Error("Exposure consumer world pass is missing.");
      const worldPass = ownedWorldPass;
      const colour = worldPass.getTextureNode("output");
      const exposure =
        installation?.exposure === undefined
          ? new ObservedExposureNode(colour, policy, 1)
          : new ObservedExposureNode(installation.exposure);
      console.info(
        `TN_EXPOSURE_CONSUMER:${JSON.stringify({
          installed: installation !== undefined,
          owned: installation?.exposure !== undefined,
        })}`,
      );
      exposure.capturePose = fixedRooms?.snapshot;
      exposure.deterministic = options.deterministic === true;
      exposure.coldBoot = options.coldBoot === true;
      if (exposure.coldBoot) exposure.observeColdBootStartup(ctx.startup);
      if (exposure.deterministic) exposure.holdStartup(ctx.startup);
      let releaseValidation: (() => void) | undefined;
      if (validationDevice !== undefined)
        ctx.startup.hold(
          "exposure-native-validation",
          new Promise<void>((resolve) => {
            releaseValidation = resolve;
          }),
        );
      let validationPending = validationDevice !== undefined;
      let validationDone = false;
      const reportedSurfaces = new Set<number>();
      exposure.onProgress = () => {
        const progress = exposure.getProgress();
        if (
          [1, 180, 181, 360, 361, 540, 541, 720].includes(progress.sampleFrames) &&
          !reportedSurfaces.has(progress.sampleFrames)
        ) {
          reportedSurfaces.add(progress.sampleFrames);
          console.info(
            `TN_EXPOSURE_SURFACE:${JSON.stringify({
              updates: progress.sampleFrames,
              requestedResolutionScale: 1,
              surface: ctx.renderer.surface(),
              drawingBuffer: renderer.getDrawingBufferSize(new Vector2()).toArray(),
              rendererSize: renderer.getSize(new Vector2()).toArray(),
              pixelRatio: renderer.getPixelRatio(),
              canvas: [renderer.domElement.width, renderer.domElement.height],
            })}`,
          );
        }
        ctx.state.set({ ...progress, validationDone, exposure: exposure.getObservation() });
        if (validationPending && progress.sampleFrames === 180) {
          validationPending = false;
          void Promise.all(validationScopes.map(() => validationDevice?.popErrorScope()))
            .then((errors) => {
              if (!activeScene || deviceLost) return;
              if (errors.some((error) => error !== null)) {
                console.error(
                  `TN_EXPOSURE_NATIVE_VALIDATION:${JSON.stringify({ updates: 180, errors: errors.map((error) => error?.message ?? String(error)) })}`,
                );
                return;
              }
              console.info(
                `TN_EXPOSURE_NATIVE_VALIDATION:${JSON.stringify({ updates: 180, scopes: validationScopes, errors })}`,
              );
              validationDone = true;
              exposure.onProgress();
              ctx.state.flush();
              releaseValidation?.();
            })
            .catch((error: unknown) =>
              console.error(`TN_EXPOSURE_NATIVE_VALIDATION_FAILED:${String(error)}`),
            );
        }
      };
      if (installation?.exposure === undefined)
        ctx.renderer.setOutputNode(applyExposure(colour, exposure.exposureNode), worldPass);
      ctx.entities.add("exposure", {
        debug: () => ({
          ...exposure.getObservation(),
          ...exposure.timing,
          bright,
          stops: options.stops,
        }),
      });
      this.#dispose = () => {
        activeScene = false;
        ctx.renderer.clearOutputNode?.();
        if (installation?.exposure === undefined) {
          exposure.dispose();
          if (installation === undefined) worldPass.dispose();
          else installation.dispose?.();
        } else installation.dispose?.();
        disposeRoom();
      };
      return (frame: ICtx) => {
        if (frame.input.justPressed("cut")) {
          const before = fixedRooms?.snapshot();
          exposure.beginCut();
          bright = !bright;
          if (fixedRooms === undefined) applyLight();
          else fixedRooms.setPose(bright);
          const cameraCut =
            before === undefined ? undefined : { before, after: fixedRooms?.snapshot() };
          console.info(
            `TN_EXPOSURE_CUT:${JSON.stringify({ cameraCut, bright, stops: options.stops, ...exposure.timing, ...exposure.getObservation() })}`,
          );
        }
        if (frame.input.justPressed("disable")) exposure.setEnabled(false);
        if (frame.input.justPressed("reset")) {
          console.info(
            `TN_EXPOSURE_RESET:${JSON.stringify({ ...exposure.timing, ...exposure.getObservation() })}`,
          );
          exposure.beginCut();
          exposure.reset();
        }
        if (frame.input.justPressed("resize")) {
          ctx.renderer.setSize(320, 180, false);
          console.info(
            `TN_EXPOSURE_RESIZE:${JSON.stringify({ ...exposure.timing, ...exposure.getObservation() })}`,
          );
          exposure.beginCut();
        }
        if (frame.input.justPressed("resetCut")) {
          bright = !bright;
          if (fixedRooms === undefined) applyLight();
          else fixedRooms.setPose(bright);
          console.info(
            `TN_EXPOSURE_RESET_CUT:${JSON.stringify({ ...exposure.timing, ...exposure.getObservation() })}`,
          );
          exposure.beginCut();
          exposure.reset();
        }
        if (frame.input.justPressed("rebuild")) {
          console.info(
            `TN_EXPOSURE_REBUILD:${JSON.stringify({ ...exposure.timing, ...exposure.getObservation() })}`,
          );
          exposure.beginCut();
          ctx.renderer.setOutputNode(applyExposure(colour, exposure.exposureNode), worldPass);
        }
      };
    }

    override exit(): void {
      this.#dispose();
      this.#dispose = () => {};
    }
  }
  return defineGame({
    camera: { far: 100, fov: 48, near: 0.1, projection: "perspective" },
    display: { maxFps: 60 },
    initialState: { sampleFrames: 0, cutSampleFrames: 0, validationDone: false },
    input: {
      cut: { keys: ["KeyC"] },
      disable: { keys: ["KeyD"] },
      reset: { keys: ["KeyR"] },
      rebuild: { keys: ["KeyB"] },
      resize: { keys: ["KeyZ"] },
      resetCut: { keys: ["KeyT"] },
    },
    plugins: [playtest({ holdUntilAttached: true })],
    // Preserve the experiment's historical full-size drawing buffer as production defaults evolve.
    renderer: { preferWebGPU: true, resolutionScale: 1 },
    scenes: { room: ExposureRoom },
    seed: 339,
    start: "room",
  });
}
