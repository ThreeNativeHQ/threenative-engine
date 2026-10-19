import { saturate } from "three/tsl";
import { loadTerrainSplat } from "../../../../core/src/world-terrain-splat.ts";
import { assertCondition, startVisualScene, THREE } from "./scene-support.js";

/**
 * A sixteen-layer splat package whose 48 maps are uncompressed and the same size — the shape
 * Android and iOS get, having no KTX2 transcoder. `loadTerrainSplat` stacks each set into one
 * array texture by GPU copy, so the surface binds four sampled textures instead of forty-nine;
 * this row is what says the native host agrees with the browser. Two layers also ship a height
 * set, which stacks into a fifth array and reaches the game's weight seam, so the row proves the
 * height-blend path too.
 */

const LAYERS = 16;
const PLANE = 4; // mask texels a side; each layer owns one, and cell 0 is left to the base
const PLANES = 4;
const MAP = 8; // map texels a side
const HALF = 4; // the ground spans HALF metres either side of the origin
const HEIGHT_LAYERS = [0, 1]; // slots whose table entry names a height map

/** The game's curve, as `examples/prd493-terrain-splat/src/render/heightBlend.ts` writes it. */
const heightBlend = (weight, { height }) =>
  height === undefined ? weight : saturate(weight.mul(2).sub(1).add(height));

/** Every fixture byte is a pure function of its cell: both lanes must derive the same one. */
function mapRgb(layer, kind, x, y) {
  if (kind === "h") {
    const crest = (Math.floor(x / 2) + Math.floor(y / 2) + layer) % 2 === 0;
    return crest ? [230, 230, 230] : [25, 25, 25];
  }
  if (kind === "nrm") return [128 + (layer % 5) * 24, 128 + (((layer >> 1) % 5) * 20) % 127, 255];
  if (kind === "orm") return [255, 40 + ((layer * 17) % 200), (layer % 3) * 40];
  const step = 2 + (layer % 4);
  const on = (Math.floor(x / step) + Math.floor(y / step) + layer) % 2 === 0;
  return on ? [230, 90 + (layer % 6) * 25, 60] : [50, 40 + (layer % 3) * 20, 90 + (layer % 5) * 20];
}

/** One map as the uncompressed RGBA8 texture an uncompressed layer ships. */
function layerTexture(layer, kind, srgb) {
  const data = new Uint8Array(MAP * MAP * 4);
  for (let y = 0; y < MAP; y += 1)
    for (let x = 0; x < MAP; x += 1) {
      const rgb = mapRgb(layer, kind, x, y);
      const at = (y * MAP + x) * 4;
      data[at] = rgb[0];
      data[at + 1] = rgb[1];
      data[at + 2] = rgb[2];
      data[at + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, MAP, MAP, THREE.RGBAFormat);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/** The mask planes: layer `slot` is lit in cell `slot + 1` of a 4x4 grid, and nowhere else. */
function splatBytes() {
  const bytes = new Uint8Array(PLANES * PLANE * PLANE * 4);
  for (let slot = 0; slot < LAYERS - 1; slot += 1) {
    const cell = slot + 1;
    bytes[(Math.floor(cell / PLANE) * PLANE + (cell % PLANE)) * 4 + (slot % 4)] = 255;
  }
  return bytes;
}

function layersTable() {
  const masks = {};
  const layers = [];
  for (let slot = 0; slot < LAYERS - 1; slot += 1) {
    masks[`m${slot}`] = [Math.floor(slot / 4), "rgb"];
    layers.push({
      channel: ["r", "g", "b", "a"][slot % 4],
      hi: 0.75,
      height: HEIGHT_LAYERS.includes(slot) ? true : undefined,
      id: `layer${slot}`,
      lo: 0.25,
      mask: `m${slot}`,
      normal: true,
      orm: true,
      tile: 2,
      tint: [0.4 + (slot % 5) * 0.14, 0.95 - (slot % 3) * 0.22, 0.35 + ((slot >> 1) % 5) * 0.13],
    });
  }
  return {
    base: { id: "base", normal: true, orm: true, tile: 2, tint: [0.85, 0.85, 0.88] },
    breakup: { push: 0.06, scale: 0.35 },
    layers,
    macro: { max: 1.1, min: 0.85, scale: 0.12 },
    splat: { masks, planes: PLANES, size: PLANE },
    textures: "layers",
  };
}

/** world.json, the table and the mask bytes, served the way a game's own package is. */
function packageAssets() {
  const files = new Map([
    [
      "world.json",
      JSON.stringify({
        extent: { minX: -HALF, minZ: -HALF, sizeX: HALF * 2, sizeZ: HALF * 2 },
        terrain: { layers: { splat: "layers/splat.rgba8", table: "layers/table.json" } },
        version: 1,
      }),
    ],
    ["layers/table.json", JSON.stringify(layersTable())],
    ["layers/splat.rgba8", splatBytes()],
  ]);
  return {
    resolve: async (path) => {
      const bytes = files.get(path);
      assertCondition(bytes !== undefined, `terrain-splat-array: no fixture at '${path}'`);
      return [URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }))];
    },
    texture: async (path, options = {}) => {
      const match = /^layers\/(?:base|layer(\d+))_(diff|nrm|orm|h)\.jpg$/u.exec(path);
      assertCondition(match !== null, `terrain-splat-array: unexpected map '${path}'`);
      const texture = layerTexture(
        match[1] === undefined ? 0 : Number(match[1]),
        match[2],
        options.data !== true,
      );
      texture.name = path;
      return texture;
    },
  };
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "terrain-splat-array",
    async ({ renderer, scene }) => {
      const material = await loadTerrainSplat({
        assets: packageAssets(),
        layerWeight: heightBlend,
        renderer: { raw: renderer },
        url: "world.json",
      });
      const marker = String(material.userData.TN_TERRAIN_SPLAT);
      const number = (key) => Number(new RegExp(`${key}=(\\d+)`, "u").exec(marker)?.[1] ?? -1);
      assertCondition(number("layers") === LAYERS, `sixteen layers expected, got ${marker}`);
      assertCondition(number("stacked") === 4, `four stacked sets expected, got ${marker}`);
      assertCondition(number("samplers") === 5, `five sampled textures expected, got ${marker}`);

      const ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), material);
      ground.rotation.x = -Math.PI / 2;
      const sun = new THREE.DirectionalLight(0xffffff, 2.6);
      sun.position.set(2, 6, 3);
      scene.add(ground, sun, new THREE.AmbientLight(0xa8c0ff, 0.6));
      return { detail: { layers: LAYERS, samplers: 5, stacked: 4 }, ground, material };
    },
    {
      background: 0x0d1520,
      camera: (size) => {
        const camera = new THREE.PerspectiveCamera(50, size.width / size.height, 0.1, 100);
        camera.position.set(0, 5.5, 6.5);
        camera.lookAt(0, 0, -0.5);
        return camera;
      },
    },
  );
}