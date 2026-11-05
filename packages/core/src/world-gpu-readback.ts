import { type Camera, type DepthTexture, Matrix4, PerspectiveCamera, Vector3 } from "three";
import { uniform } from "three/tsl";
import { ReadbackBuffer } from "three/webgpu";
import { DepthPyramid, type OcclusionMode } from "./render/depth-pyramid.js";
import type { IRendererLike } from "./renderer.js";
import { cullAndSelect } from "./world-gpu-reference.js";
import {
  type IAssetSlot,
  type IDeviceLike,
  type IGpuPlacement,
  type IGpuSceneBufferFootprint,
  type IGpuSceneBuffers,
  type IKernelResult,
  type IRegion,
  type IValidationReadbacks,
  type IValidationSnapshot,
  LOCAL_WORDS,
  PLACEMENT_WORDS,
  TALLY_EVERY,
  VALIDATE_EVERY,
} from "./world-gpu-types.js";
import {
  DRAW_ARGS_WORDS,
  type GpuSceneMemory,
  type GpuSceneVerdict,
  type IGpuSceneComparison,
  type IGpuSceneValidation,
  type IMeshDraw,
  MATRIX_REPORTED_KEYS,
  MATRIX_TOLERANCE,
  MEMORY_FIELDS,
  VALIDATE_REPORTED_KEYS,
  compareMeshDraws,
  sameMatrices,
  validationReport,
  word,
  xyz,
  zeroComparisonProbe,
} from "./world-gpu-validation.js";

/**
 * Everything the GPU scene learns by reading the device back: the opt-in dispatch validation, the
 * GPU-selected tally, and the measured occlusion pass that feeds them.
 *
 * These are the only parts of the scene that wait on a queue submission, and a game pays for none of
 * them: they run on a validation's, a tally's or a measurement's own clock. They live apart from
 * {@link WorldGpuScene} because the state they keep — one readback in flight, one landed sample, the
 * previous frame's camera for the pyramid — is a group of its own.
 *
 * Everything here is a read of the scene: placements, regions, buffers, the planes and eye of the
 * last dispatch, the gate table and the footprint. The one change it asks for is `restructure()`, a
 * pyramid resize being a new pipeline for the cull kernel exactly as a grown buffer is.
 */

/** Scratch the occlusion measurement builds its view and eye in, reused per frame. */
const _view = new Matrix4();
const _eye = new Vector3();

/** Camera travel in one dispatch that the occlusion test reads as a cut rather than a turn. */
const OCCLUSION_CUT_METRES = 2;

/** Two projection matrices are unchanged when every element is within this. */
const VIEW_EPSILON = 1e-6;

/** Whether the projection changed; ordinary camera travel and turns are not cuts. */
function sameProjection(left: Matrix4, right: Matrix4): boolean {
  for (const [index, element] of right.elements.entries())
    if (Math.abs((left.elements[index] as number) - element) > VIEW_EPSILON) return false;
  return true;
}

/** What a readback sees of the scene it checks, asked at the moment each read uses it. */
export interface IReadbackHost {
  /** Whether the scene is on at all, which is what makes a manual fence available. */
  on(): boolean;
  placements(): readonly IGpuPlacement[];
  regions(): readonly IRegion[];
  buffers(): IGpuSceneBuffers | undefined;
  /** The six frustum planes of the last dispatched camera. */
  planes(): Float32Array;
  /** The eye that dispatch measured every placement's distance from. */
  eye(): Vector3;
  /** Resident placements the scene is drawing from. */
  live(): number;
  gates(): readonly IAssetSlot[];
  footprint(): Record<string, IGpuSceneBufferFootprint>;
  /** A structural change the scene has to answer: the cull kernel is a new pipeline. */
  restructure(): void;
}

/**
 * The report fields a readback owns, spread into {@link IWorldGpuSceneReport}.
 *
 * Every one is absent rather than zero until a sample lands: "the GPU selected nothing" and "nothing
 * has been read back yet" are different facts, and a zero would merge them.
 */
export interface IReadbackReport {
  readonly gpuInstances?: number;
  readonly gpuTriangles?: number;
  readonly gpuTallyAgeFrames?: number;
  readonly occlusion?: IOcclusionReport;
}

/**
 * What the measured occlusion pass found, when a launch asked it to measure.
 *
 * `reason` names why it measured nothing (`no scene depth`), and the counts and `gpuTriangles` come
 * from one landed dispatch, even if a later tally was skipped for occlusion.
 */
export interface IOcclusionReport {
  readonly mode: OcclusionMode;
  readonly reason: string;
  /** Pyramid levels and the dispatches that rebuild them each frame. */
  readonly levels: number;
  readonly buildDispatches: number;
  /** The last landed sample, and the mean over every sample that landed. */
  readonly instances: number;
  readonly triangles: number;
  readonly meanInstances: number;
  readonly meanTriangles: number;
  readonly samples: number;
  /** `triangles / gpuTriangles` of the same sample, which is what the go/no-go multiplies. */
  readonly share: number;
  readonly gpuTriangles: number;
  readonly ageFrames: number;
}

/** One completed manual frame check, identified by the caller's frame and this scene's dispatch. */
export interface IReadbackFrame extends IGpuSceneComparison {
  /** The caller's rendered-frame identity, never inferred from readback timing. */
  readonly frame: number;
  /** The dispatch whose buffers and snapshot this readback completed against. */
  readonly dispatch: number;
  readonly verdict: GpuSceneVerdict;
}

export class WorldGpuReadback {
  readonly #host: IReadbackHost;

  constructor(host: IReadbackHost) {
    this.#host = host;
  }

  /** How many dispatches the scene has submitted, which is the clock every sample is stamped on. */
  #dispatched = 0;

  #draws: (() => readonly IMeshDraw[]) | undefined;
  #mismatches = 0;
  #matrixMismatches = 0;
  #meshMismatches = 0;
  #compared = 0;
  #verdict: GpuSceneVerdict = "ok";
  #lines: string[] = [];
  #validate = false;
  #validating = false;
  /** Manual frame fences replace periodic samples after the first completed fence. */
  #manualOnly = false;
  /** The last dispatch a manual frame fence consumed; periodic checks do not move this. */
  #manualDispatch = -1;
  /** Reused MAP_READ buffers keep validation from allocating two fresh GPU buffers on every check. */
  #validationReadbacks: IValidationReadbacks | undefined;
  /** Whether the owner asked for the GPU-selected main-pass tally; a validation turns it on too. */
  #tally = false;
  /** What a launch asked the pyramid occlusion test to do. `measure` never changes what is drawn. */
  #occlusion: OcclusionMode = "off";
  /** The max-distance chain, and the previous frame's camera the test reprojects into. */
  readonly #pyramid = new DepthPyramid();
  readonly #previousView = new Matrix4();
  readonly #previousProjection = new Matrix4();
  #previousDepth:
    | {
        texture: DepthTexture;
        width: number;
        height: number;
        samples: number;
        version: number;
      }
    | undefined;
  readonly #previousEye = new Vector3();
  /** The previous view the occlusion test reprojects into; its uniform is made by the first kernel
   * that reads it, so a world whose GPU scene never builds one asks the backend for no mat4 uniform. */
  readonly #occlusionMatrix = new Matrix4();
  #occlusionView: ReturnType<typeof uniform> | undefined;
  readonly #occlusionCut = uniform(1);
  /** Why the measure mode measured nothing, or `""` while it is measuring. */
  #occlusionReason = "";
  /** The last landed tally's occlusion counts, and the running mean over every sample. */
  #occludedInstances = 0;
  #occludedTriangles = 0;
  #occlusionTotalTriangles = 0;
  #occlusionSample = -1;
  #occlusionSamples = 0;
  #occlusionSumInstances = 0;
  #occlusionSumTriangles = 0;
  #tallyPending = false;
  /** Dispatch the in-flight tally readback was issued on, or `-1` when none is in flight. */
  #tallyRequested = -1;
  /** Dispatch whose GPU state the landed tally bytes hold, or `-1` before the first lands. */
  #tallySample = -1;
  #tallyInstances = 0;
  #tallyTriangles = 0;
  #watched = false;
  /** The device's last uncaptured error, reported by the next check and then cleared. */
  #deviceError = "";

  /** Take the modes a launch asked for. Set every time, so a re-enable reads the new answer. */
  configure(validate: boolean, tally: boolean, occlusion: OcclusionMode): void {
    this.#validate = validate;
    this.#tally = tally;
    this.#occlusion = occlusion;
  }

  /** What a launch asked the pyramid occlusion test to do; `off` builds no pyramid and reads no depth. */
  get occlusion(): OcclusionMode {
    return this.#occlusion;
  }

  /** Whether a measurement runs this frame, which is also whether the kernel binds the pyramid. */
  get measuring(): boolean {
    return this.#occlusion !== "off";
  }

  setDispatched(count: number): void {
    this.#dispatched = count;
  }

  /**
   * The pyramid the cull kernel reprojects into, once a launch asked to measure: the chain itself,
   * the frame's cut flag, and the view uniform, made on the first kernel that reads it so a run that
   * never measures asks the backend for no extra mat4.
   */
  occlusionBinding():
    | { readonly pyramid: DepthPyramid; readonly cut: unknown; view(): unknown }
    | undefined {
    if (this.#occlusion === "off") return undefined;
    return { cut: this.#occlusionCut, pyramid: this.#pyramid, view: () => this.#view() };
  }

  #view(): unknown {
    this.#occlusionView ??= uniform(this.#occlusionMatrix);
    return this.#occlusionView;
  }

  /**
   * This frame's sample, if one is due: a validation every {@link VALIDATE_EVERY} dispatches, or the
   * tally on its own slower clock. A validation's own readback already holds the args, so the two
   * never read the same dispatch twice.
   */
  sample(renderer: IRendererLike): void {
    if (
      this.#validate === true &&
      this.#manualOnly === false &&
      this.#validating === false &&
      this.#dispatched % VALIDATE_EVERY === 0
    )
      this.#compare(renderer);
    else if (
      this.#validate === false &&
      this.#tally === true &&
      (this.#occlusion === "off" || this.#occlusionCut.value === 0) &&
      this.#tallyPending === false &&
      (this.#tallyRequested < 0 || this.#dispatched - this.#tallyRequested >= TALLY_EVERY)
    )
      this.#tallyRead(renderer);
  }

  /**
   * What the last landed readback found, so a harness can read the answer without the log: the
   * verdict, how many keys it actually compared, how many disagreed on the count, how many on what
   * the draw reads, how many dressed meshes drew instances their own key never owned, and the lines.
   */
  get validation(): {
    readonly verdict: GpuSceneVerdict;
    readonly compared: number;
    readonly mismatched: number;
    readonly matricesMismatched: number;
    readonly meshMismatched: number;
    readonly lines: readonly string[];
  } {
    return {
      verdict: this.#verdict,
      compared: this.#compared,
      mismatched: this.#mismatches,
      matricesMismatched: this.#matrixMismatches,
      meshMismatched: this.#meshMismatches,
      lines: this.#lines,
    };
  }

  /**
   * Read back the dispatch that just ran, once, and resolve only after both targets have settled.
   *
   * This is an opt-in diagnostic seam for a harness that must fence one rendered frame before it
   * advances the fixed-step clock. It does not change the periodic validation path or production
   * dispatches; a caller that asks twice for one dispatch is refused rather than silently counting
   * one frame twice.
   */
  fence(renderer: IRendererLike, frame: number): Promise<IReadbackFrame> {
    if (!Number.isInteger(frame) || frame < 0)
      return Promise.reject(
        new Error("World GPU frame validation needs a non-negative integer frame."),
      );
    if (this.#host.on() === false)
      return Promise.reject(new Error("World GPU scene validation is unavailable."));
    if (this.#dispatched <= 0)
      return Promise.reject(new Error("World GPU frame validation needs a completed dispatch."));
    if (this.#validating)
      return Promise.reject(
        new Error("World GPU frame validation already has a pending readback."),
      );
    if (this.#manualDispatch === this.#dispatched)
      return Promise.reject(new Error("World GPU dispatch was already manually validated."));
    this.#manualOnly = true;
    this.#manualDispatch = this.#dispatched;
    return this.#compare(renderer, frame);
  }

  /**
   * Where the independent per-mesh check gets the CPU path's own records, registered once by the
   * owner and asked only on a check's frame.
   *
   * The scene cannot answer this for itself: the records are the owner's, and the meshes whose
   * indirect offsets are the question are the owner's too. It is asked inside {@link compare}, before
   * the readback is issued, so the instances it compares are the ones the dispatch just read rather
   * than whatever the cells hold when the bytes land — the same snapshot rule the rest of the check
   * is built on, and the reason a walk that streams while a readback is in flight cannot make the
   * check compare two different worlds.
   */
  drawsFrom(provider: () => readonly IMeshDraw[]): void {
    this.#draws = provider;
  }

  /**
   * Hold the device's uncaptured errors, so a check can read them instead of the console.
   *
   * Three already chains its own `onuncapturederror` onto the same device and prints the message,
   * which is the whole reason a refused pipeline reads as a healthy run: the evidence was on screen
   * as a console line nothing compared against the counts. This wraps that handler rather than
   * replacing it, so three's own reporting still fires, and the last message is folded into the next
   * `TN_WORLD_GPU_SCENE_VALIDATE` line. Nothing is cleared except by a check that has reported it,
   * so an error that arrives between two checks still lands on the one after.
   */
  watch(renderer: IRendererLike): void {
    const device = (renderer.raw as { backend?: { device?: IDeviceLike } })?.backend?.device;
    if (device === undefined || this.#watched) return;
    this.#watched = true;
    const previous = device.onuncapturederror;
    device.onuncapturederror = (event: unknown): void => {
      this.#deviceError = uncapturedMessage(event);
      if (typeof previous === "function") previous.call(device, event);
    };
  }

  /**
   * One frame of `?tnOcclusion=measure`: rebuild the max-distance chain from the depth the previous
   * frame's scene pass left behind, and point the test at the camera that depth was rendered with.
   *
   * The depth is last frame's on purpose. This runs in `beforeRender`, before the frame's own scene
   * pass draws, so the texture still holds what the last one wrote — which is the only depth there
   * is, and the reason the test reprojects rather than sampling the current frame.
   *
   * With no scene-pass depth — no render chain installed, so nothing rendered into a target of its
   * own — the mode refuses and says so in `report().occlusion.reason` rather than reporting nothing
   * hidden and reading as a cull that found no work.
   */
  measure(renderer: IRendererLike, camera: Camera): void {
    this.#occlusionCut.value = 1;
    // The main pass returns on an orthographic camera before it gets here (that is a shadow level's
    // own), and a linear depth in metres is a perspective projection's to begin with.
    if (!(camera instanceof PerspectiveCamera)) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: not a perspective camera";
      return;
    }
    const raw = renderer.raw as { logarithmicDepthBuffer?: boolean; reversedDepthBuffer?: boolean };
    if (raw?.logarithmicDepthBuffer || raw?.reversedDepthBuffer || camera.reversedDepth) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: nonstandard depth";
      return;
    }
    const depth = renderer.scenePassDepth?.();
    const width = depth?.width ?? 0;
    const height = depth?.height ?? 0;
    if (depth === undefined || width < 2 || height < 2) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: no scene depth";
      return;
    }
    this.#occlusionReason = "";
    // A resized depth resizes the chain, and the chain's two buffers are what the cull kernel reads,
    // so a new chain is a new pipeline: structural, like every other grow in this class.
    const resized = this.#pyramid.resize(width, height);
    if (resized) this.#host.restructure();
    _view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _eye.setFromMatrixPosition(camera.matrixWorld);
    // A cut skips the test for the frame: a teleport moved the camera further than a walk step, and
    // a projection change means the pyramid is a different camera's depth altogether.
    // ponytail: 2 m of camera travel in one dispatch is a cut. A game that teleports further per
    // step than that raises the bound; one that cuts under it gets a frame of frustum-only.
    const samples = depth.samples ?? 1;
    const previous = this.#previousDepth;
    const depthChanged =
      previous?.texture !== depth.texture ||
      previous.width !== width ||
      previous.height !== height ||
      previous.samples !== samples ||
      previous.version !== depth.texture.version;
    this.#occlusionCut.value =
      depthChanged ||
      resized ||
      !sameProjection(this.#previousProjection, camera.projectionMatrix) ||
      _eye.distanceTo(this.#previousEye) > OCCLUSION_CUT_METRES
        ? 1
        : 0;
    if (this.#occlusionCut.value !== 0)
      this.#occlusionReason =
        depthChanged || resized ? "skipped: depth changed" : "skipped: camera cut";
    this.#previousDepth = {
      texture: depth.texture,
      width,
      height,
      samples,
      version: depth.texture.version,
    };
    this.#previousProjection.copy(camera.projectionMatrix);
    // The chain first, then the camera the chain belongs to: last frame's, which is what the
    // previous frame's depth recorded.
    this.#pyramid.build(renderer, depth.texture, camera.near, camera.far, samples);
    this.#occlusionMatrix.copy(this.#previousView);
    this.#previousView.copy(_view);
    this.#previousEye.copy(_eye);
  }

  /**
   * Ask for the indirect args back, once, and tally what the GPU selected into them.
   *
   * This is the certificate the frame budget could not have: `renderer.info.render.triangles` counts
   * a mesh's CPU window, which for an indirect draw is its capacity and therefore an upper bound,
   * while the args record holds the instance count the kernel actually wrote. The readback is the
   * same one a validation uses — the renderer's one staging buffer — on a slower clock, and a frame
   * whose predecessor is still in flight is skipped rather than queued.
   */
  #tallyRead(renderer: IRendererLike): void {
    const args = this.#host.buffers()?.args;
    if (args === undefined) return;
    const issued = this.#dispatched;
    this.#tallyRequested = issued;
    this.#tallyPending = true;
    // Streaming may grow the args tail while this copy is in flight. Decode its own layout.
    const regions = this.#host.regions().map((region) => ({ argsIndex: region.argsIndex }));
    const occlusionReason = this.#occlusionReason;
    renderer
      .readback(args)
      .then((bytes) => this.#landTally(bytes, issued, regions, occlusionReason))
      .catch(() => {
        this.#tallyPending = false;
      });
  }

  /**
   * Sum the landed args records: `instanceCount` over every record, and `instanceCount x indexCount`
   * divided by three. A record the GPU never wrote reads as the zero it holds, which is correct —
   * a key that selected nothing draws nothing.
   */
  #landTally(
    bytes: ArrayBuffer,
    issued: number,
    regions: readonly Pick<IRegion, "argsIndex">[],
    occlusionReason: string,
  ): void {
    this.#tallyPending = false;
    const words = new Uint32Array(bytes);
    let instances = 0;
    let products = 0;
    for (const region of regions) {
      const record = region.argsIndex * DRAW_ARGS_WORDS;
      const count = word(words, record + 1);
      instances += count;
      products += count * word(words, record);
    }
    this.#tallyInstances = instances;
    this.#tallyTriangles = products / 3;
    this.#tallySample = issued;
    if (this.#occlusion !== "off") this.#landOcclusion(words, issued, regions, occlusionReason);
  }

  /**
   * What the measured cull hid, out of the same landed bytes as the drawn counts.
   *
   * The tail of the args buffer is one word per key of measured-occlusion instances, so a hidden
   * part's triangles are that word times its own `indexCount` — the same product the tally above
   * sums over the records, which is why both numbers can be divided into a share without a second
   * readback or a second clock.
   */
  #landOcclusion(
    words: Uint32Array,
    issued: number,
    regions: readonly Pick<IRegion, "argsIndex">[],
    sampleReason: string,
  ): void {
    let reason = sampleReason;
    const tail = regions.length * DRAW_ARGS_WORDS;
    if (reason === "" && words.length < tail + regions.length) reason = "skipped: short readback";
    if (
      reason === "" &&
      regions.some(
        (region, index) =>
          word(words, tail + index) > word(words, region.argsIndex * DRAW_ARGS_WORDS + 1),
      )
    )
      reason = "skipped: inconsistent readback";
    if (reason !== "") {
      this.#occlusionReason = reason;
      console.info(
        `TN_WORLD_GPU_SCENE_OCCLUSION mode=${this.#occlusion} dispatch=${String(issued)} skipped=1 reason=${reason}`,
      );
      return;
    }
    let instances = 0;
    let products = 0;
    for (const [index, region] of regions.entries()) {
      const count = word(words, regions.length * DRAW_ARGS_WORDS + index);
      instances += count;
      products += count * word(words, region.argsIndex * DRAW_ARGS_WORDS);
    }
    this.#occludedInstances = instances;
    this.#occludedTriangles = products / 3;
    this.#occlusionReason = "";
    this.#occlusionSample = issued;
    this.#occlusionTotalTriangles = this.#tallyTriangles;
    this.#occlusionSamples += 1;
    this.#occlusionSumInstances += instances;
    this.#occlusionSumTriangles += this.#occludedTriangles;
    const report = this.report().occlusion;
    if (report === undefined) return;
    const line =
      `TN_WORLD_GPU_SCENE_OCCLUSION mode=${report.mode} levels=${String(report.levels)} ` +
      `dispatch=${String(issued)} reason=${report.reason || "none"} ` +
      `wouldCullInstances=${String(report.instances)} wouldCullTriangles=${String(report.triangles)} ` +
      `gpuInstances=${String(this.#tallyInstances)} gpuTriangles=${String(this.#tallyTriangles)} ` +
      `share=${report.share.toFixed(4)}`;
    console.info(line);
  }

  /**
   * Read the indirect args and the compacted matrices back and hold both against the reference, over
   * the placements, camera and gate table the dispatch just read — copied at this moment, in this
   * turn, so a structural change landing while the bytes are in flight changes nothing about what
   * they are held against.
   *
   * The reference is {@link cullAndSelect} on the CPU, so this is the kernel measured against the
   * loop it mirrors — the only place the TSL itself is ever checked. It costs two queue submissions
   * and two mapped buffers every {@link VALIDATE_EVERY} dispatches, which is why it is a mode and
   * not a default: a game never pays for it and a walk is never measured with it on. One check is in
   * flight at a time, so every report answers a dispatch of its own.
   *
   * The counts alone are not the draw: a key can land every instance it owes into a record whose
   * `firstInstance` points at the wrong run, or whose `indexCount` names no triangle, or into a
   * region the mesh does not read — and a real WebGPU walk printed `ok` over 200 keys whose
   * `indexCount` was zero, with the forest it was supposed to draw missing from the picture and its
   * shadows still on the ground. So the matrices are read back too, and the same check that reads
   * them holds the record's two CPU-owned words against what the key's geometry and layout say.
   *
   * And the third check reads nothing this file wrote: the owner's own dressed meshes, each with the
   * indirect record its own geometry points at, against the instances the owner's own CPU path
   * composes for the key that mesh is named. Both families above can only confirm that the kernel
   * and the reference agree, which a wrong key-to-record mapping makes them agree on; only these two
   * were not written by the same hand. See {@link compareMeshDraws}.
   */
  #compare(renderer: IRendererLike, frame = -1): Promise<IReadbackFrame> {
    const snapshot = this.#snapshot();
    if (snapshot.args === undefined || snapshot.drawn === undefined)
      return Promise.reject(new Error("World GPU frame validation has no dispatched buffers."));
    const reference = cullAndSelect(snapshot);
    // Taken now, with the snapshot, and not when the readback lands: see `drawsFrom`.
    const draws = this.#draws?.() ?? [];
    const issued = this.#dispatched;
    const readbacks = this.#readbacksFor(snapshot);
    this.#validating = true;
    const occlusionReason = this.#occlusionReason;
    const reads = [
      renderer.readback(snapshot.args, readbacks.args),
      renderer.readback(snapshot.drawn, readbacks.drawn),
    ] as const;
    const complete = Promise.all(reads)
      .then(([argsBytes, drawnBytes]) => {
        // The same landed args feed the tally, so a validation pays for it and this adds no copy.
        this.#landTally(argsBytes, issued, snapshot.regions, occlusionReason);
        const input = this.#against(
          snapshot,
          reference,
          new Uint32Array(argsBytes),
          new Float32Array(drawnBytes),
          draws,
        );
        const report = this.#publish(renderer, input);
        return { ...input, dispatch: issued, frame, verdict: report.verdict };
      })
      .catch((reason: unknown) => {
        // A readback that never lands is a check that never ran, and saying so is the whole point:
        // this line used to end the chain and leave the last verdict standing as if it were fresh.
        const input: IGpuSceneComparison = {
          cause: `readback-failed: ${String(reason instanceof Error ? reason.message : reason)}`,
          compared: 0,
          deviceError: this.#deviceError,
          instancesCpu: 0,
          instancesGpu: 0,
          matricesMismatched: 0,
          meshMismatched: 0,
          meshMismatches: [],
          mismatched: 0,
          mismatches: [],
          matrixMismatches: [],
          placed: snapshot.placed,
        };
        const report = this.#publish(renderer, input);
        return { ...input, dispatch: issued, frame, verdict: report.verdict };
      });
    // Promise.all reports the first failure, but its rejection does not mean the other GPU copy has
    // stopped. Release only after both copies settle, so a pending map cannot race a reused target.
    return complete.finally(async () => {
      await Promise.allSettled(reads);
      readbacks.args.release();
      readbacks.drawn.release();
      if (this.#validationReadbacks !== readbacks) {
        readbacks.args.dispose();
        readbacks.drawn.dispose();
      }
      this.#validating = false;
    });
  }

  #readbacksFor(snapshot: IValidationSnapshot): IValidationReadbacks {
    const argsBytes = Math.max(
      4,
      (snapshot.args as { array: { byteLength: number } }).array.byteLength,
    );
    const drawnBytes = Math.max(
      4,
      (snapshot.drawn as { array: { byteLength: number } }).array.byteLength,
    );
    const current = this.#validationReadbacks;
    if (
      current !== undefined &&
      current.args.maxByteLength >= argsBytes &&
      current.drawn.maxByteLength >= drawnBytes
    )
      return current;
    current?.args.dispose();
    current?.drawn.dispose();
    this.#validationReadbacks = {
      args: new ReadbackBuffer(argsBytes),
      drawn: new ReadbackBuffer(drawnBytes),
    };
    return this.#validationReadbacks;
  }

  /**
   * A copy of everything the dispatch that is running right now reads: the source records, the slot
   * and gate tables, the region and args layout, the frustum planes and the eye.
   *
   * One flat array holds the placement records and each copy is a view into it, so a twenty-thousand
   * placement walk costs one allocation rather than forty thousand. The gate and region tables are
   * copied shallowly, which is whole: an asset's gate definition is replaced rather than edited, and
   * a region is spread into a fresh object, so nothing reachable from a snapshot can move under it.
   */
  #snapshot(): IValidationSnapshot {
    const flat = new Float32Array(this.#host.placements().length * PLACEMENT_WORDS);
    const placements = this.#host.placements().map((placement, index) => {
      const at = index * PLACEMENT_WORDS;
      flat.set(placement.matrix, at);
      flat.set(placement.centre, at + LOCAL_WORDS);
      return {
        centre: flat.subarray(at + LOCAL_WORDS, at + LOCAL_WORDS + 4),
        matrix: flat.subarray(at, at + LOCAL_WORDS),
        scale: placement.scale,
        slot: placement.slot,
      };
    });
    return {
      args: this.#host.buffers()?.args,
      camera: {
        planes: this.#host.planes().slice(),
        x: this.#host.eye().x,
        y: this.#host.eye().y,
        z: this.#host.eye().z,
      },
      count: placements.length,
      drawn: this.#host.buffers()?.drawn,
      placed: this.#host.live(),
      placements,
      regionCount: this.#host.regions().length,
      regions: this.#host.regions().map((region) => ({ ...region, local: region.local.slice() })),
      slots: this.#host.gates().map((slot) => ({ ...slot })),
    };
  }

  /** One readback's bytes against its own dispatch's reference: the counts, then the draw, then the meshes. */
  #against(
    snapshot: IValidationSnapshot,
    reference: IKernelResult,
    gpu: Uint32Array,
    drawn: Float32Array,
    draws: readonly IMeshDraw[],
  ): IGpuSceneComparison {
    const mismatches: string[] = [];
    const matrixMismatches: string[] = [];
    let mismatched = 0;
    let matricesMismatched = 0;
    let instancesGpu = 0;
    let instancesCpu = 0;
    for (const [index, region] of snapshot.regions.entries()) {
      const record = region.argsIndex * DRAW_ARGS_WORDS;
      // A readback that landed short is a mismatch, not a hole in the report: `word` reads out of
      // range as the zero a record that was never written holds.
      const landed = word(gpu, record + 1);
      const expected = reference.counts[index] as number;
      instancesGpu += landed;
      instancesCpu += expected;
      if (landed !== expected) {
        mismatched += 1;
        if (mismatches.length < VALIDATE_REPORTED_KEYS)
          mismatches.push(
            `${region.name ?? `#${String(index)}`} gpu=${String(landed)} cpu=${String(expected)}`,
          );
      }
      const firstInstance = word(gpu, record + 4);
      const indexCount = word(gpu, record);
      const agrees =
        firstInstance === region.start &&
        indexCount === region.indexCount &&
        sameMatrices(
          drawn,
          firstInstance,
          landed,
          reference.drawn,
          region.start,
          expected,
          MATRIX_TOLERANCE,
        );
      if (agrees) continue;
      matricesMismatched += 1;
      if (matrixMismatches.length < MATRIX_REPORTED_KEYS)
        matrixMismatches.push(
          `${region.name ?? `#${String(index)}`} ` +
            `first gpu=${xyz(drawn, firstInstance)} cpu=${xyz(reference.drawn, region.start)} ` +
            `firstInstance gpu=${String(firstInstance)} expected=${String(region.start)} ` +
            `indexCount gpu=${String(indexCount)} expected=${String(region.indexCount)}`,
        );
    }
    // Off the snapshot's own regions: which key each mesh is, which record it reads and what it
    // should be holding are the owner's numbers, and the whole point is that nothing in this file
    // chose them.
    const meshes = compareMeshDraws(gpu, drawn, draws, snapshot.regions);
    // Both totals at zero is the case that never says why it saw nothing: name the snapshot's own
    // camera and nearest live placement, the two inputs a real static validation needs to tell a
    // missing source from a camera, sphere, range or frustum that rejected every one it held.
    const probe =
      instancesGpu === 0 && instancesCpu === 0 ? zeroComparisonProbe(snapshot) : undefined;
    return {
      compared: snapshot.regions.length,
      deviceError: this.#deviceError,
      instancesCpu,
      instancesGpu,
      matricesMismatched,
      meshMismatched: meshes.mismatched,
      meshMismatches: meshes.mismatches,
      mismatched,
      mismatches,
      matrixMismatches,
      placed: snapshot.placed,
      ...(probe === undefined ? {} : { probe }),
    };
  }

  /**
   * One verdict, stored for a harness to read and printed once, with its cause if it failed.
   *
   * The line also carries what the device and this scene held when the check reported, read here
   * rather than polled: `renderer.raw.info.memory` is Three's own tally and `footprint()` is this
   * scene's allocation, so a readback that leaks its staging buffer shows up as growing
   * `readbackBuffers`/`readbackBuffersSize` across reports instead of only as a later OOM. A backend
   * that tracks no memory field contributes none, and no field is ever printed as a fake zero.
   */
  #publish(renderer: IRendererLike, input: IGpuSceneComparison): IGpuSceneValidation {
    const source = (renderer.raw as { info?: { memory?: Partial<Record<string, unknown>> } })?.info
      ?.memory;
    let memory: GpuSceneMemory | undefined;
    // A backend Three keeps no memory tally for contributes nothing, footprint included: a scene
    // number printed next to absent device numbers reads as if the device had been measured.
    if (source !== undefined) {
      memory = {};
      for (const name of MEMORY_FIELDS) {
        const value = source[name];
        if (typeof value === "number" && Number.isFinite(value)) memory[name] = value;
      }
      const footprint = Object.values(this.#host.footprint());
      if (footprint.length > 0)
        memory.footprintBytes = footprint.reduce((sum, buffer) => sum + buffer.bytes, 0);
    }
    const report = validationReport(
      Object.keys(memory ?? {}).length === 0 ? input : { ...input, memory },
    );
    this.#verdict = report.verdict;
    this.#compared = input.compared;
    this.#mismatches = input.mismatched;
    this.#matrixMismatches = input.matricesMismatched;
    this.#meshMismatches = input.meshMismatched;
    this.#lines = [...report.lines];
    // Reported, so cleared: an error is folded into exactly the check that saw it.
    this.#deviceError = "";
    const name =
      "log" in renderer ? (renderer.log as ((message: string) => void) | undefined) : undefined;
    const say = typeof name === "function" ? name : console.info.bind(console);
    say(report.line);
    for (const line of report.lines) say(`TN_WORLD_GPU_SCENE_VALIDATE ${line}`);
    return report;
  }

  /** What the tally and the occlusion measurement report, absent until a sample lands. */
  report(): IReadbackReport {
    return {
      ...(this.#tallySample < 0
        ? {}
        : {
            gpuInstances: this.#tallyInstances,
            gpuTallyAgeFrames: this.#dispatched - this.#tallySample,
            gpuTriangles: this.#tallyTriangles,
          }),
      ...(this.#occlusion === "off"
        ? {}
        : {
            occlusion: {
              ageFrames: this.#occlusionSample < 0 ? 0 : this.#dispatched - this.#occlusionSample,
              buildDispatches: this.#pyramid.levels,
              instances: this.#occludedInstances,
              levels: this.#pyramid.levels,
              meanInstances:
                this.#occlusionSamples === 0
                  ? 0
                  : Math.round(this.#occlusionSumInstances / this.#occlusionSamples),
              meanTriangles:
                this.#occlusionSamples === 0
                  ? 0
                  : Math.round(this.#occlusionSumTriangles / this.#occlusionSamples),
              mode: this.#occlusion,
              reason: this.#occlusionReason,
              samples: this.#occlusionSamples,
              gpuTriangles: this.#occlusionTotalTriangles,
              share:
                this.#occlusionTotalTriangles === 0
                  ? 0
                  : this.#occludedTriangles / this.#occlusionTotalTriangles,
              triangles: this.#occludedTriangles,
            },
          }),
    };
  }

  /** Give back the staging buffers and the pyramid. A readback still in flight keeps its pair. */
  dispose(): void {
    const readbacks = this.#validationReadbacks;
    this.#validationReadbacks = undefined;
    if (!this.#validating) {
      readbacks?.args.dispose();
      readbacks?.drawn.dispose();
    }
    // Unsampled from here, so a report read after teardown says "nothing has been read back yet"
    // rather than naming the last sample of a scene that no longer exists.
    this.#tallyPending = false;
    this.#tallyRequested = -1;
    this.#tallySample = -1;
    this.#pyramid.dispose();
  }
}

function uncapturedMessage(event: unknown): string {
  const error = (event as { error?: { message?: string; constructor?: { name?: string } } }).error;
  const kind = error?.constructor?.name ?? "GPUError";
  return `${kind}: ${(error?.message ?? "no message").replace(/\s+/gu, " ").trim()}`;
}
