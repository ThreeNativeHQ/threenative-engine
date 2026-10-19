import type { Vector3 } from "three";
import { unionBounds } from "./world-region.js";
import type { Heightfield, IHeightfieldRegionBounds } from "./world.js";

/**
 * What one contact footprint wants at a local offset, sampled in the contact's own frame.
 *
 * A footprint describes a shape, never a load: the same sole sinks deeper under a heavier
 * contact. Every field is 0..1 except `relief`, which is metres.
 */
export interface ISnowFootprintSample {
  /** 0..1 fraction of the footprint touching snow here; erases displaced bank and adds compaction. */
  readonly coverage: number;
  /** 0..1 relative depth at this offset, so a toe can press deeper than a heel. */
  readonly shape: number;
  /** Metres of tread relief subtracted from the impression at this offset. */
  readonly relief: number;
  /** 0..1 raised snow pushed out beside the contact at this offset. */
  readonly bank: number;
  /** 0..1 surface disturbance at this offset, for render shading and game queries. */
  readonly disturbance: number;
}

/** A game-authored contact shape: a boot sole, a tyre, a hull, a sphere. */
export interface ISnowFootprint {
  /** Half-width of the square sampled around the contact centre, in metres. */
  readonly extent: number;
  /** Local contact-space sample; +z runs forward along the contact's orientation. */
  readonly sample: (x: number, z: number) => ISnowFootprintSample;
}

/** One contact between a supported object and the snow surface. */
export interface ISnowContact {
  readonly x: number;
  readonly z: number;
  /** Game-authored imprint shape. */
  readonly footprint: ISnowFootprint;
  /** Supported contact area in square metres. Pressure is load over area, never a fixed constant. */
  readonly area: number;
  /** Normal load in newtons. */
  readonly load: number;
  /** Orientation about +y in radians. Default 0. */
  readonly rotation?: number;
  /** 0..1 snow hardness. Defaults to the field's hardness. */
  readonly hardness?: number;
  /** Seconds the contact is applied. Defaults to the field's response time. */
  readonly duration?: number;
}

/** The four snow channels at one world position. */
export interface ISnowFieldSample {
  readonly indent: number;
  readonly bank: number;
  readonly compaction: number;
  readonly disturbance: number;
}

export interface ISnowFieldOptions {
  /** The canonical terrain. Snow composes onto it; there is no second terrain representation. */
  readonly field: Heightfield;
  /** Snow depth in metres. Zero is bare ground. Default 0.28. */
  readonly depth?: number;
  /** 0..1 snow hardness used by contacts that do not override it. Default 0.3. */
  readonly hardness?: number;
  /** Fraction of its target impression a contact reaches in one response time. Default 0.9. */
  readonly yieldFraction?: number;
  /** Metres of raised bank allowed beside a contact. Default 0.085. */
  readonly maxBank?: number;
  /** Seconds a fully-loaded contact takes to reach its full impression. Default 0.1. */
  readonly responseTime?: number;
}

export interface ISnowDiscFootprintOptions {
  /** 0..1 width of the falloff at the disc's edge, as a fraction of the radius. Default 0.25. */
  readonly softness?: number;
}

/** Resistance of snow to a contact at hardness 0, in pascals. Approximate, not a calibrated law. */
const PRESSURE_RESISTANCE_BASE = 18_000;
/** Extra resistance a fully hard contact meets at hardness 1, in pascals. */
const PRESSURE_RESISTANCE_HARDNESS = 140_000;
/** Fraction of the snow depth a contact reaches before it is fully loaded. */
const PRESSURE_DEPTH_FLOOR = 0.16;
/** Deepest fraction of the snow depth any single contact can reach. */
const MAX_PENETRATION_FRACTION = 0.82;
/** Deepest fraction of the snow depth indentation may reach before a contact stops compacting. */
const MAX_INDENT_FRACTION = 0.88;
/** Fraction of a contact's penetration that becomes raised bank height. */
const BANK_LOAD_SCALE = 0.38;
/** Below these channel values a recovered cell is fully buried and leaves the active set. */
const RECOVERED_INDENT = 0.0004;
const RECOVERED_COMPACTION = 0.008;
/** Wind decay per metre per second of wind, matched to the source study's feel. */
const WIND_EROSION = 0.00065;
/** Deposition burial rate per metre of fill. */
const DEPOSITION_BURIAL = 26;
/** Hard ceiling on cells one contact may span, so a malformed extent fails instead of allocating. */
const MAX_CONTACT_CELLS = 1 << 20;

const EMPTY_SAMPLE: ISnowFootprintSample = Object.freeze({
  bank: 0,
  coverage: 0,
  disturbance: 0,
  relief: 0,
  shape: 0,
});

/** The single-cell window a grid index covers. */
function cellBounds(index: number, columns: number): IHeightfieldRegionBounds {
  const row = Math.floor(index / columns);
  return { column: index - row * columns, columns: 1, row, rows: 1 };
}

/** The smallest window covering both inputs. */

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`SnowField ${name} must be finite.`);
  return value;
}

function nonNegative(value: number, name: string): number {
  finite(value, name);
  if (value < 0) throw new Error(`SnowField ${name} must not be negative.`);
  return value;
}

function positive(value: number, name: string): number {
  nonNegative(value, name);
  if (value === 0) throw new Error(`SnowField ${name} must be greater than zero.`);
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function unit(sample: ISnowFootprintSample, name: string): ISnowFootprintSample {
  const coverage = finite(sample.coverage, `${name}.coverage`);
  const shape = finite(sample.shape, `${name}.shape`);
  const relief = finite(sample.relief, `${name}.relief`);
  const bank = finite(sample.bank, `${name}.bank`);
  const disturbance = finite(sample.disturbance, `${name}.disturbance`);
  if (relief < 0) throw new Error(`SnowField ${name}.relief must not be negative.`);
  return {
    bank: clamp(bank, 0, 1),
    coverage: clamp(coverage, 0, 1),
    disturbance: clamp(disturbance, 0, 1),
    relief,
    shape: clamp(shape, 0, 1),
  };
}

/**
 * A circular contact footprint, sized from a radius the caller measures.
 *
 * The shape a sphere, a ball, a wheel or a probe presses into snow, and the default the physics
 * binding derives from a sphere's contact geometry. Flat inside the radius, eased over the
 * softness band, with a raised rim just outside it.
 * @situation press a ball, wheel or probe into snow
 * @situation give a sphere a physically sized snow contact instead of a boot shape
 * @constraint radius is metres; the footprint never grows with load, only deeper
 * @override softness widens the eased edge without changing the contact radius
 * @example const footprint = snowDiscFootprint(0.25);
 */
export function snowDiscFootprint(
  radius: number,
  options: ISnowDiscFootprintOptions = {},
): ISnowFootprint {
  positive(radius, "disc radius");
  const softness = clamp(finite(options.softness ?? 0.25, "disc softness"), 0.01, 1);
  const inner = 1 - softness;
  const outer = 1 + softness;
  return {
    extent: radius * outer,
    sample: (x, z) => {
      const distance = Math.hypot(x, z) / radius;
      if (distance >= outer) return EMPTY_SAMPLE;
      const coverage = distance <= inner ? 1 : 1 - smoothstep(inner, 1, distance);
      const bank = distance > 1 ? Math.exp(-(((distance - 1) / (softness * 0.75)) ** 2)) : 0;
      return {
        bank,
        coverage,
        disturbance: Math.max(coverage, bank * 0.5),
        relief: 0,
        shape: 1,
      };
    },
  };
}

/**
 * Persistent snow deformation over one canonical heightfield.
 *
 * Snow keeps four channels per cell — indentation, displaced bank, compaction and disturbance —
 * and writes the combined surface (`terrain + depth + bank - indent`) back into the heightfield
 * it was given. Queries, rendered geometry and collider export therefore all read one surface,
 * and no second terrain representation exists.
 *
 * The field is numeric only: it never chooses a boot, a tread, a particle, a material or a
 * camera. Games supply terrain heights, the snow depth, the contact profile and the response
 * coefficients; this class owns the storage, the load-dependent penetration and the bounded
 * recovery. It is a heightfield approximation — not granular snow, displaced-volume
 * conservation, avalanches, melting or a calibrated material law.
 * @situation leave footprints, tracks and tyre ruts in snow that persist and fill in over time
 * @situation let a pushed sphere carve a connected track and a dropped one settle into a crater
 * @situation store snow deformation that rendered geometry and collision both read
 * @situation reset a snowfield between rounds or change its depth at runtime
 * @situation show how packed the snow is where people have walked or objects have rested
 * @constraint the field composes onto a Heightfield; construct the terrain first and let this own the surface
 * @constraint zero depth is bare ground: contacts register no indentation at all
 * @constraint out-of-region heightAt and normalAt follow Heightfield's error contract; sample returns zeros
 * @override depth, hardness, yieldFraction, maxBank and responseTime name the response coefficients
 * @requires @threenative/core/world Heightfield as the canonical terrain and surface
 * @example import { Heightfield } from "@threenative/core/world";
 * const terrain = Heightfield.fromSampler({ rows: 129, columns: 129, width: 64, depth: 64, origin: { x: 0, z: 0 }, sampleHeight: (x, z) => Math.sin(x * 0.1) * 0.5 });
 * const snow = new SnowField({ field: terrain, depth: 0.28, hardness: 0.3 });
 * snow.stamp({ x: 0, z: 0, area: 0.074, load: 784, duration: 0.1, footprint: snowDiscFootprint(0.12) });
 * snow.recover(1 / 60, 0.0012, 0.4);
 */
export class SnowField {
  /** Canonical terrain and the surface snow composes onto. */
  readonly field: Heightfield;
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellDepth: number;
  /** World x of column 0. */
  readonly minimumX: number;
  /** World z of row 0. */
  readonly minimumZ: number;
  /** 0..1 snow hardness used by contacts that do not override it. */
  hardness: number;
  /** Fraction of its target impression a contact reaches in one response time. */
  readonly yieldFraction: number;
  /** Metres of raised bank allowed beside a contact. */
  readonly maxBank: number;
  /** Seconds a fully-loaded contact takes to reach its full impression. */
  readonly responseTime: number;
  #depth: number;
  readonly #base: Float32Array;
  readonly #indent: Float32Array;
  readonly #bank: Float32Array;
  readonly #compaction: Float32Array;
  readonly #disturbance: Float32Array;
  readonly #active = new Set<number>();
  #steps = 0;
  #lastSink = 0;
  #version = 0;
  #dirty: IHeightfieldRegionBounds | undefined;
  #untaken: IHeightfieldRegionBounds | undefined;
  #scratch = new Float32Array(0);

  constructor(options: ISnowFieldOptions) {
    const field = options.field;
    if (typeof field?.updateHeights !== "function")
      throw new Error("SnowField requires a Heightfield as its canonical terrain.");
    this.field = field;
    this.columns = field.columns;
    this.rows = field.rows;
    this.cellWidth = field.width / (field.columns - 1);
    this.cellDepth = field.depth / (field.rows - 1);
    this.minimumX = field.origin.x - field.width / 2;
    this.minimumZ = field.origin.z - field.depth / 2;
    this.#depth = nonNegative(options.depth ?? 0.28, "depth");
    this.hardness = clamp(finite(options.hardness ?? 0.3, "hardness"), 0, 1);
    this.yieldFraction = clamp(finite(options.yieldFraction ?? 0.9, "yieldFraction"), 0, 1);
    this.maxBank = nonNegative(options.maxBank ?? 0.085, "maxBank");
    this.responseTime = positive(options.responseTime ?? 0.1, "responseTime");
    this.#base = field.heights;
    const cells = this.columns * this.rows;
    this.#indent = new Float32Array(cells);
    this.#bank = new Float32Array(cells);
    this.#compaction = new Float32Array(cells);
    this.#disturbance = new Float32Array(cells);
    // The untouched surface already stands `depth` above the terrain, before any contact.
    this.#flush({ column: 0, columns: this.columns, row: 0, rows: this.rows });
  }

  /** Snow depth in metres. Zero is bare ground. */
  get depth(): number {
    return this.#depth;
  }

  /** Contacts applied since construction or the last reset. */
  get steps(): number {
    return this.#steps;
  }

  /** Penetration the most recent contact reached, in metres. */
  get lastSink(): number {
    return this.#lastSink;
  }

  /** Cells still carrying deformation. Recovery drops a cell once it is fully buried. */
  get activeCells(): number {
    return this.#active.size;
  }

  /** Monotonic version, incremented once per batch that changed the canonical surface. */
  get version(): number {
    return this.#version;
  }

  /** Window of the canonical field the last change wrote, or undefined before the first change. */
  get dirtyRegion(): IHeightfieldRegionBounds | undefined {
    return this.#dirty === undefined ? undefined : { ...this.#dirty };
  }

  /**
   * Union of every window written since the previous call, then forgotten.
   *
   * One fixed step can write several windows — each contact, then recovery — and `dirtyRegion`
   * keeps only the last, so a renderer that refreshes geometry once per drawn frame takes this
   * instead. It has one owner: two consumers taking it would each miss the other's windows.
   */
  takeDirtyRegion(): IHeightfieldRegionBounds | undefined {
    const region = this.#untaken;
    this.#untaken = undefined;
    return region;
  }

  /** Bytes retained by the four snow channels and the base terrain copy. */
  get memoryBytes(): number {
    return (4 * this.#indent.length + this.#base.length) * Float32Array.BYTES_PER_ELEMENT;
  }

  /**
   * The four snow channels at a world position, bilinearly interpolated.
   *
   * Returns zeros outside the field rather than throwing, so a caller sweeping a broad area does
   * not have to bounds-check first. `heightAt` keeps the strict contract.
   */
  sample(x: number, z: number): ISnowFieldSample {
    finite(x, "query x");
    finite(z, "query z");
    const column = (x - this.minimumX) / this.cellWidth;
    const row = (z - this.minimumZ) / this.cellDepth;
    if (column < 0 || row < 0 || column > this.columns - 1 || row > this.rows - 1)
      return { bank: 0, compaction: 0, disturbance: 0, indent: 0 };
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(this.columns - 1, column0 + 1);
    const row1 = Math.min(this.rows - 1, row0 + 1);
    const columnMix = column - column0;
    const rowMix = row - row0;
    const channel = (values: Float32Array): number =>
      lerp(
        lerp(
          values[row0 * this.columns + column0] as number,
          values[row0 * this.columns + column1] as number,
          columnMix,
        ),
        lerp(
          values[row1 * this.columns + column0] as number,
          values[row1 * this.columns + column1] as number,
          columnMix,
        ),
        rowMix,
      );
    return {
      bank: channel(this.#bank),
      compaction: channel(this.#compaction),
      disturbance: channel(this.#disturbance),
      indent: channel(this.#indent),
    };
  }

  /**
   * One channel over a window of cells, row-major, written into `target` (allocated when absent
   * or too small) and returned. The bulk read a renderer uses to encode a refreshed window: a
   * `sample` per vertex costs a bilinear lookup and an object each, and a refill window is
   * thousands of vertices. A window outside the field throws.
   */
  copyChannel(
    channel: keyof ISnowFieldSample,
    bounds: IHeightfieldRegionBounds,
    target?: Float32Array,
  ): Float32Array {
    const values =
      channel === "indent"
        ? this.#indent
        : channel === "bank"
          ? this.#bank
          : channel === "compaction"
            ? this.#compaction
            : channel === "disturbance"
              ? this.#disturbance
              : undefined;
    if (values === undefined) throw new Error(`SnowField has no channel '${String(channel)}'.`);
    const { column, columns, row, rows } = bounds;
    if (
      !Number.isInteger(column) ||
      !Number.isInteger(row) ||
      !Number.isInteger(columns) ||
      !Number.isInteger(rows) ||
      column < 0 ||
      row < 0 ||
      columns < 1 ||
      rows < 1 ||
      column + columns > this.columns ||
      row + rows > this.rows
    )
      throw new Error("SnowField.copyChannel window must lie inside the field.");
    const output =
      target !== undefined && target.length >= columns * rows
        ? target
        : new Float32Array(columns * rows);
    for (let index = 0; index < rows; index += 1) {
      const start = (row + index) * this.columns + column;
      output.set(values.subarray(start, start + columns), index * columns);
    }
    return output;
  }

  /** Snow surface height at a world position, from the same samples geometry and collision read. */
  heightAt(x: number, z: number): number {
    return this.field.heightAt(x, z);
  }

  /** Surface normal at a world position. */
  normalAt(x: number, z: number, target?: Vector3): Vector3 {
    return target === undefined ? this.field.normalAt(x, z) : this.field.normalAt(x, z, target);
  }

  /**
   * How far towards its target impression a contact has travelled after `seconds`.
   *
   * The remaining distance shrinks geometrically, so the same total contact time reaches the same
   * depth however it is split across ticks. That is what keeps deformation independent of
   * presentation rate without touching the fixed physics timestep.
   */
  #fraction(seconds: number): number {
    if (seconds <= 0) return 0;
    if (this.yieldFraction >= 1) return 1;
    return 1 - (1 - this.yieldFraction) ** (seconds / this.responseTime);
  }

  /**
   * Press one contact into the snow and return the penetration it reached, in metres.
   *
   * Pressure is `load / area`, so the same profile responds to how much weight it carries and how
   * widely that weight is spread. `duration` scales how far the contact gets towards its target
   * impression, which is what makes a run of shorter contacts agree with one long one. A contact
   * entirely outside the field returns 0 and leaves the version unchanged.
   */
  stamp(contact: ISnowContact): number {
    const resolved = this.#requireContact(contact);
    if (this.#depth <= 0) return 0;
    const penetration = this.#penetration(resolved.hardness, contact.load, contact.area);
    if (penetration <= 0) return 0;
    const fraction = this.#fraction(contact.duration ?? this.responseTime);
    if (fraction <= 0) return 0;
    if (!this.#overlaps(resolved)) return 0;
    const window = this.#contactWindow(resolved.x, resolved.z, resolved.extent);
    if (!this.#pressWindow(window, resolved, penetration, fraction)) return 0;
    this.#steps += 1;
    this.#lastSink = penetration;
    this.#flush({
      column: window.firstColumn,
      columns: window.lastColumn - window.firstColumn + 1,
      row: window.firstRow,
      rows: window.lastRow - window.firstRow + 1,
    });
    return penetration;
  }

  /** Depth a contact reaches: pressure against snow resistance, bounded by the snow depth. */
  #penetration(hardness: number, load: number, area: number): number {
    const resistance = PRESSURE_RESISTANCE_BASE + hardness ** 1.5 * PRESSURE_RESISTANCE_HARDNESS;
    return clamp(
      this.#depth * (PRESSURE_DEPTH_FLOOR + load / area / resistance),
      0,
      this.#depth * MAX_PENETRATION_FRACTION,
    );
  }

  /** Whether a contact's bounding square reaches any part of the field. */
  #overlaps(contact: { readonly extent: number; readonly x: number; readonly z: number }): boolean {
    if (
      contact.x + contact.extent < this.minimumX ||
      contact.x - contact.extent > this.minimumX + this.field.width
    )
      return false;
    return !(
      contact.z + contact.extent < this.minimumZ ||
      contact.z - contact.extent > this.minimumZ + this.field.depth
    );
  }

  /** Sample the footprint across its window, returning whether any cell changed. */
  #pressWindow(
    window: {
      readonly firstColumn: number;
      readonly firstRow: number;
      readonly lastColumn: number;
      readonly lastRow: number;
    },
    contact: {
      readonly cosine: number;
      readonly footprint: ISnowFootprint;
      readonly hardness: number;
      readonly sine: number;
      readonly x: number;
      readonly z: number;
    },
    penetration: number,
    fraction: number,
  ): boolean {
    let touched = false;
    for (let row = window.firstRow; row <= window.lastRow; row += 1) {
      const localZ = this.minimumZ + row * this.cellDepth - contact.z;
      for (let column = window.firstColumn; column <= window.lastColumn; column += 1) {
        const localX = this.minimumX + column * this.cellWidth - contact.x;
        const sample = unit(
          contact.footprint.sample(
            localX * contact.cosine - localZ * contact.sine,
            localX * contact.sine + localZ * contact.cosine,
          ),
          "footprint sample",
        );
        if (sample.coverage <= 0 && sample.bank <= 0) continue;
        this.#applySample(
          row * this.columns + column,
          sample,
          penetration,
          fraction,
          contact.hardness,
        );
        touched = true;
      }
    }
    return touched;
  }

  /** Reject a malformed contact before any part of the surface changes. */
  #requireContact(contact: ISnowContact): {
    readonly cosine: number;
    readonly extent: number;
    readonly footprint: ISnowFootprint;
    readonly hardness: number;
    readonly sine: number;
    readonly x: number;
    readonly z: number;
  } {
    const x = finite(contact.x, "contact x");
    const z = finite(contact.z, "contact z");
    positive(contact.area, "contact area");
    nonNegative(contact.load, "contact load");
    const rotation = finite(contact.rotation ?? 0, "contact rotation");
    nonNegative(contact.duration ?? this.responseTime, "contact duration");
    const footprint = contact.footprint;
    if (typeof footprint?.sample !== "function")
      throw new Error("SnowField contact requires a footprint with a sample function.");
    return {
      cosine: Math.cos(rotation),
      extent: positive(footprint.extent, "footprint extent"),
      footprint,
      hardness: clamp(finite(contact.hardness ?? this.hardness, "contact hardness"), 0, 1),
      sine: Math.sin(rotation),
      x,
      z,
    };
  }

  /**
   * The grid window a contact covers, rejected when its footprint spans more cells than allowed.
   *
   * The span is measured before clipping to the grid: a footprint larger than the field is
   * malformed rather than merely wasteful, and must fail instead of allocating a window for it.
   */
  #contactWindow(
    x: number,
    z: number,
    extent: number,
  ): {
    readonly firstColumn: number;
    readonly firstRow: number;
    readonly lastColumn: number;
    readonly lastRow: number;
  } {
    const lowColumn = Math.floor((x - extent - this.minimumX) / this.cellWidth);
    const highColumn = Math.ceil((x + extent - this.minimumX) / this.cellWidth);
    const lowRow = Math.floor((z - extent - this.minimumZ) / this.cellDepth);
    const highRow = Math.ceil((z + extent - this.minimumZ) / this.cellDepth);
    const spanned = (highColumn - lowColumn + 1) * (highRow - lowRow + 1);
    if (spanned > MAX_CONTACT_CELLS)
      throw new Error(
        `SnowField contact footprint spans ${String(spanned)} cells, above the ${String(MAX_CONTACT_CELLS)}-cell limit.`,
      );
    return {
      firstColumn: clamp(lowColumn, 0, this.columns - 1),
      firstRow: clamp(lowRow, 0, this.rows - 1),
      lastColumn: clamp(highColumn, 0, this.columns - 1),
      lastRow: clamp(highRow, 0, this.rows - 1),
    };
  }

  /**
   * Apply one footprint sample to one cell.
   *
   * Contact first erases displaced bank and records compaction and disturbance; the rim then
   * raises bank beside the contact. That order is the source study's and is what keeps its
   * regression fixture reproducible.
   */
  #applySample(
    index: number,
    sample: ISnowFootprintSample,
    penetration: number,
    fraction: number,
    hardness: number,
  ): void {
    if (sample.coverage > 0) {
      const target = Math.max(0, penetration * sample.shape - sample.relief) * sample.coverage;
      const oldIndent = this.#indent[index] as number;
      this.#indent[index] = Math.min(
        this.#depth * MAX_INDENT_FRACTION,
        Math.max(oldIndent, lerp(oldIndent, target, fraction)),
      );
      this.#bank[index] = (this.#bank[index] as number) * (1 - sample.coverage);
      this.#compaction[index] = Math.min(
        1,
        Math.max(this.#compaction[index] as number, sample.coverage * (0.72 + 0.23 * hardness)),
      );
      this.#disturbance[index] = Math.max(this.#disturbance[index] as number, sample.coverage);
    }
    if (sample.bank > 0) {
      this.#bank[index] = Math.min(
        this.maxBank,
        Math.max(this.#bank[index] as number, penetration * BANK_LOAD_SCALE * sample.bank),
      );
      this.#disturbance[index] = Math.max(this.#disturbance[index] as number, sample.disturbance);
    }
    this.#active.add(index);
  }

  /**
   * Let snowfall fill depressions and wind soften banks over `seconds`.
   *
   * Deposition and wind are rates, so this is presentation-rate independent: a second of
   * simulation recovers the same amount however many ticks it was split into. It accelerates
   * deposition only — never gravity, movement, falling flakes or the physics timestep.
   */
  recover(seconds: number, deposition: number, wind: number): void {
    const dt = nonNegative(seconds, "recovery seconds");
    if (dt === 0) return;
    const depositionRate = nonNegative(deposition, "recovery deposition");
    const windRate = nonNegative(wind, "recovery wind");
    if ((depositionRate === 0 && windRate === 0) || this.#active.size === 0) return;
    const raise = depositionRate * dt;
    const erosion = Math.exp(-windRate * dt * WIND_EROSION);
    const burial = Math.exp(-raise * DEPOSITION_BURIAL);
    let dirty: IHeightfieldRegionBounds | undefined;
    for (const index of this.#active) {
      this.#recoverCell(index, raise, erosion, burial);
      dirty = unionBounds(dirty, cellBounds(index, this.columns));
    }
    if (dirty === undefined) return;
    this.#flush(dirty);
  }

  /**
   * Apply one tick of deposition and wind to one cell, releasing it once it is fully buried.
   */
  #recoverCell(index: number, raise: number, erosion: number, burial: number): void {
    const indent = Math.max(0, (this.#indent[index] as number) - raise);
    const bank = (this.#bank[index] as number) * erosion;
    const compaction = (this.#compaction[index] as number) * burial;
    const disturbance = (this.#disturbance[index] as number) * burial * erosion;
    this.#indent[index] = indent;
    this.#bank[index] = bank;
    this.#compaction[index] = compaction;
    this.#disturbance[index] = disturbance;
    if (
      indent >= RECOVERED_INDENT ||
      bank >= RECOVERED_INDENT ||
      compaction >= RECOVERED_COMPACTION
    )
      return;
    this.#indent[index] = 0;
    this.#bank[index] = 0;
    this.#compaction[index] = 0;
    this.#disturbance[index] = 0;
    this.#active.delete(index);
  }

  /**
   * Change the snow depth in metres and push the new surface through the canonical field.
   *
   * Existing indentation is capped to the new depth rather than scaled, so deepening snow does
   * not erase tracks and shallowing it buries them.
   */
  setDepth(depth: number): void {
    const next = nonNegative(depth, "depth");
    if (next === this.#depth) return;
    this.#depth = next;
    const limit = next * MAX_INDENT_FRACTION;
    for (const index of this.#active)
      this.#indent[index] = Math.min(this.#indent[index] as number, limit);
    this.#flush({ column: 0, columns: this.columns, row: 0, rows: this.rows });
  }

  /** Clear every track, bank and compaction record and return the surface to bare snow. */
  reset(): void {
    this.#indent.fill(0);
    this.#bank.fill(0);
    this.#compaction.fill(0);
    this.#disturbance.fill(0);
    this.#active.clear();
    this.#steps = 0;
    this.#lastSink = 0;
    this.#flush({ column: 0, columns: this.columns, row: 0, rows: this.rows });
  }

  /** Combine one window of channels with the base terrain and hand it to the canonical field. */
  #flush(bounds: IHeightfieldRegionBounds): void {
    const samples = bounds.columns * bounds.rows;
    if (this.#scratch.length < samples) this.#scratch = new Float32Array(samples);
    const heights = this.#scratch.subarray(0, samples);
    for (let row = 0; row < bounds.rows; row += 1) {
      for (let column = 0; column < bounds.columns; column += 1) {
        const source = (bounds.row + row) * this.columns + (bounds.column + column);
        heights[row * bounds.columns + column] =
          (this.#base[source] as number) +
          this.#depth +
          (this.#bank[source] as number) -
          (this.#indent[source] as number);
      }
    }
    // The scratch buffer is written straight through: updateHeights copies before it returns.
    this.field.updateHeights({ ...bounds, heights });
    this.#dirty = { ...bounds };
    this.#untaken = unionBounds(this.#untaken, bounds);
    this.#version += 1;
  }
}
