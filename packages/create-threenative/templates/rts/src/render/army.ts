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
  PlaneGeometry,
  RingGeometry,
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
/** Bar thickness, in metres. Enough to read at the closest zoom, thin enough not to crowd. */
const BAR = 0.34;
const MARKER_LIFE = 0.8;

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
  readonly sync: (
    game: Game,
    selected: ReadonlySet<number>,
    time: number,
    dt: number,
    camera: Camera,
  ) => void;
  readonly dispose: () => void;
}

const _dummy = new Object3D();
const _tint = new Color();
const _friendly = new Color(0x9be6bb);
const _hurt = new Color(0xddad71);
const _hostile = new Color(0xff8756);
const _work = new Color(0x77eddf);
const _queue = new Color(0x77cddd);
const _backing = new Color(palette.gridLine);

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

  /**
   * One readout: a fill over its own backdrop, both camera-facing quads, the fill growing from
   * the left so a half-full bar reads as "half" rather than as "small".
   */
  const pushBar = (entity: IEntity, width: number, fraction: number, y: number, colour: Color) => {
    const height = terrainHeight(entity.x, entity.z) + y;
    _dummy.quaternion.copy(camera.quaternion);
    _dummy.position.set(entity.x, height, entity.z);
    _dummy.scale.set(width, BAR, 1);
    _dummy.updateMatrix();
    bars.setMatrixAt(barCount, _dummy.matrix);
    bars.setColorAt(barCount, _backing);
    barCount += 1;
    const fill = width * Math.max(0, Math.min(1, fraction));
    if (fill <= 0) return;
    _dummy.scale.set(fill, BAR * 0.7, 1);
    _dummy.updateMatrix();
    _dummy.translateX((fill - width) / 2);
    _dummy.updateMatrix();
    bars.setMatrixAt(barCount, _dummy.matrix);
    bars.setColorAt(barCount, colour);
    barCount += 1;
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
    sync: (game, selected, time, dt, view) => {
      camera = view;
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
          _dummy.position.set(
            entity.x,
            terrainHeight(entity.x, entity.z) + (entity.altitude || 0) + bob(entity, time),
            entity.z,
          );
          _dummy.rotation.set(
            0,
            entity.angle,
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
          upload(part.instanceMatrix, part.count);
          // The instance-aware bound, or the batch is culled by its own geometry's origin-sized
          // sphere and half the battlefield silently disappears.
          part.computeBoundingSphere();
        }
      }

      for (let teamIndex = 0; teamIndex < rings.length; teamIndex++) {
        const ring = rings[teamIndex];
        const team = ringTeams[teamIndex] ?? 0;
        if (ring === undefined) continue;
        let count = 0;
        for (const entity of game.entities) {
          if (entity.garrisonId !== null || entity.team !== team) continue;
          if (team !== 0 && !game.visibleAt(entity.x, entity.z)) continue;
          if (!entity.building && !selected.has(entity.id)) continue;
          const radius = entity.r + 0.4;
          _dummy.position.set(entity.x, terrainHeight(entity.x, entity.z) + 0.13, entity.z);
          _dummy.rotation.set(0, 0, 0);
          _dummy.scale.set(radius, 1, radius);
          _dummy.updateMatrix();
          ring.setMatrixAt(count, _dummy.matrix);
          count += 1;
        }
        ring.count = count;
        upload(ring.instanceMatrix, count);
      }

      barCount = 0;
      for (const entity of game.entities) {
        if (entity.garrisonId !== null) continue;
        if (entity.team > 0 && !game.visibleAt(entity.x, entity.z)) continue;
        const hurt = entity.hp < entity.maxHp - 0.1;
        // A unit earns a bar once something has happened to it, or once it is selected; a building
        // always has one, because its queue and its build site are the numbers being watched.
        if (!entity.building && !hurt && !selected.has(entity.id)) continue;
        const width = entity.building ? 6 : 3;
        const y =
          (entity.altitude || 0) +
          (entity.air ? 2.1 : entity.building ? TYPES[entity.type].r + 1.3 : 3.1);
        pushBar(
          entity,
          width,
          entity.maxHp > 0 ? entity.hp / entity.maxHp : 0,
          y,
          entity.team > 0 ? _hostile : hurt ? _hurt : _friendly,
        );
        if (entity.building && !entity.built)
          pushBar(entity, width, entity.progress, y - 0.9, _work);
        else if (entity.queue.length > 0)
          pushBar(entity, width, entity.queue[0]?.progress ?? 0, y - 0.9, _queue);
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
        live += 1;
      }
      markerRings.count = live;
      upload(markerRings.instanceMatrix, live);
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
