import { type Box3, type Camera, Frustum, InstancedMesh, Matrix4, type Object3D } from "three";
import { markEngineRenderHook } from "./engine-render-hook.js";
import type { IRendererLike } from "./renderer.js";
import { SharedBatch } from "./world-cell-batches.js";
import type { IBatchShape, IPrewarmEntry } from "./world-cell-data.js";
import type { IAssetState } from "./world-cells.js";

export interface ICellPrewarmHost {
  released(): boolean;
  parent(): Object3D | null;
  invalidateShadows(): void;
  backlog(): number;
  keysForShadow(): boolean;
  hasShared(key: string): boolean;
  hasRetired(key: string): boolean;
  runMax(asset: string): number | undefined;
  residentCells(): number;
  extentBounds(): Box3;
  smallCaster(asset: string): boolean;
  dressMesh(shared: SharedBatch, receiveShadow: boolean): void;
  receiveShadow(): boolean;
  adoptGpu(shared: SharedBatch, asset: string, key: string, level: number, part: number): void;
  setShared(key: string, shared: SharedBatch): void;
  attach(shared: SharedBatch): void;
  casts(level: number): boolean;
  preserveAuthoredParts(): boolean;
  wideOwed(asset: string, part: number): boolean;
  followCluster(): string;
  wideShape(
    asset: IAssetState | undefined,
    level: number,
    part: number,
    fallback: IBatchShape,
  ): IBatchShape;
}

/**
 * Prewarmed batches minted per update, and the updates a minted batch must survive before it counts
 * as drawn. Three keys its render-object/node cache by `object.uuid`, so every InstancedMesh it has
 * never drawn costs a NodeBuilder build the first frame it is projected (~9 ms in the main pass, and
 * again in the shadow pass for a level that casts): hundreds of them land in a few seconds of
 * walking, which is the walk-time frame cost this pays earlier instead.
 *
 * The rate is a rate of *rendered* updates, not of `update` calls. Minting a batch is cheap (an
 * InstancedMesh and a zeroed buffer) and its build is paid by the next render, so an unbounded queue
 * would hand the whole map's seconds of builds to one frame. 8 per update is ~150 ms of build on the
 * frame that pays it, which the loading screen covers.
 */
const PREWARM_PER_UPDATE = 8;
/**
 * Two updates is the honest floor for "drawn at least once in both the main and the shadow
 * context": the mesh is added during one update and the next render projects it. Tracking it per
 * context would mean hooking the renderer, which this class does not own.
 */
const PREWARM_WARM_UPDATES = 2;
/**
 * Updates a mesh may still be owed a prewarm draw after the gate settled before its borrow is handed
 * back anyway. An empty prewarmed batch draws, so this is the ceiling on the ones that never will —
 * a projection that collapsed the world, a camera that never reached the mesh — and not a diagnosis
 * of any of them. Without it those meshes would hold their hook for the whole walk.
 */
const PREWARM_RELEASE_UPDATES = 8;
/** The whole ring, as one caster cluster: `@*` is every square's records in one mesh. */
export const WIDE_CLUSTER = "*";

export class CellPrewarm {
  readonly #drawBatches = new WeakMap<InstancedMesh, SharedBatch>();
  readonly #submitted = new WeakSet<InstancedMesh>();
  readonly #drawBorrows = new Map<InstancedMesh, { before: unknown; release(): void }>();

  /** Strict CPU submission gate; idle legacy prewarm settlement is not a submitted draw. */
  pendingCpuDrawsInView(root: Object3D, camera: Camera, renderer?: IRendererLike): number {
    camera.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );
    const active = new Set<InstancedMesh>();
    let pending = 0;
    root.traverseVisible((object) => {
      if (!(object instanceof InstancedMesh)) return;
      const batch = this.#drawBatches.get(object);
      if (
        !batch ||
        batch.gpu !== undefined ||
        batch.role !== "main" ||
        object.count <= 0 ||
        !camera.layers.test(object.layers) ||
        !frustum.intersectsObject(object)
      )
        return;
      if (this.#submitted.has(object)) return;
      pending++;
      active.add(object);
      const previous = this.#drawBorrows.get(object);
      if (previous && object.onBeforeRender !== previous.before) previous.release();
      if (this.#drawBorrows.has(object) || renderer === undefined) return;
      const ownBefore = object.onBeforeRender;
      const ownAfter = object.onAfterRender;
      const hadBefore = Object.hasOwn(object, "onBeforeRender");
      const hadAfter = Object.hasOwn(object, "onAfterRender");
      let before: number | undefined;
      const calls = (): number | undefined => {
        const value = (renderer.info as { render?: { drawCalls?: number; calls?: number } }).render;
        const count = value?.drawCalls ?? value?.calls;
        return Number.isSafeInteger(count) && (count as number) >= 0 ? count : undefined;
      };
      const submitted = this.#submitted;
      const release = () => {
        if (object.onBeforeRender === beforeHook) this.#handBack(object, hadBefore, ownBefore);
        if (object.onAfterRender === afterHook) {
          if (hadAfter) object.onAfterRender = ownAfter;
          else Reflect.deleteProperty(object, "onAfterRender");
        }
        this.#drawBorrows.delete(object);
      };
      const beforeHook: typeof object.onBeforeRender = function (this: InstancedMesh, ...args) {
        before = undefined;
        ownBefore.apply(this, args);
        before = args[2] === camera && renderer.compiling !== true ? calls() : undefined;
      };
      const afterHook: typeof object.onAfterRender = function (this: InstancedMesh, ...args) {
        const after = calls();
        if (
          args[2] === camera &&
          renderer.compiling !== true &&
          object.count > 0 &&
          before !== undefined &&
          after !== undefined &&
          after > before
        ) {
          submitted.add(object);
          release();
        }
        before = undefined;
        ownAfter.apply(this, args);
      };
      markEngineRenderHook(beforeHook);
      markEngineRenderHook(afterHook);
      object.onBeforeRender = beforeHook;
      object.onAfterRender = afterHook;
      this.#drawBorrows.set(object, { before: beforeHook, release });
    });
    for (const [mesh, borrow] of this.#drawBorrows) if (!active.has(mesh)) borrow.release();
    return pending;
  }
  /**
   * Every `asset:level:part` of a loaded asset is minted empty, before any placement wants it, so
   * the node build lands in the loading phase instead of the frame a cell row first draws the key.
   * `#prewarmQueue` is the keys still to mint, `#prewarmKeys` the ones queued (a retried load must
   * not queue the same key twice), and `#prewarmPending` the ones minted but not yet
   * `PREWARM_WARM_UPDATES` updates old. `prewarmed` is the game's gate for "safe to show me this
   * world"; `stats().pendingPrewarm` is the same thing as a number.
   */
  readonly #prewarmQueue: IPrewarmEntry[] = [];
  readonly #prewarmKeys = new Set<string>();
  #prewarmPending = 0;
  /** Every mint so far, so a loading bar can read minted / (minted + pending). */
  #prewarmMinted = 0;
  /**
   * Minted meshes whose first draw has been submitted, and the meshes still owed one. A mint is
   * only half the work: the node is built when the mesh is first submitted, and that is the frame
   * the loading bar used to sit still for. `pendingPrewarm` reports this pair, so the bar counts the
   * draw half instead of jumping from minting straight to done. The gate is a promise about batches
   * (`#prewarmPending`), never about these: a companion no shadow level covers is owed a draw
   * forever, and the gate must not wait on it.
   */
  #prewarmOwed = 0;
  #prewarmDrawn = 0;
  #prewarmEpoch = 0;
  #prewarmWait = 0;
  /**
   * Awaited meshes that only a shadow level can draw, and the share of them that have had one.
   *
   * A caster's node is built in the shadow context, so a walk-time first shadow draw of a streamed
   * key is a `NodeBuilder.build` inside a shadow pass — a third of the shadow lane's CPU on the
   * 2 km walk. Counting them separately is what `TN_WORLD_PREWARM`'s `shadowPrewarmed` reports and
   * what the gate waits on; a count of "every batch drew once" cannot tell the two apart.
   */
  #prewarmCasterMinted = 0;
  #prewarmCasterOwed = 0;
  #prewarmCasterDrawn = 0;
  /**
   * Meshes still carrying a prewarm borrow, with the hook each one has to be handed back, the batch
   * holding it visible, and the post-settle updates it has waited; see
   * {@link #releaseImpossibleBorrows}.
   */
  readonly #awaited = new Map<
    InstancedMesh,
    {
      batch: SharedBatch;
      borrow: unknown;
      own: unknown;
      hadOwn: boolean;
      waited: number;
      epoch: number;
    }
  >();
  #prewarmSettled = false;
  #prewarmAsked = false;
  #prewarmResolve: () => void = () => {
    // replaced in the field initialiser below, once `this` exists
  };
  readonly #prewarmed: Promise<void> = new Promise<void>((resolve) => {
    this.#prewarmResolve = resolve;
  });

  /**
   * Mint this update's prewarm allowance, then settle the readiness signal.
   *
   * A batch minted while the world is not in a scene is projected by nothing and builds nothing, so
   * the ready count only advances on an update that had somewhere to draw: a `load()` loop filling
   * the ring mints the whole ring and still leaves the gate shut, which is the honest answer.
   */
  drainPrewarm(): void {
    if (this.#host.released()) return;
    // The loading rate drops to the same 2-per-update a fresh mesh costs once the loading screen is
    // gone. 8 per update is ~150 ms of node builds on the frame that pays it, and the loading
    // screen is the only thing that was covering it: a walk that streams a new asset in afterwards
    // used to hand that frame's builds to a frame that is trying to hold its rate.
    const perUpdate = this.#prewarmSettled ? 2 : PREWARM_PER_UPDATE;
    let minted = 0;
    while (minted < perUpdate && this.#prewarmQueue.length > 0) {
      const entry = this.#prewarmQueue.shift() as IPrewarmEntry;
      this.#prewarmKeys.delete(entry.key);
      this.#mintPrewarm(entry);
      minted += 1;
    }
    // A minted batch is only *owed* a draw by `#awaitDraw`; nothing made anything draw it. A main
    // batch is drawn by the next main render, but a caster is drawn by a shadow level, and the
    // levels render when their window moves or something invalidates them — on a loading screen the
    // follow point stands still, so every caster minted after the first frame sat in the graph with
    // a node no level had ever asked for and the walk's first window move built all of them in one
    // shadow pass. Invalidating while the gate is open, minting or not, is what makes the prewarm
    // prewarm: the build is paid by the loading screen, which is the only frame rate hiding it.
    if (minted > 0) this.#prewarmWait = 0;
    // A caster's draw is a shadow level's, and the levels render at most one per frame, so the gate
    // keeps asking them to while one is owed — bounded, because a borrow nothing draws is handed
    // back by `#releaseImpossibleBorrows` below and a world that never draws one settles anyway.
    const waitingOnCasters = this.#host.parent() !== null && this.#prewarmCasterOwed > 0;
    if (minted > 0 || waitingOnCasters) this.#host.invalidateShadows();
    else if (this.#host.parent() !== null) this.#prewarmWait += 1;
    this.#releaseImpossibleBorrows();
    // Nothing to settle until an asset has asked; once one has, an ask whose keys were all already
    // built minted nothing and is owed nothing, so it settles like a drained one.
    if (this.#prewarmQueue.length > 0 || (this.#prewarmPending <= 0 && !this.#prewarmAsked)) return;
    if (this.#prewarmWait < PREWARM_WARM_UPDATES) return;
    // A caster still owed a draw is a build the walk would otherwise pay inside a shadow pass, so the
    // gate holds for it until its borrow is handed back, which is the bound.
    if (waitingOnCasters) return;
    // A build still owed draws nothing until it lands. When the scene comes up over a ring built
    // without it, that is the whole ring re-seeded: the gate settled over 1,378 owed builds and a
    // third of Machinefall's forest arrived in the first 4 s of play (PRD-478). The loading screen
    // covers them instead.
    if (this.#host.backlog() > 0) return;
    this.#prewarmPending = 0;
    // The gate is settled, so nothing is owed a draw. A companion no shadow level covers leaves its
    // pair non-zero, and `pendingPrewarm` is documented `0` from here on.
    this.#prewarmOwed = 0;
    this.#prewarmDrawn = 0;
    // Retained first-draw hooks belong to the counters just cleared, not later streamed work.
    this.#prewarmEpoch += 1;
    this.#prewarmWait = 0;
    this.#settlePrewarm();
  }

  /**
   * The empty batch for one prewarmed key, built exactly as `#batchFor` builds the real one so a
   * placement that later wants it draws into this mesh and keeps the node three built for it. Both
   * halves of the split are queued: the main key, and the follow point's own caster cluster, which
   * is the one the first shadow level render asks for.
   */
  #mintPrewarm(entry: IPrewarmEntry): void {
    // A world whose shadow levels draw its keys mints no caster half: the two are the same
    // placements by two routes, and a level's map can only draw one of them, so a prewarmed half is
    // a build behind the gate that pays for nothing and an owed draw the gate waits on until it
    // gives up. Decided at the mint rather than at the queue, which is filled before the first
    // renderer hands the GPU scene over. The shadow keys are prewarmed where they are minted
    // instead; see `#shadowKeyFor`.
    if (entry.role !== "main" && this.#host.keysForShadow()) return;
    // A key the retained set is holding needs no prewarmed batch: `#batchFor` rebinds that mesh
    // when the walk comes back, and rebinding is the whole point of keeping it. The prewarm did not
    // ask, so it minted a second InstancedMesh for a key that already had one — a uuid three built a
    // node for twice, in the main pass and in every shadow pass, for the whole of a walk back.
    if (
      this.#host.released() ||
      this.#host.hasShared(entry.key) ||
      this.#host.hasRetired(entry.key)
    )
      return;
    const shared = new SharedBatch(
      entry.geometry,
      entry.material,
      this.#host.runMax(entry.asset) ?? 1,
      this.#host.residentCells() + 1,
      entry.key,
      this.#host.extentBounds(),
      entry.role,
      entry.level,
    );
    shared.smallCaster = this.#host.smallCaster(entry.asset);
    this.#host.dressMesh(shared, entry.role === "main" && this.#host.receiveShadow());
    // Dressed here, before the walk that fills it: the prewarm is what mints every key of an asset
    // before its first placement is swapped, so this is where the whole gate table comes from.
    this.#host.adoptGpu(shared, entry.asset, entry.key, entry.level, entry.part);
    this.#host.setShared(entry.key, shared);
    this.#host.attach(shared);
    this.#prewarmPending += 1;
    this.#prewarmMinted += 1;
    // Every role is owed a draw by `#awaitDraw` and is shown while empty until that draw is counted:
    // the node, the bindings and the pipeline are built by a submission, and one zero-count
    // submission per prewarmed batch is the price of having the walk never pay for it. A caster's
    // submission is a shadow level's, not the main pass's — which is why `#drainPrewarm` keeps the
    // levels rendering while one is owed, and why `VirtualShadowNode`'s `#probe` renders both caster
    // layers when it finds one. A caster that is not awaited here is built on the first shadow draw
    // of the walk, inside a shadow pass, which is the cost this prewarm exists to move.
    this.awaitDraw(shared);
  }

  /** Count this batch's first submitted draw, once, then hand `onBeforeRender` back to whoever had it. */
  awaitDraw(shared: SharedBatch): void {
    const mesh = shared.mesh;
    this.#drawBatches.set(mesh, shared);
    const caster = shared.role !== "main";
    this.#prewarmOwed += 1;
    if (caster) {
      this.#prewarmCasterMinted += 1;
      this.#prewarmCasterOwed += 1;
    }
    shared.awaitPrewarmDraw();
    // three's `Object3D` carries an inherited no-op, so reading `onBeforeRender` off a fresh mesh
    // hands back a function that was never an own property. Writing it back as one leaves every
    // batch that has drawn since looking permanently hooked, and the projection's `hasRenderHook`
    // reads own properties — so the borrow has to remember whether there was one to give back.
    const hadOwn = Object.hasOwn(mesh, "onBeforeRender");
    this.#borrowDraw(shared, mesh, hadOwn, hadOwn ? mesh.onBeforeRender : undefined);
  }

  /**
   * The borrow that counts `mesh`'s first submitted draw and then gives the mesh its own hook back,
   * keyed by the mesh object — so an object that is replaced has to be handed the borrow of the one
   * it replaces; see `#carryPrewarm`.
   */
  #borrowDraw(
    shared: SharedBatch,
    mesh: InstancedMesh,
    hadOwn: boolean,
    own: unknown,
    epoch = this.#prewarmEpoch,
  ): void {
    const caster = shared.role !== "main";
    const borrow = own as ((...args: unknown[]) => void) | undefined;
    const counted = (...args: unknown[]): void => {
      if (epoch === this.#prewarmEpoch) this.#prewarmDrawn += 1;
      if (caster) {
        this.#prewarmCasterOwed -= 1;
        this.#prewarmCasterDrawn += 1;
      }
      this.#handBack(mesh, hadOwn, own);
      this.#awaited.delete(mesh);
      // The node is built and the pipeline is compiled: the batch owes nothing more, so an empty one
      // goes back to hiding.
      shared.prewarmDrew();
      borrow?.(...args);
    };
    // Engine bookkeeping, not a claim on the mesh: the scene-render projection's `hasRenderHook`
    // ignores a marked borrow, so a streamed world's prewarmed batches stay eligible for the
    // collapse they exist to be folded into. Unmarked, 202 of them permanently declined it.
    markEngineRenderHook(counted);
    this.#awaited.set(mesh, { batch: shared, borrow: counted, own, hadOwn, waited: 0, epoch });
    mesh.onBeforeRender = counted as typeof mesh.onBeforeRender;
  }

  /**
   * Hand back the borrow of a mesh whose prewarm draw can never come, so no hook outlives the
   * prewarm it served.
   *
   * A mesh that is merely empty now draws — `visible` at count 0 is what builds its node and its
   * pipeline, and the borrow is counted off that one submission — so emptiness is no longer a
   * reason to release anything. What is left is a mesh nothing can draw, and which mesh that is
   * depends on the role: a main batch is drawn by the main pass, so a world projected by nothing
   * (`parent === null`, which is a `load()` loop's prewarm and settles the moment the world joins a
   * scene) still owes it one, while a *caster* is drawn by a shadow level, and a world nothing
   * projects has no level to draw it — its visible-at-count-0 exception is handed straight back
   * rather than held for the whole load. Otherwise a level is a frame's schedule away and the
   * borrow waits `PREWARM_RELEASE_UPDATES` updates for it. That is a ceiling rather than a
   * diagnosis — a projection that collapsed the world, a camera that never reached the mesh, a game
   * that passed no `shadows.invalidate` for the levels to be told by — and it is here so those
   * meshes neither hold a hook nor sit visible at count 0 for the whole walk.
   */
  #releaseImpossibleBorrows(): void {
    const projected = this.#host.parent() !== null;
    for (const [mesh, entry] of [...this.#awaited]) {
      entry.waited += 1;
      const caster = entry.batch.role !== "main";
      if (projected === true && entry.waited < PREWARM_RELEASE_UPDATES) continue;
      if (projected === false && caster === false) continue;
      if (mesh.onBeforeRender === entry.borrow) this.#handBack(mesh, entry.hadOwn, entry.own);
      this.#awaited.delete(mesh);
      if (caster) this.#prewarmCasterOwed -= 1;
      entry.batch.prewarmDrew();
    }
  }

  /** Give a borrowed mesh back the hook it had, or none at all when it never had one of its own. */
  #handBack(mesh: InstancedMesh, hadOwn: boolean, own: unknown): void {
    if (hadOwn) mesh.onBeforeRender = own as typeof mesh.onBeforeRender;
    // Deleted rather than assigned `undefined`: three calls `object.onBeforeRender(...)`
    // unconditionally, and an own `undefined` shadows the prototype's no-op and throws.
    // quality-allow: the hook must go back to the prototype, which only `delete` can restore.
    // biome-ignore lint/performance/noDelete: restoring the prototype lookup is the point.
    else delete (mesh as Partial<InstancedMesh>).onBeforeRender;
  }

  /**
   * Every level and every part of one asset, queued to be minted empty: the main key, and the one
   * caster cluster under the follow point. One square because a cluster per cell of the map would
   * be a prewarm of the whole package, and the squares a walk reaches first are minted by
   * residency, two an update.
   */
  queuePrewarm(asset: IAssetState): void {
    this.#prewarmAsked = true;
    const wideKey = `${asset.id}:*@${WIDE_CLUSTER}`;
    for (const [level, parts] of asset.levels.entries()) {
      for (const [part, entry] of parts.entries()) {
        const key = `${asset.id}:${String(level)}:${String(part)}`;
        for (const role of ["main", "cluster", "wide"] as const) {
          const terminalImpostor =
            asset.impostor !== undefined && level === asset.levels.length - 1;
          const terminalFarCaster =
            role === "wide" &&
            terminalImpostor &&
            this.#host.casts(0) &&
            (!this.#host.preserveAuthoredParts() ||
              asset.definition.impostorDistance !== undefined);
          // Only a level that casts has a caster half at all; see `#casts`.
          if (role !== "main" && !this.#host.casts(level) && !terminalFarCaster) continue;
          // One whole-asset representation covers the far shadow; see `#wideOwed`.
          if (role === "wide" && !this.#host.wideOwed(asset.id, part)) continue;
          // A baked impostor's far half is one mesh per asset, not one per level; prewarm the mesh the
          // handoff will keep rather than a per-level key it would retire one frame later.
          const name =
            role === "main"
              ? key
              : role === "wide" &&
                  asset.impostor !== undefined &&
                  !this.#host.preserveAuthoredParts()
                ? wideKey
                : `${key}@${role === "cluster" ? this.#host.followCluster() : WIDE_CLUSTER}`;
          // A retained key is already paid for; see `#mintPrewarm`.
          if (
            this.#host.hasShared(name) ||
            this.#host.hasRetired(name) ||
            this.#prewarmKeys.has(name)
          )
            continue;
          // The wide half is prewarmed with the same shape the swap draws; see `#wideShape`.
          const shape = role === "wide" ? this.#host.wideShape(asset, level, part, entry) : entry;
          this.#prewarmKeys.add(name);
          this.#prewarmQueue.push({
            asset: asset.id,
            role,
            geometry: shape.geometry,
            key: name,
            level,
            material: shape.material,
            part,
          });
        }
      }
    }
  }

  #settlePrewarm(): void {
    if (this.#prewarmSettled) return;
    this.#prewarmSettled = true;
    // The one line a walk's log needs to say the prewarm paid what it exists to pay:
    // `shadowPrewarmed` is the casters whose shadow-context node was built behind the gate, and
    // `castersUnbuilt` the ones it could not reach — a non-zero there is the walk-time first shadow
    // build the prewarm was supposed to move, named rather than inferred.
    console.info(
      `TN_WORLD_PREWARM minted=${String(this.#prewarmMinted)} ` +
        `shadowPrewarmed=${String(this.#prewarmCasterDrawn)} ` +
        `castersUnbuilt=${String(Math.max(0, this.#prewarmCasterMinted - this.#prewarmCasterDrawn))}`,
    );
    this.#prewarmResolve();
  }

  /**
   * Hand a replaced mesh's prewarm borrow to the object that replaced it.
   *
   * The borrow is keyed by the mesh object and counts *that* object's first submitted draw, so an
   * object that goes away before its draw would take the owed draw with it: the batch would sit
   * visible at count 0 for the rest of the load, and the owed counters would never balance. Nothing
   * new is prewarmed here — the batch still owes exactly the one draw it owed.
   */
  carryPrewarm(old: InstancedMesh, next: InstancedMesh): void {
    const batch = this.#drawBatches.get(old);
    if (batch) this.#drawBatches.set(next, batch);
    const entry = this.#awaited.get(old);
    if (entry === undefined) return;
    this.#awaited.delete(old);
    this.#borrowDraw(entry.batch, next, entry.hadOwn, entry.own, entry.epoch);
  }
  constructor(readonlyHost: ICellPrewarmHost) {
    this.#host = readonlyHost;
  }
  readonly #host: ICellPrewarmHost;
  get prewarmed(): Promise<void> {
    return this.#prewarmed;
  }
  get queued(): number {
    return this.#prewarmQueue.length;
  }
  get pending(): number {
    return this.#prewarmPending;
  }
  get owed(): number {
    return this.#prewarmOwed;
  }
  get drawn(): number {
    return this.#prewarmDrawn;
  }
  get minted(): number {
    return this.#prewarmMinted;
  }
  get settled(): boolean {
    return this.#prewarmSettled;
  }
  releaseHooks(): void {
    for (const borrow of this.#drawBorrows.values()) borrow.release();
    for (const [mesh, entry] of [...this.#awaited]) {
      if (mesh.onBeforeRender === entry.borrow) this.#handBack(mesh, entry.hadOwn, entry.own);
    }
    this.#awaited.clear();
  }
  settleDisposal(): void {
    this.#prewarmQueue.length = 0;
    this.#prewarmKeys.clear();
    this.#settlePrewarm();
  }
}
