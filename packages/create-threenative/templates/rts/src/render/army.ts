// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// Every unit, every building, the selection rings under them and the health bars over them: a
// handful of instanced meshes, whatever the match is doing. Nothing here allocates per frame, and
// nothing here knows the rules — it reads the simulation's state and writes transforms.
//
// Why instanced and not one `Mesh` per entity: a hundred workers are a hundred scene objects, a
// hundred matrix walks and a hundred draw candidates before the first triangle is submitted, for
// geometry that is identical. One `InstancedMesh` per (type, team, material) is a few dozen
// objects for the whole battlefield, and the count is what `maxDrawCalls` in the performance
// scenario is really measuring.
import {
  type BufferAttribute,
  type Camera,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  type OrthographicCamera,
  PlaneGeometry,
  RingGeometry,
  Vector3,
} from "three";
import type { Game } from "../sim/game.js";
import { HALF, STARTS, terrainHeight } from "../sim/terrain.js";
import { type IEntity, TYPES } from "../sim/types.js";
import type { IUnitModels } from "./models.js";
import { palette } from "./palette.js";

/** Copies one (type, team) can be on screen at once. The supply cap is 120 for the whole map. */
const CAPACITY = 128;
/** Order markers alive at once, oldest released first. */
const MARKERS = 24;
/**
 * Bar sizes in screen pixels, not metres, as AstraCraft draws them: a 3 px fill inside a 1 px dark
 * frame, 30 px over a unit and 60 px over a building, and a 2 px build or queue line 6 px below.
 * A readout keeps one size on screen at every zoom, as in every strategy game.
 */
const BAR_HEIGHT = 3;
const BAR_BORDER = 1;
const BAR_WIDTH = { building: 60, unit: 30 } as const;
const WORK_HEIGHT = 2;
const WORK_DROP = 6;
const MARKER_LIFE = 0.8;
/**
 * Where an entity was before the latest rules step: `id, x, z, angle, altitude` per slot, slot =
 * `id % POSE_SLOTS`. The rules move units 20 times a second and the screen shows 60, so a unit
 * drawn where the rules left it moves on one frame in three; drawn between its last two poses, it
 * moves on every frame. ponytail: a slot shared by two live ids (ids 4096 apart) draws the newer
 * one unblended for that step; key by entity if a match ever holds that many at once.
 */
const POSE_SLOTS = 4096;
const POSE = 5;

interface IBatch {
  readonly list: IEntity[];
  readonly parts: InstancedMesh[];
}

interface IMarker {
  life: number;
  x: number;
  z: number;
}

export interface IArmy {
  /** An expanding ring where an order landed, so a click has a visible consequence. */
  readonly marker: (x: number, z: number, hostile: boolean) => void;
  readonly root: Object3D;
  /** Record every entity's pose. Call it just before each rules step. */
  readonly step: (game: Game) => void;
  /** Once per drawn frame: write every transform this frame shows. */
  readonly sync: (
    game: Game,
    selected: ReadonlySet<number>,
    time: number,
    dt: number,
    camera: Camera,
    /** Screen pixels per metre at depth 1, measured by the scene: a render file imports no package. */
    pixelsPerMetre: number,
    /** How far the frame is into the latest rules step, 0 (the pose before it) to 1 (its result). */
    blend: number,
    /** Where the camera draws this frame from, so a bar's edges land on whole pixels. */
    eye: Vector3,
  ) => void;
  readonly dispose: () => void;
}

const _dummy = new Object3D();
const _tint = new Color();
const _friendly = new Color(0x9be6bb);
const _hurt = new Color(0xddad71);
/** A rival's bar is its faction colour, as in AstraCraft. */
const _teamFill = STARTS.map((start) => new Color(start.css));
const _work = new Color(0x77eddf);
const _queue = new Color(0x77cddd);
const _backing = new Color(0x08151e);
const _right = new Vector3();
const _at = { altitude: 0, angle: 0, x: 0, z: 0 };
const _offset = new Vector3();

export function createArmy(
  models: IUnitModels,
  receivers: { added?: (mesh: Object3D) => void; removed?: (mesh: Object3D) => void } = {},
): IArmy {
  const root = new Object3D();
  const batches = new Map<string, IBatch>();
  const markers: IMarker[] = [];
  for (let index = 0; index < MARKERS; index += 1) markers.push({ life: 0, x: 0, z: 0 });

  // One ring per faction, because the ring's colour *is* the faction: a single mesh would need a
  // per-instance colour, and three draws are cheaper than the bookkeeping.
  const rings = STARTS.map(
    (start) =>
      new InstancedMesh(
        new RingGeometry(1, 1.075, 40).rotateX(-Math.PI / 2),
        new MeshBasicMaterial({
          color: start.color,
          depthWrite: false,
          opacity: 0.85,
          transparent: true,
        }),
        CAPACITY,
      ),
  );
  for (const ring of rings) {
    ring.instanceMatrix.setUsage(DynamicDrawUsage);
    ring.frustumCulled = false;
    ring.renderOrder = 2;
    root.add(ring);
  }
  // Read back per frame instead of destructuring `rings.entries()`, which hands back a two-element
  // array for every ring, every frame.
  const ringTeams = STARTS.map((start, index) => start.team ?? index);

  // Dark borders keep the authored faction colours readable on bright ground. Both underlays
  // share one owned material and follow the foreground transforms without another per-frame walk.
  const backingMaterial = new MeshBasicMaterial({ color: palette.unseen, depthWrite: false });
  const ringBackings = new InstancedMesh(
    new RingGeometry(0.97, 1.105, 40).rotateX(-Math.PI / 2),
    backingMaterial,
    CAPACITY * STARTS.length,
  );
  const markerBackings = new InstancedMesh(
    new RingGeometry(0.47, 0.69, 24).rotateX(-Math.PI / 2),
    backingMaterial,
    MARKERS,
  );
  for (const backing of [ringBackings, markerBackings]) {
    backing.instanceMatrix.setUsage(DynamicDrawUsage);
    backing.frustumCulled = false;
    backing.renderOrder = 1;
    root.add(backing);
  }

  // Two quads per readout — a coloured fill over the dark backdrop ring that frames it — so a bar
  // reads against any ground. `toneMapped: false` keeps them at the colour they were authored.
  const bars = new InstancedMesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ depthTest: false, toneMapped: false, transparent: true }),
    CAPACITY * 3,
  );
  bars.instanceMatrix.setUsage(DynamicDrawUsage);
  bars.frustumCulled = false;
  bars.renderOrder = 3;
  root.add(bars);

  const markerRings = new InstancedMesh(
    new RingGeometry(0.5, 0.66, 24).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: palette.accent,
      depthWrite: false,
      opacity: 0.7,
      transparent: true,
    }),
    MARKERS,
  );
  markerRings.instanceMatrix.setUsage(DynamicDrawUsage);
  markerRings.frustumCulled = false;
  markerRings.renderOrder = 2;
  root.add(markerRings);

  const batch = (type: string, team: number): IBatch => {
    const key = `${type}:${team}`;
    const found = batches.get(key);
    if (found !== undefined) return found;
    const parts = models.parts(type as IEntity["type"], team).map((part) => {
      const mesh = new InstancedMesh(part.geometry, part.material, CAPACITY);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      root.add(mesh);
      receivers.added?.(mesh);
      return mesh;
    });
    const made: IBatch = { list: [], parts };
    batches.set(key, made);
    return made;
  };

  let barCount = 0;
  /** Screen pixels per metre this frame (orthographic: the same at every depth). */
  let pixels = 1;
  /** Half the viewport in pixels, and the camera's up axis in world space this frame. */
  let halfWidth = 0;
  let halfHeight = 0;
  const up = new Vector3();
  /** The camera position this frame draws from, and how far it is into the latest rules step. */
  let eye: Vector3 = up;
  let blend = 1;
  const poses = new Float64Array(POSE_SLOTS * POSE).fill(-1);

  /** The pose this frame draws `entity` at, between its last two rules steps, written into `_at`. */
  const pose = (entity: IEntity): typeof _at => {
    const slot = (entity.id % POSE_SLOTS) * POSE;
    const altitude = entity.altitude || 0;
    if (poses[slot] !== entity.id) {
      _at.x = entity.x;
      _at.z = entity.z;
      _at.angle = entity.angle;
      _at.altitude = altitude;
      return _at;
    }
    const x = poses[slot + 1] as number;
    const z = poses[slot + 2] as number;
    const angle = poses[slot + 3] as number;
    const height = poses[slot + 4] as number;
    // The short way round, so a unit turning through ±π does not spin the long way.
    let turn = entity.angle - angle;
    turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
    _at.x = x + (entity.x - x) * blend;
    _at.z = z + (entity.z - z) * blend;
    _at.angle = angle + turn * blend;
    _at.altitude = height + (altitude - height) * blend;
    return _at;
  };

  /** The bar's anchor in world space and on screen, in pixels from the top-left. */
  const _base = new Vector3();
  let anchorX = 0;
  let anchorY = 0;
  /** One camera-facing quad covering the screen rectangle `x, y, w, h`, in whole pixels. */
  const quad = (x: number, y: number, w: number, h: number, colour: Color) => {
    _dummy.position
      .copy(_base)
      .addScaledVector(_right, (x + w / 2 - anchorX) / pixels)
      .addScaledVector(up, (anchorY - y - h / 2) / pixels);
    _dummy.quaternion.copy(camera.quaternion);
    _dummy.scale.set(w / pixels, h / pixels, 1);
    _dummy.updateMatrix();
    bars.setMatrixAt(barCount, _dummy.matrix);
    bars.setColorAt(barCount, colour);
    barCount += 1;
  };

  /**
   * One readout, AstraCraft's: a fill growing from the left inside a 1 px dark frame, hung from a
   * point above the model, and an unframed build or queue line under it. Every edge sits on a whole
   * pixel: a frame on a fractional position is shared by two pixel rows that trade coverage as the
   * unit moves, which reads as a border that shimmers.
   */
  const pushBar = (entity: IEntity, fraction: number, colour: Color, work: number, tone: Color) => {
    const at = pose(entity);
    const lift = entity.building ? TYPES[entity.type].r + 1.3 : entity.air ? 2.1 : 3.1;
    _base.set(at.x, terrainHeight(at.x, at.z) + at.altitude + lift, at.z);
    _offset.copy(_base).sub(eye);
    anchorX = halfWidth + _offset.dot(_right) * pixels;
    anchorY = halfHeight - _offset.dot(up) * pixels;
    const width = entity.building ? BAR_WIDTH.building : BAR_WIDTH.unit;
    const left = Math.round(anchorX - width / 2);
    const top = Math.round(anchorY);
    quad(
      left - BAR_BORDER,
      top - BAR_BORDER,
      width + 2 * BAR_BORDER,
      BAR_HEIGHT + 2 * BAR_BORDER,
      _backing,
    );
    const fill = Math.round(width * Math.max(0, Math.min(1, fraction)));
    if (fill > 0) quad(left, top, fill, BAR_HEIGHT, colour);
    const done = Math.round(width * Math.max(0, Math.min(1, work)));
    if (done > 0) quad(left, top + WORK_DROP, done, WORK_HEIGHT, tone);
  };

  let camera: Camera;

  return {
    root,
    marker: (x, z, hostile) => {
      const slot = markers.find((entry) => entry.life <= 0) ?? markers[0];
      if (slot === undefined) return;
      const index = markers.indexOf(slot);
      slot.life = MARKER_LIFE;
      slot.x = x;
      slot.z = z;
      markerRings.setColorAt(index, _tint.set(hostile ? 0xff775a : 0x6cfbe2));
    },
    step: (game) => {
      for (const entity of game.entities) {
        const slot = (entity.id % POSE_SLOTS) * POSE;
        poses[slot] = entity.id;
        poses[slot + 1] = entity.x;
        poses[slot + 2] = entity.z;
        poses[slot + 3] = entity.angle;
        poses[slot + 4] = entity.altitude || 0;
      }
    },
    sync: (game, selected, time, dt, view, pixelsPerMetre, share, from) => {
      camera = view;
      pixels = pixelsPerMetre;
      blend = Math.max(0, Math.min(1, share));
      eye = from;
      up.set(0, 1, 0).applyQuaternion(view.quaternion);
      _right.set(1, 0, 0).applyQuaternion(view.quaternion);
      const frame = view as OrthographicCamera;
      halfWidth = (((frame.right - frame.left) / frame.zoom) * pixels) / 2;
      halfHeight = (((frame.top - frame.bottom) / frame.zoom) * pixels) / 2;
      for (const entry of batches.values()) entry.list.length = 0;
      for (const entity of game.entities) {
        if (entity.garrisonId !== null) continue;
        // The fog of war is the fog of war: an enemy in a cell you cannot see is not drawn.
        if (entity.team > 0 && !seen(game, entity)) continue;
        batch(entity.type, entity.team).list.push(entity);
      }
      for (const entry of batches.values()) {
        const list = entry.list;
        for (let index = 0; index < list.length; index++) {
          const entity = list[index];
          if (entity === undefined) continue;
          const at = pose(entity);
          _dummy.position.set(
            at.x,
            terrainHeight(at.x, at.z) + at.altitude + bob(entity, time),
            at.z,
          );
          _dummy.rotation.set(
            0,
            at.angle,
            entity.air && entity.moving ? Math.sin(time + entity.id) * 0.025 : 0,
          );
          // A site under construction grows out of the ground instead of appearing whole, which
          // is the only honest way to show progress on something you cannot put a health bar on.
          const rise = entity.built ? 1 : 0.08 + entity.progress * 0.92;
          _dummy.scale.set(1, rise, 1);
          _dummy.updateMatrix();
          for (const part of entry.parts) part.setMatrixAt(index, _dummy.matrix);
        }
        for (const part of entry.parts) {
          part.count = list.length;
          if (part.count === 0) continue;
          // No bound is recomputed here: every part mesh is `frustumCulled = false`, so nothing
          // reads one — and on the native engine the call crosses the bridge and walks every
          // instance in the batch.
          upload(part.instanceMatrix, part.count);
        }
      }

      let backingCount = 0;
      for (let teamIndex = 0; teamIndex < rings.length; teamIndex++) {
        const ring = rings[teamIndex];
        const team = ringTeams[teamIndex] ?? 0;
        if (ring === undefined) continue;
        let count = 0;
        for (const entity of game.entities) {
          if (entity.garrisonId !== null || entity.team !== team) continue;
          if (team !== 0 && !game.visibleAt(entity.x, entity.z)) continue;
          // Only the selection is ringed: the painted apron already frames every building.
          if (!selected.has(entity.id)) continue;
          const radius = entity.r + 0.4;
          const at = pose(entity);
          _dummy.position.set(at.x, terrainHeight(at.x, at.z) + 0.13, at.z);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.set(radius, 1, radius);
          _dummy.updateMatrix();
          ring.setMatrixAt(count, _dummy.matrix);
          ringBackings.setMatrixAt(backingCount++, _dummy.matrix);
          count += 1;
        }
        ring.count = count;
        upload(ring.instanceMatrix, count);
      }
      ringBackings.count = backingCount;
      upload(ringBackings.instanceMatrix, backingCount);

      barCount = 0;
      for (const entity of game.entities) {
        if (entity.garrisonId !== null) continue;
        if (entity.team > 0 && !game.visibleAt(entity.x, entity.z)) continue;
        const hurt = entity.hp < entity.maxHp - 0.1;
        // A unit earns a bar once something has happened to it, or once it is selected; a building
        // always has one, because its queue and its build site are the numbers being watched.
        if (!entity.building && !hurt && !selected.has(entity.id)) continue;
        const health = entity.maxHp > 0 ? entity.hp / entity.maxHp : 0;
        const building = entity.building && !entity.built;
        pushBar(
          entity,
          health,
          entity.team > 0
            ? (_teamFill[entity.team] ?? _friendly)
            : health < 0.3
              ? _hurt
              : _friendly,
          !entity.building ? 0 : building ? entity.progress : (entity.queue[0]?.progress ?? 0),
          building ? _work : _queue,
        );
      }
      bars.count = barCount;
      upload(bars.instanceMatrix, barCount);
      if (bars.instanceColor !== null) upload(bars.instanceColor, barCount);

      let live = 0;
      for (const slot of markers) {
        if (slot.life <= 0) continue;
        slot.life -= dt;
        _dummy.position.set(slot.x, terrainHeight(slot.x, slot.z) + 0.16, slot.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.setScalar(1 + (1 - slot.life / MARKER_LIFE) * 3);
        _dummy.updateMatrix();
        markerRings.setMatrixAt(live, _dummy.matrix);
        markerBackings.setMatrixAt(live, _dummy.matrix);
        live += 1;
      }
      markerRings.count = live;
      markerBackings.count = live;
      upload(markerRings.instanceMatrix, live);
      upload(markerBackings.instanceMatrix, live);
    },
    dispose: () => {
      // The model geometries belong to `models`, which frees them; the materials are shared by
      // every model and by a later rebuild, so nothing here disposes one.
      for (const entry of batches.values())
        for (const part of entry.parts) {
          receivers.removed?.(part);
          root.remove(part);
        }
      batches.clear();
      for (const ring of rings) {
        ring.geometry.dispose();
        (ring.material as MeshBasicMaterial).dispose();
      }
      bars.geometry.dispose();
      (bars.material as MeshBasicMaterial).dispose();
      markerRings.geometry.dispose();
      (markerRings.material as MeshBasicMaterial).dispose();
      ringBackings.geometry.dispose();
      markerBackings.geometry.dispose();
      backingMaterial.dispose();
      root.remove(ringBackings, markerBackings);
    },
  };
}

/**
 * Send the GPU only the slots a batch is using. Every mesh here is sized for the supply cap, so a
 * whole-buffer upload is 8 KB per mesh per frame for the two or three copies actually on the
 * field; across the ~45 meshes that is tens of megabytes a second of writes the driver stalls on.
 *
 * The range is held here rather than minted per upload: `addUpdateRange` pushes a fresh
 * `{ start, count }`, and this runs ~45 times a frame. Both installed backends empty `updateRanges`
 * after the upload, so the record is put back each time — a reused one costs a write, a new one
 * costs a collection. A mesh that swaps its attribute gets a fresh record, because the record is
 * keyed by the attribute it describes.
 */
const _ranges = new WeakMap<BufferAttribute, { start: number; count: number }>();

function upload(attribute: BufferAttribute, live: number): void {
  if (live === 0) return;
  const count = live * attribute.itemSize;
  let range = _ranges.get(attribute);
  if (range === undefined) {
    range = { start: 0, count };
    _ranges.set(attribute, range);
  } else range.count = count;
  attribute.clearUpdateRanges();
  attribute.updateRanges.push(range);
  attribute.needsUpdate = true;
}

/** Standing bob, per-unit phased by id so a column of workers does not rise as one board. */
function bob(entity: IEntity, time: number): number {
  if (entity.air) return Math.sin(time * 2 + entity.id) * 0.19;
  if (entity.type === "hover") return Math.sin(time * 3 + entity.id) * 0.13;
  return 0;
}

/** In sight right now, or at least once: the difference between "no contact" and "no idea". */
function seen(game: Game, entity: IEntity): boolean {
  const x = Math.floor((entity.x + HALF) / game.cell);
  const z = Math.floor((entity.z + HALF) / game.cell);
  if (x < 0 || z < 0 || x >= game.gridSize || z >= game.gridSize) return false;
  return game.explored[z * game.gridSize + x] === 1;
}
