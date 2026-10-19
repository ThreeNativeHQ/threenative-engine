import {
  FrameBudget,
  type ICtx,
  Scene,
  debugFlag,
  defineGame,
  getPlatform,
  isMobile,
  isNative,
  isTouchscreenAvailable,
  isWeb,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import { UI_READY_INTENT } from "@threenative/core/ui-layer";
import {
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { WebGPURenderer } from "three/webgpu";
import {
  type INetworkingConfig,
  type INetworkingState,
  createNetworkingGame,
} from "./networking-game.js";
import { type IWorkerProof, startWorkerProof } from "./worker-proof.js";

interface ISmokeState extends INetworkingState {
  airborne: boolean;
  currentPointers: number;
  /** `debugFlag("probe")`, read once at load: `?probe` in a browser, `TN_DEBUG_PROBE` natively. */
  debugProbe: boolean;
  frames: number;
  preparedFrames: number;
  preparationErrors: number;
  leftGroundWithTwoPointers: boolean;
  maxPointers: number;
  movedWithTwoPointers: boolean;
  /** Every 0 → 1 pointer transition the GAME saw. A touch the UI layer consumed never arrives. */
  pointerDowns: number;
  /** Restart intents, counted on their own so an assertion never races the transition's end. */
  restarts: number;
  /** Transitions the UI layer reported finished. Guards the settled probe against vacuity. */
  slidesDone: number;
  /** Whether the UI layer announced itself, and with how many interactive rectangles. */
  uiReady: boolean;
  uiRegions: number;
  /** Intents the UI layer sent, and the last one, so the bridge is provable in both directions. */
  uiIntents: number;
  lastUiIntent: string;
  /** Published to the UI layer; the page transitions its sliding control while this is true. */
  slide: boolean;
  /** Native loading proof: the overlay must remain visible until startup work settles. */
  loadingVisible: boolean;
  longTasksAvailable: boolean;
  startupReady: boolean;
  workerCallbacksAfterTerminate: number;
  workerComplete: boolean;
  workerFramesAdvanced: number;
  workerInputChecksum: number;
  workerOutputChecksum: number;
  workerIdentity: string;
  networkActionAcks: number;
  networkPeerId: string;
  networkPeerObserved: boolean;
  networkProtocolErrors: number;
  networkReconnects: number;
  networkRemoteDistance: number;
}

export interface ISmokeStatus {
  error?: string;
  frames: number;
  ready: boolean;
  renderer?: string;
}

declare global {
  var canvas: HTMLCanvasElement | undefined;
}
declare const __TN_RUNTIME__: "native" | "web";
declare const __TN_PLAYTEST_ENABLED__: boolean;
declare const __TN_LOADING_PROOF__: boolean;
declare const __TN_UI_FRAME_GATE__: boolean;
declare const __TN_NETWORKING_CONFIG__: INetworkingConfig;
declare const __TN_JS_ENGINE_PROFILE__: Readonly<{
  extraDrawControl: boolean;
  frameWindow: number;
  frustum: "contain" | "default";
  materials: "distinct" | "shared";
  meshes: number;
  pureJsIterations: number;
  pureJsObjects: number;
  visibility: 0 | 0.25 | 0.5 | 1;
  warmupFrames: number;
}>;

/** Pure magenta, inset from the top-left. Shared with `verify-desktop-core.mjs`. */
export const OVERLAY_COLOR = 0xff00ff;
export const OVERLAY_SIZE = 64;
export const OVERLAY_INSET = 16;
const LOADING_PROOF_OVERLAY_COLOR = 0x000000;
const PROOF_BACKDROP_COLOR = 0x101820;
const PROOF_ACCENT_COLORS = [0x00ffff, 0xffff00, 0x00ff00, 0xff8800, 0x4488ff, 0xffffff, 0x8800ff];
const LOADING_PROOF_COMPILE_TIMEOUT_MS = 3_000;
const LOADING_PROOF_COMPILE_FRAME_TIMEOUT_MS = 10_000;

export const status: ISmokeStatus = { frames: 0, ready: false };

const profile = __TN_JS_ENGINE_PROFILE__;

const platform = getPlatform();
if (__TN_RUNTIME__ === "native" || isNative()) {
  if (
    platform.runtime !== "native" ||
    isWeb() ||
    !isNative() ||
    isMobile() !== (platform.formFactor === "mobile") ||
    isTouchscreenAvailable() !== platform.maxTouchPoints > 0
  ) {
    throw new Error(`TN_NATIVE_PLATFORM_INVALID: inconsistent helpers ${JSON.stringify(platform)}`);
  }
  console.info(`TN_NATIVE_PLATFORM:${JSON.stringify(platform)}`);
}

/**
 * The native Web Audio surface, exercised the way Three.js `AudioLoader` exercises it.
 *
 * `decodeAudioData` has to hand back a real Promise. A hand-rolled thenable satisfied `await` and
 * one `.catch`, which is the only shape Three itself uses, and broke every chain of two — and a
 * settled Promise is only delivered if the engine's microtask queue is actually pumped each frame,
 * which one of the two shipping engines did not do. Both defects were invisible on the default
 * desktop engine, so this asserts on device, on whichever engine the build carries.
 *
 * The WAV is built here rather than loaded, so the proof needs no staged asset and no network.
 */
function proveAudioDecodePromise(): void {
  const fail = (reason: string) => console.error(`TN_NATIVE_SMOKE_AUDIO_PROMISE_FAIL:${reason}`);
  const wav = () => {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, text: string) => {
      for (let index = 0; index < text.length; index += 1)
        bytes[offset + index] = text.charCodeAt(index);
    };
    ascii(0, "RIFF");
    view.setUint32(4, 38, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 88200, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, 2, true);
    view.setInt16(44, 16384, true);
    return bytes.buffer;
  };

  const context = new AudioContext();
  let callbackRan = false;
  // Three.js AudioLoader's exact call shape: legacy success callback, then `.catch` on the return.
  const returned = context.decodeAudioData(wav(), () => {
    callbackRan = true;
  });
  if (!(returned instanceof Promise)) {
    fail("not-a-promise");
    return;
  }
  const chained = returned.then((buffer) => buffer);
  if (!(chained instanceof Promise) || typeof chained.catch !== "function") {
    fail("then-is-not-chainable");
    return;
  }
  // Delivery, not just shape: this only resolves if the frame loop pumps microtasks.
  chained
    .then((buffer) => {
      // A browser fires the legacy callback when the decode lands, not before `decodeAudioData`
      // returns, and the host now decodes off the frame thread and settles the same way
      // (`runtime-scripts/install-async-audio-decode.js`, `audio_decode_promise_test.cpp`). Reading
      // it here, at settlement, is the contract; reading it synchronously was the pre-async shape.
      if (!callbackRan) {
        fail("legacy-callback-did-not-run");
        return;
      }
      if (buffer === undefined || typeof buffer.getChannelData !== "function") {
        fail("resolved-without-an-audiobuffer");
        return;
      }
      // A rejection has to arrive as an Error, the way a browser rejects a bad decode.
      return context.decodeAudioData(new ArrayBuffer(0)).then(
        () => fail("empty-buffer-resolved"),
        (error: unknown) => {
          if (!(error instanceof Error)) {
            fail("rejected-without-an-error");
            return;
          }
          console.info("TN_NATIVE_SMOKE_AUDIO_PROMISE_OK");
        },
      );
    })
    .catch((error: unknown) => fail(`threw:${String(error)}`));
}

// The rejection half of this proof asks the host to decode an empty buffer, and the host logs that
// refusal on stderr — which the playtest lane reads as an unexpected console error, correctly, for
// every lane that is not this one. The UI-frame gate's build drops the proof (`THREENATIVE_UI_FRAME_GATE`)
// so its console channel stays strict; every other native build still carries it.
if ((__TN_RUNTIME__ === "native" || isNative()) && !__TN_LOADING_PROOF__ && !__TN_UI_FRAME_GATE__)
  proveAudioDecodePromise();

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function runPureJsProfile(): void {
  if (profile.pureJsObjects === 0 || profile.pureJsIterations === 0) return;
  const objects = Array.from({ length: profile.pureJsObjects }, (_, index) => ({
    local: new Matrix4(),
    parent: index === 0 ? -1 : Math.floor((index - 1) / 2),
    position: new Vector3(index % 17, (index % 31) * 0.1, (index % 47) * -0.1),
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), index * 0.001),
    scale: new Vector3(1, 1, 1),
    world: new Matrix4(),
  }));
  const samplesMs: number[] = [];
  let checksum = 0;
  for (let sample = -2; sample < 5; sample += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < profile.pureJsIterations; iteration += 1) {
      for (let index = 0; index < objects.length; index += 1) {
        const object = objects[index];
        if (object === undefined) continue;
        object.position.x += 0.000001;
        object.local.compose(object.position, object.quaternion, object.scale);
        const parent = objects[object.parent];
        if (parent === undefined) object.world.copy(object.local);
        else object.world.multiplyMatrices(parent.world, object.local);
        checksum += object.world.elements[12] ?? 0;
      }
    }
    const elapsedMs = performance.now() - startedAt;
    if (sample >= 0) samplesMs.push(elapsedMs);
  }
  const operations = profile.pureJsObjects * profile.pureJsIterations;
  console.info(
    `TN_ANDROID_JS_PURE:${JSON.stringify({
      checksum: Number(checksum.toFixed(3)),
      iterations: profile.pureJsIterations,
      medianUsPerObject: (median(samplesMs) * 1000) / operations,
      objects: profile.pureJsObjects,
      samplesMs,
    })}`,
  );
}

function requireRuntimeCanvas(): HTMLCanvasElement {
  const value = globalThis.canvas;
  if (value === undefined)
    throw new Error("TN_NATIVE_CANVAS_MISSING: globalThis.canvas is required");
  return value;
}

const runtimeCanvas = requireRuntimeCanvas();
runtimeCanvas.style.touchAction = "none";

const networkingGame = createNetworkingGame<ISmokeState>(__TN_NETWORKING_CONFIG__);

class NativeSmoke extends Scene<ISmokeState> {
  #profileFirstFrameAt: number | undefined;
  #profileFrames = 0;
  #workerProof: IWorkerProof | undefined;
  #preparedFrames = 0;
  #preparedTick = -1;
  #worldDraws = 0;
  #preparationErrors = 0;
  static override readonly initialState: ISmokeState = {
    airborne: false,
    currentPointers: 0,
    debugProbe: debugFlag("probe"),
    frames: 0,
    preparedFrames: 0,
    preparationErrors: 0,
    lastUiIntent: "",
    leftGroundWithTwoPointers: false,
    maxPointers: 0,
    movedWithTwoPointers: false,
    pointerDowns: 0,
    restarts: 0,
    slide: false,
    slidesDone: 0,
    uiIntents: 0,
    uiReady: false,
    uiRegions: 0,
    loadingVisible: false,
    longTasksAvailable: isNative() ? new FrameBudget().window().longTasks.available : false,
    startupReady: false,
    workerCallbacksAfterTerminate: 0,
    workerComplete: false,
    workerFramesAdvanced: 0,
    workerInputChecksum: 0,
    workerOutputChecksum: 0,
    workerIdentity: "pending",
    networkActionAcks: 0,
    networkConnected: false,
    networkError: "",
    networkLocalObserved: false,
    networkPeerId: "",
    networkPeerObserved: false,
    networkProtocolErrors: 0,
    networkReconnects: 0,
    networkRemoteDistance: 0,
    networkRetry: 0,
    networkSessionId: "",
    networkStatus: "disabled",
  };

  #startWorkerProofIfReady(ctx: ICtx<ISmokeState>): void {
    if (this.#workerProof !== undefined || status.frames !== 9) return;
    this.#workerProof = startWorkerProof(status.frames, (result) => {
      ctx.state.set({
        workerCallbacksAfterTerminate: result.callbacksAfterTerminate,
        workerComplete: true,
        workerFramesAdvanced: result.framesAdvanced,
        workerInputChecksum: result.inputChecksum,
        workerOutputChecksum: result.outputChecksum,
        workerIdentity: result.workerIdentity,
      });
      ctx.state.flush();
    });
  }

  #observeWorkerProof(): void {
    this.#workerProof?.observeFrame(status.frames);
  }

  override enter(ctx: ICtx<ISmokeState>) {
    networkingGame.enter(ctx.state);
    ctx.beforeRender(() => {
      this.#preparedFrames += 1;
      this.#preparedTick = status.frames;
    });
    ctx.camera.position.z = 3;
    if (profile.frustum === "contain") {
      // The lattice spans roughly ±2 units, so at z=3 a portrait frustum culled all but a few
      // boxes and a mesh ladder measured scene objects, not submitted draws (observed
      // 2026-08-21: 250 meshes, 4 drawIndexed/frame). Pulled back until the widest row fits the
      // horizontal half-angle, every filler box submits. fov 60 default; aspect from viewport.
      const perspective = ctx.camera as PerspectiveCamera;
      const aspect =
        Number.isFinite(perspective.aspect) && perspective.aspect > 0
          ? perspective.aspect
          : ctx.viewport.size.width / ctx.viewport.size.height;
      const halfWidthTan = Math.tan(((perspective.fov ?? 60) / 2) * (Math.PI / 180)) * aspect;
      const halfExtent =
        ((Math.ceil(Math.cbrt(Math.max(1, profile.meshes))) - 1) /
          Math.ceil(Math.cbrt(Math.max(1, profile.meshes)))) *
          2 +
        0.1;
      ctx.camera.position.z = Math.max(3, halfExtent / halfWidthTan + 0.5);
    }
    // The canvas-layer overlay is part of the native contract, so the bundle that proves the
    // contract has to draw one. The framework renders `ctx.canvasLayer` in a second pass after
    // the world, and on the native host that second pass used to be thrown away: it acquired its
    // own swapchain image and only the first present of the frame reached the display, so every
    // overlay -- the framework's loading screen included -- drew nothing while working on web.
    // Nothing else in this scene is magenta, and the world never reaches the top-left corner, so
    // a magenta pixel there means the overlay pass survived. `verify-desktop-core.mjs` asserts it.
    const overlay = new Mesh(
      new PlaneGeometry(OVERLAY_SIZE, OVERLAY_SIZE),
      new MeshBasicMaterial({
        color: __TN_LOADING_PROOF__ ? LOADING_PROOF_OVERLAY_COLOR : OVERLAY_COLOR,
        depthTest: false,
        depthWrite: false,
      }),
    );
    overlay.frustumCulled = false;
    ctx.canvasLayer.scene.add(overlay);
    const proofBackdrop = __TN_LOADING_PROOF__
      ? new Mesh(
          new PlaneGeometry(1, 1),
          new MeshBasicMaterial({
            color: PROOF_BACKDROP_COLOR,
            depthTest: false,
            depthWrite: false,
          }),
        )
      : undefined;
    if (proofBackdrop !== undefined) {
      proofBackdrop.frustumCulled = false;
      proofBackdrop.renderOrder = -1;
      ctx.canvasLayer.scene.add(proofBackdrop);
    }
    const proofAccents = __TN_LOADING_PROOF__
      ? PROOF_ACCENT_COLORS.map((color) => {
          const accent = new Mesh(
            new PlaneGeometry(8, OVERLAY_SIZE),
            new MeshBasicMaterial({ color, depthTest: false, depthWrite: false }),
          );
          accent.frustumCulled = false;
          ctx.canvasLayer.scene.add(accent);
          return accent;
        })
      : [];
    // The layer's camera is pixel-sized and centred, so this parks the quad in the top-left.
    const place = ({ height, width }: { height: number; width: number }): void => {
      overlay.position.set(
        -width / 2 + OVERLAY_SIZE / 2 + OVERLAY_INSET,
        height / 2 - OVERLAY_SIZE / 2 - OVERLAY_INSET,
        0,
      );
      proofBackdrop?.scale.set(width, height, 1);
      proofBackdrop?.position.set(0, 0, 0);
      proofAccents.forEach((accent, index) => {
        accent.position.set(
          -width / 2 + OVERLAY_SIZE + OVERLAY_INSET + 4 + index * 8,
          height / 2 - OVERLAY_SIZE / 2 - OVERLAY_INSET,
          0,
        );
      });
    };
    place(ctx.viewport.size);
    ctx.viewport.onResize(place);
    if (__TN_LOADING_PROOF__) {
      ctx.canvasLayer.opaque = true;
      ctx.state.set({ loadingVisible: true });
      ctx.state.flush();
      console.info("TN_LOADING_PROOF_OVERLAY_VISIBLE");
      void ctx.startup.whenReady().then(() => {
        ctx.canvasLayer.opaque = false;
        overlay.removeFromParent();
        overlay.geometry.dispose();
        (overlay.material as MeshBasicMaterial).dispose();
        if (proofBackdrop !== undefined) {
          proofBackdrop.removeFromParent();
          proofBackdrop.geometry.dispose();
          (proofBackdrop.material as MeshBasicMaterial).dispose();
        }
        for (const accent of proofAccents) {
          accent.removeFromParent();
          accent.geometry.dispose();
          (accent.material as MeshBasicMaterial).dispose();
        }
        ctx.state.set({ loadingVisible: false, startupReady: true });
        ctx.state.flush();
        console.info("TN_LOADING_PROOF_DISMISSED");
      });
    }
    const cube = ctx.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x44aaff })));
    ctx.entities.add("cube", cube);
    const player = ctx.add(
      new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshBasicMaterial({ color: 0xffaa44 })),
    );
    player.position.set(-1, 0, 0);
    ctx.entities.add("multitouch-player", player);
    const networkLocalPlayer = ctx.add(
      new Mesh(new BoxGeometry(0.32, 0.32, 0.32), new MeshBasicMaterial({ color: 0x44ffcc })),
    );
    networkLocalPlayer.visible = false; // engine-override: hide until an authoritative local snapshot exists
    ctx.entities.add("network-local-player", networkLocalPlayer);
    const networkRemotePlayer = ctx.add(
      new Mesh(new BoxGeometry(0.32, 0.32, 0.32), new MeshBasicMaterial({ color: 0xff4488 })),
    );
    networkRemotePlayer.visible = false; // engine-override: hide until a peer snapshot is observed
    ctx.entities.add("network-remote-player", networkRemotePlayer);
    const queued = ctx.entities.add("queue-free-smoke", { dispose: () => undefined });
    ctx.entities.queueFree(queued);
    const sharedGeometry = new BoxGeometry(0.08, 0.08, 0.08);
    const sharedMaterial = new MeshBasicMaterial({ color: 0x88cc66 });
    const visibleMeshes = Math.floor(profile.meshes * profile.visibility);
    const perSide = Math.max(1, Math.ceil(Math.cbrt(profile.meshes)));
    for (let index = 0; index < profile.meshes; index += 1) {
      const material =
        profile.materials === "shared"
          ? sharedMaterial
          : new MeshBasicMaterial({ color: (0x224466 + index * 2654435761) & 0xffffff });
      const filler = ctx.add(new Mesh(sharedGeometry, material));
      filler.visible = index < visibleMeshes;
      filler.position.set(
        ((index % perSide) / perSide - 0.5) * 4,
        ((Math.floor(index / perSide) % perSide) / perSide - 0.5) * 4,
        ((Math.floor(index / (perSide * perSide)) % perSide) / perSide - 0.5) * 4,
      );
    }
    if (profile.extraDrawControl) {
      const controlDraw = ctx.add(new Mesh(sharedGeometry, sharedMaterial));
      controlDraw.position.set(0.25, 0.25, 0);
    }
    console.info(`TN_ANDROID_JS_SUBJECT:${JSON.stringify({ ...profile, visibleMeshes })}`);
    runPureJsProfile();
    let maxPointers = 0;
    let movedWithTwoPointers = false;
    let leftGroundWithTwoPointers = false;
    let verticalVelocity = 0;
    // The one number the UI-layer input proof reads. A touch the overlay consumed never reaches
    // this runtime at all, so counting arrivals is the honest observation — "the player did not
    // move" would also be true if the game were simply broken.
    //
    // Counted from the event, not sampled per frame. A tap whose down and up land between two
    // frames is invisible to `input.raw.pointers`, and on a phone that happens often enough to
    // make a frame-sampled counter under-report — which reads exactly like a touch the overlay
    // swallowed. That distinction is the whole assertion.
    let pointerDowns = 0;
    runtimeCanvas.addEventListener?.("pointerdown", () => {
      pointerDowns += 1;
      // Logged, not just counted, because the overlay's negative case — a press outside every
      // interactive island must reach the GAME — has no other observable on desktop: the page's
      // console does not reach the host's stdout, so a scenario that only watched the UI side
      // would pass whether the press fell through or vanished.
      console.info(`TN_SMOKE_POINTER_DOWN:${pointerDowns}`);
    });
    return (frameCtx: ICtx<ISmokeState>, dt: number) => {
      // Start after the renderer has reached steady frames. Starting during enter() lets native
      // renderer compilation overlap the worker and proves startup latency instead of continuity.
      networkingGame.update(frameCtx.state);
      const networkState = frameCtx.state.getState();
      networkLocalPlayer.visible = networkState.networkLocalObserved;
      if (networkLocalPlayer.visible) {
        networkLocalPlayer.position.set(
          networkState.networkLocalX ?? 0,
          0,
          networkState.networkLocalZ ?? 0,
        );
      }
      networkRemotePlayer.visible = networkState.networkPeerObserved === true;
      if (networkRemotePlayer.visible) {
        networkRemotePlayer.position.set(
          networkState.networkRemoteX ?? 0,
          0,
          networkState.networkRemoteZ ?? 0,
        );
      }
      this.#startWorkerProofIfReady(ctx);
      cube.rotation.x += dt * 0.5;
      cube.rotation.y += dt;
      const pointers = [...frameCtx.input.raw.pointers.values()];
      const moving = pointers.some(({ position }) => position.x < runtimeCanvas.width / 2);
      const jumping = pointers.some(({ position }) => position.x >= runtimeCanvas.width / 2);
      if (moving) player.position.x += dt * 3;
      if (jumping && player.position.y === 0) verticalVelocity = 5;
      verticalVelocity -= dt * 12;
      player.position.y = Math.max(0, player.position.y + verticalVelocity * dt);
      if (player.position.y === 0 && verticalVelocity < 0) verticalVelocity = 0;
      maxPointers = Math.max(maxPointers, pointers.length);
      movedWithTwoPointers ||= pointers.length >= 2 && moving;
      leftGroundWithTwoPointers ||= pointers.length >= 2 && player.position.y > 0;
      frameCtx.state.set({
        airborne: player.position.y > 0,
        currentPointers: pointers.length,
        leftGroundWithTwoPointers,
        maxPointers,
        movedWithTwoPointers,
        pointerDowns,
        ...(__TN_LOADING_PROOF__
          ? {
              loadingVisible: frameCtx.canvasLayer.opaque,
            }
          : {}),
      });
      status.frames += 1;
      frameCtx.state.set({ frames: status.frames });
      this.#observeWorkerProof();
      if (status.frames === 1) console.info("TN_NATIVE_SMOKE_FIRST_FRAME");
      if (status.frames === 300) console.info("TN_NATIVE_SMOKE_300_FRAMES:300");
    };
  }

  override exit(): void {
    networkingGame.exit();
  }

  override render(ctx: ICtx<ISmokeState>): void {
    // Scene.render follows an actual world draw: verify the native frame used its last fixed state.
    this.#worldDraws += 1;
    if (this.#preparedFrames !== this.#worldDraws || this.#preparedTick !== status.frames)
      this.#preparationErrors += 1;
    ctx.state.set({
      preparedFrames: this.#preparedFrames,
      preparationErrors: this.#preparationErrors,
    });
    this.#profileFrames += 1;
    if (this.#profileFrames === profile.warmupFrames + 1) {
      this.#profileFirstFrameAt = performance.now();
      console.info(
        `TN_ANDROID_JS_WINDOW_START:${JSON.stringify({ frameWindow: profile.frameWindow })}`,
      );
    }
    if (this.#profileFrames !== profile.warmupFrames + profile.frameWindow + 1) return;
    const elapsedMs = performance.now() - (this.#profileFirstFrameAt ?? Number.NaN);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      console.error("TN_ANDROID_JS_FRAME_MISSING");
      return;
    }
    console.info(
      `TN_ANDROID_JS_FRAME:${JSON.stringify({
        elapsedMs,
        frames: profile.frameWindow,
        msPerFrame: elapsedMs / profile.frameWindow,
      })}`,
    );
  }
}

const loadingProofRenderer = __TN_LOADING_PROOF__
  ? {
      webgpuFactory: (canvas: HTMLCanvasElement, options: { antialias: boolean }) => {
        const renderer = new WebGPURenderer({ canvas, ...options });
        renderer.compileAsync = async () => {
          const startedAt = performance.now();
          console.info("TN_LOADING_PROOF_COMPILE_START");
          // The proof scene's first world pass is the real native first-use work. Its compile
          // promise is held here only to make the multi-second startup window deterministic: the
          // native conformance run can sample the same process before and after the gate without
          // depending on whether this machine's driver resolves compileAsync in milliseconds.
          // A 3s timer alone allowed Windows to finish after only 57 presents, before the
          // verifier's first 60-frame tick. Hold through 61 frame opportunities as well: RAF
          // runs before presentation, so the extra callback lets the 60th frame complete.
          // The verifier still independently requires a real native present tick, not RAFs.
          await new Promise<void>((resolve, reject) => {
            let frames = 0;
            let frame = 0;
            const timeout = setTimeout(() => {
              cancelAnimationFrame(frame);
              reject(new Error(`TN_LOADING_PROOF_FRAME_TIMEOUT:${frames}`));
            }, LOADING_PROOF_COMPILE_FRAME_TIMEOUT_MS);
            const observe = () => {
              frames += 1;
              if (
                frames >= 61 &&
                performance.now() - startedAt >= LOADING_PROOF_COMPILE_TIMEOUT_MS
              ) {
                clearTimeout(timeout);
                resolve();
              } else {
                frame = requestAnimationFrame(observe);
              }
            };
            frame = requestAnimationFrame(observe);
          });
          console.info(
            `TN_LOADING_PROOF_COMPILE_END:${JSON.stringify({
              elapsedMs: Math.round(performance.now() - startedAt),
              outcome: "native-stall-fixture",
            })}`,
          );
        };
        return renderer;
      },
    }
  : {};

const game: ReturnType<typeof defineGame<ISmokeState>> = defineGame<ISmokeState>({
  canvas: runtimeCanvas,
  inputTarget: runtimeCanvas,
  plugins: __TN_PLAYTEST_ENABLED__
    ? [playtest(__TN_LOADING_PROOF__ ? { holdUntilAttached: false } : {})]
    : [],
  renderer: loadingProofRenderer,
  scenes: { smoke: NativeSmoke },
  start: "smoke",
});

/**
 * The game end of the UI bridge, wired in the example rather than in a package.
 *
 * `slide` is published state the overlay reacts to, and `slide`/`restart` are intents the
 * overlay sends. Together they prove the bridge in both directions on a device — which is the
 * half of PRD-217 Phase 0 that a hit test alone does not cover.
 */
game.ui.onIntent((intent, payload) => {
  const state = game.state.getState();
  // Every intent, counted — because the state it sets is not. `slide` is set rather than
  // toggled, so a harness that watched for the page's reaction saw the first press of a run and
  // read every later one as "the press never arrived": a permanently green first case and three
  // false reds behind it, which is worse than no observation at all.
  console.info(`TN_SMOKE_UI_INTENT:${JSON.stringify({ intent, uiIntents: state.uiIntents + 1 })}`);
  if (intent === "restart") networkingGame.retry();
  game.state.set({
    lastUiIntent: intent,
    uiIntents: state.uiIntents + 1,
    ...(intent === "slide" ? { slide: payload !== false } : {}),
    ...(intent === UI_READY_INTENT ? { uiReady: true, uiRegions: Number(payload) } : {}),
    ...(intent === "restart" ? { restarts: state.restarts + 1 } : {}),
    ...(intent === "slideDone" ? { slidesDone: state.slidesDone + 1 } : {}),
  });
  game.state.flush();
});

export default game;
