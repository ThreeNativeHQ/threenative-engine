// Generated for you. How the snow looks: its colour, the blue in a pressed footprint, the
// compaction view, the glints. `SnowField` stores numbers; everything a screenshot shows is here.
import { BufferAttribute, type BufferGeometry, Mesh, PlaneGeometry } from "three";
import {
  attribute,
  color,
  dot,
  float,
  floor,
  fwidth,
  hash,
  max,
  mix,
  normalView,
  normalWorld,
  positionViewDirection,
  positionWorld,
  pow,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { terrainHeight } from "../terrain.js";
import { palette } from "./palette.js";

/** Per-vertex snow state the material reads: indentation (m) and compaction (0..1). */
const STATE = "snowState";
/** A window up to this many samples is redrawn at once; wider ones are sliced. */
const URGENT_CELLS = 12_000;
/** A wide window is spread over about this many frames, never fewer than eight rows a frame. */
const SLICE_FRAMES = 15;
const SLICE_ROWS = 8;
/** More separate windows than this waiting for one draw are merged into their bounding box. */
const MAX_URGENT_WINDOWS = 16;

type Bounds = {
  readonly column: number;
  readonly columns: number;
  readonly row: number;
  readonly rows: number;
};

/** The parts of `SnowField` (and its `Heightfield`) this renderer reads, by shape. */
export interface ISnowSource {
  readonly depth: number;
  readonly field: {
    readonly columns: number;
    readonly rows: number;
    readonly width: number;
    readonly depth: number;
    readonly origin: { readonly x: number; readonly z: number };
    toGeometry(): BufferGeometry;
    refreshGeometry(geometry: BufferGeometry, bounds?: Bounds): void;
    toColliderHeights(): Float32Array;
  };
  takeDirtyRegions(): readonly Bounds[];
  copyChannel(
    channel: "indent" | "compaction",
    bounds: Bounds,
    target?: Float32Array,
  ): Float32Array;
}

function union(current: Bounds | undefined, next: Bounds): Bounds {
  if (current === undefined) return { ...next };
  const column = Math.min(current.column, next.column);
  const row = Math.min(current.row, next.row);
  return {
    column,
    columns: Math.max(current.column + current.columns, next.column + next.columns) - column,
    row,
    rows: Math.max(current.row + current.rows, next.row + next.rows) - row,
  };
}

export interface ISnowSurface {
  readonly mesh: Mesh;
  readonly outskirts: Mesh;
  /**
   * Take what the field wrote since the last call. Small windows — a footprint, a rolling ball —
   * are drawn on the next frame; a window wider than `URGENT_CELLS` (snowfall refilling every
   * track at once) is spread over the following frames a band of rows at a time.
   */
  collect(): void;
  /** Push collected windows into the mesh; call once per drawn frame. */
  refresh(): void;
  /** Rows still waiting to be redrawn from a wide refill. */
  readonly pendingRows: number;
  /**
   * Largest gap between a rendered vertex and the canonical surface, metres, after drawing every
   * window still waiting: what the next frame shows, not a frame caught mid-redraw.
   */
  renderError(): number;
  setCompactionView(on: boolean): void;
  /** 0 clear .. 1 blizzard: dims the glints with the sun. */
  setStorm(storm: number): void;
}

const floatUniform = () => uniform(0);
type FloatUniform = ReturnType<typeof floatUniform>;

function snowMaterial(compactionView: FloatUniform, sun: FloatUniform) {
  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.86 });
  const state = attribute(STATE, "vec2" as const);
  const indent = state.x;
  const compaction = state.y;
  // The hollow of a print darkens towards a cold blue; fresh powder keeps a faint grain.
  const hollow = smoothstep(0.002, 0.11, indent);
  const grain = hash(floor(positionWorld.xz.mul(1.8)));
  const powder = color(palette.snow).mul(grain.mul(0.035).add(0.965));
  const pressed = mix(powder, color(palette.shadow), hollow.mul(0.55).add(compaction.mul(0.1)));
  // Print walls face away from the light: darken by slope so a footprint reads at a glance.
  const wall = mix(float(0.8), float(1), smoothstep(0.55, 0.95, normalWorld.y));
  const lit = pressed.mul(float(1).sub(hollow.mul(0.22))).mul(wall);
  const debug = mix(vec3(0.22, 0.51, 0.67), vec3(0.95, 0.47, 0.16), compaction);
  material.colorNode = mix(lit, debug, compactionView);
  material.roughnessNode = mix(float(0.88), float(0.57), compaction);
  // Ice crystals: one in a hundred tiny cells glints when it faces the eye. Faded out where a
  // pixel covers several cells, so distant snow does not shimmer.
  const crystal = hash(floor(positionWorld.xz.mul(120)));
  const facing = pow(max(dot(normalView, positionViewDirection.negate()), 0), 12);
  const fade = float(1).sub(smoothstep(0.01, 0.055, fwidth(positionWorld.x)));
  material.emissiveNode = vec3(0.7, 0.85, 1).mul(
    smoothstep(0.99, 1, crystal).mul(facing).mul(fade).mul(sun).mul(0.55),
  );
  return material;
}

export function createSnowSurface(snow: ISnowSource): ISnowSurface {
  const field = snow.field;
  const compactionView = floatUniform();
  const sun = floatUniform();
  sun.value = 1;
  const material = snowMaterial(compactionView, sun);

  const geometry = field.toGeometry();
  const state = new BufferAttribute(new Float32Array(field.rows * field.columns * 2), 2);
  geometry.setAttribute(STATE, state);
  const mesh = new Mesh(geometry, material);
  mesh.position.set(field.origin.x, 0, field.origin.z);
  mesh.receiveShadow = true;
  mesh.name = "snow";

  // Beyond the playable field the ground keeps going under fresh, untouched snow. Inside the
  // field it ducks under the deformable surface, so the seam at the edge never shows.
  const outskirtsGeometry = new PlaneGeometry(340, 340, 110, 110);
  outskirtsGeometry.rotateX(-Math.PI / 2);
  const ring = outskirtsGeometry.getAttribute("position");
  const half = field.width / 2;
  for (let index = 0; index < ring.count; index += 1) {
    const x = ring.getX(index);
    const z = ring.getZ(index);
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const inside = 1 - Math.min(1, Math.max(0, (edge - (half - 1.5)) / 1.4));
    ring.setY(index, terrainHeight(x, z) + snow.depth - 0.72 * inside - 0.015);
  }
  outskirtsGeometry.computeVertexNormals();
  outskirtsGeometry.setAttribute(STATE, new BufferAttribute(new Float32Array(ring.count * 2), 2));
  const outskirts = new Mesh(outskirtsGeometry, material);
  outskirts.receiveShadow = true;

  let indents: Float32Array = new Float32Array(0);
  let compactions: Float32Array = new Float32Array(0);
  const writeState = (bounds: Bounds): void => {
    indents = snow.copyChannel("indent", bounds, indents);
    compactions = snow.copyChannel("compaction", bounds, compactions);
    const values = state.array as Float32Array;
    for (let row = 0; row < bounds.rows; row += 1) {
      for (let column = 0; column < bounds.columns; column += 1) {
        const cell = row * bounds.columns + column;
        const vertex = (bounds.row + row) * field.columns + bounds.column + column;
        values[vertex * 2] = indents[cell] as number;
        values[vertex * 2 + 1] = compactions[cell] as number;
      }
    }
    state.needsUpdate = true;
  };

  let urgent: Bounds[] = [];
  let background: Bounds | undefined;
  // `toGeometry` already drew the field as it stands; the field's own first full write is not news.
  snow.takeDirtyRegions();
  const redraw = (written: Bounds): void => {
    // A normal reads its neighbours, so one sample beyond the written window moves too.
    const column = Math.max(0, written.column - 1);
    const row = Math.max(0, written.row - 1);
    const bounds = {
      column,
      columns: Math.min(field.columns, written.column + written.columns + 1) - column,
      row,
      rows: Math.min(field.rows, written.row + written.rows + 1) - row,
    };
    field.refreshGeometry(geometry, bounds);
    writeState(bounds);
    // Upload only the samples that moved: a whole-field upload every frame is megabytes per
    // frame, and whole rows of a narrow window are most of that. One range per row keeps a
    // footprint's upload to a footprint, however far across the field the window sits.
    const wholeRows = bounds.columns === field.columns;
    for (const name of ["position", "normal", STATE]) {
      const attribute = geometry.getAttribute(name) as BufferAttribute;
      if (wholeRows) {
        attribute.addUpdateRange(
          bounds.row * field.columns * attribute.itemSize,
          bounds.rows * field.columns * attribute.itemSize,
        );
        continue;
      }
      for (let row = bounds.row; row < bounds.row + bounds.rows; row += 1)
        attribute.addUpdateRange(
          (row * field.columns + bounds.column) * attribute.itemSize,
          bounds.columns * attribute.itemSize,
        );
    }
  };
  const collect = (): void => {
    // Windows a long way apart stay apart: one box around a ball and a crate is most of the field.
    for (const written of snow.takeDirtyRegions()) {
      if (written.columns * written.rows <= URGENT_CELLS) urgent.push(written);
      else background = union(background, written);
    }
    // A frame that waits long for its draw falls back to one box rather than a list that grows.
    if (urgent.length > MAX_URGENT_WINDOWS) urgent = [urgent.reduce(union)];
  };

  return {
    collect,
    mesh,
    outskirts,
    get pendingRows() {
      return background?.rows ?? 0;
    },
    refresh() {
      collect();
      for (const window of urgent) redraw(window);
      urgent = [];
      if (background === undefined) return;
      // Proportional to what is waiting, so a refill always finishes before the next one lands.
      const rows = Math.min(
        background.rows,
        Math.max(SLICE_ROWS, Math.ceil(background.rows / SLICE_FRAMES)),
      );
      redraw({ ...background, rows });
      background =
        rows === background.rows
          ? undefined
          : { ...background, row: background.row + rows, rows: background.rows - rows };
    },
    renderError() {
      collect();
      for (const window of urgent) redraw(window);
      if (background !== undefined) redraw(background);
      urgent = [];
      background = undefined;
      const positions = geometry.getAttribute("position");
      const heights = field.toColliderHeights();
      let worst = 0;
      for (let row = 0; row < field.rows; row += 1)
        for (let column = 0; column < field.columns; column += 1)
          worst = Math.max(
            worst,
            Math.abs(
              positions.getY(row * field.columns + column) -
                (heights[column * field.rows + row] as number),
            ),
          );
      return worst;
    },
    setCompactionView(on) {
      compactionView.value = on ? 1 : 0;
    },
    setStorm(storm) {
      sun.value = 1 - storm * 0.85;
    },
  };
}
