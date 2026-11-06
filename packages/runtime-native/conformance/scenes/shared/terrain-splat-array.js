import { positionWorld, saturate, texture, vec3 } from "three/tsl";
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
  if (kind === "nrm") return [128 + (layer % 5) * 24, 128 + ((((layer >> 1) % 5) * 20) % 127), 255];
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
      maps: slot === 0 ? { height: "shared/layer0-height.png" } : undefined,
      normal: true,
      orm: true,
      tile: 2,
      tint: [0.4 + (slot % 5) * 0.14, 0.95 - (slot % 3) * 0.22, 0.35 + ((slot >> 1) % 5) * 0.13],
    });
  }
  return {
    base: {
      id: "base",
      maps: {
        diffuse: "shared/base-color.png",
        normal: "shared/base-nor_gl.png",
        orm: "shared/base-arm.png",
      },
      normal: true,
      orm: true,
      tile: 2,
      tint: [0.85, 0.85, 0.88],
    },
    breakup: { push: 0.06, scale: 0.35 },
    layers,
    macro: { max: 1.1, min: 0.85, scale: 0.12 },
    splat: { masks, planes: PLANES, size: PLANE },
    textures: "layers",
  };
}

/** Game source intentionally changes the baked appearance while leaving its descriptors absent. */
function gameTable(baked) {
  return {
    base: baked.base,
    breakup: { ...baked.breakup, push: 0 },
    macro: { ...baked.macro, min: 1, max: 1 },
    layers: baked.layers,
  };
}

/** world.json, the table and the mask bytes, served the way a game's own package is. */
function packageAssets(table = layersTable()) {
  const files = new Map([
    [
      "world.json",
      JSON.stringify({
        extent: { minX: -HALF, minZ: -HALF, sizeX: HALF * 2, sizeZ: HALF * 2 },
        terrain: { layers: { splat: "layers/splat.rgba8", table: "layers/table.json" } },
        version: 1,
      }),
    ],
    ["layers/table.json", JSON.stringify(table)],
    ["layers/splat.rgba8", splatBytes()],
  ]);
  return {
    resolve: async (path) => {
      const bytes = files.get(path);
      assertCondition(bytes !== undefined, `terrain-splat-array: no fixture at '${path}'`);
      return [URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }))];
    },
    texture: async (path, options = {}) => {
      // Explicit package paths resolve to the same fixtures as the convention-named maps.
      const aliases = {
        "shared/base-color.png": "layers/base_diff.jpg",
        "shared/base-nor_gl.png": "layers/base_nrm.jpg",
        "shared/base-arm.png": "layers/base_orm.jpg",
        "shared/layer0-height.png": "layers/layer0_h.jpg",
      };
      const match = /^layers\/(?:base|layer(\d+))_(diff|nrm|orm|h)\.jpg$/u.exec(
        aliases[path] ?? path,
      );
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

export function assertCallbackPixels(pixels) {
  assertCondition(
    pixels instanceof Uint8Array && pixels.length === 64,
    "callback readback must be 4x4 RGBA8",
  );
  const counts = [0, 0, 0];
  // Linear RGBA8: sRGB albedo at texel (4,4), scaled by callback index; normal/ORM stay data.
  const expected = [
    [67, 128, 40],
    [135, 128, 40],
    [8, 152, 57],
  ];
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const index = expected.findIndex((rgb) =>
      rgb.every((value, channel) => Math.abs(pixels[offset + channel] - value) <= 1),
    );
    assertCondition(
      index !== -1 && pixels[offset + 3] === 255,
      `unexpected callback pixel ${pixels.slice(offset, offset + 4)}`,
    );
    counts[index] += 1;
  }
  // Existing plane-0 r/g bytes repeat every four cells; each retained mask paints four texels.
  assertCondition(counts.join() === "8,4,4", `callback blend populations: ${counts}`);
}

async function verifyCallbacks(renderer) {
  const baked = layersTable();
  baked.layers = baked.layers.slice(0, 2);
  const material = await loadTerrainSplat({
    assets: packageAssets(baked),
    renderer: { raw: renderer },
    table: gameTable(baked),
    url: "world.json",
    layerSample: ({ diffuse, normal, orm, index }) => {
      const uv = positionWorld.xz.div(2).add(0.0625);
      return {
        color: texture(diffuse, uv).rgb.mul((index + 1) / 3),
        normal: texture(normal, uv).rgb,
        orm: texture(orm, uv).rgb,
      };
    },
    materialFactory: ({ color, normal, orm }) => {
      const result = new THREE.MeshBasicNodeMaterial();
      result.colorNode = vec3(color.r, normal.r, orm.g);
      result.toneMapped = false;
      return result;
    },
  });
  const target = new THREE.RenderTarget(4, 4);
  const previous = renderer.getRenderTarget();
  const geometry = new THREE.PlaneGeometry(HALF * 2, HALF * 2);
  try {
    assertCondition(
      material.userData.TN_TERRAIN_SPLAT ===
        "layers=3 loadedSamplerUpperBound=12 stacked=0 sampling=custom",
      "custom callback sampler bound changed",
    );
    const probe = new THREE.Scene();
    const ground = new THREE.Mesh(geometry, material);
    ground.rotation.x = -Math.PI / 2;
    probe.add(ground);
    const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, 0.1, 20);
    camera.position.set(0, 8, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    renderer.setRenderTarget(target);
    renderer.render(probe, camera);
    const pixels = new Uint8Array(64);
    // Three returns 256-byte-padded rows; single-row reads contain only the requested texels.
    for (let row = 0; row < 4; row += 1) {
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, row, 4, 1);
      assertCondition(
        data instanceof Uint8Array && data.length === 16,
        "callback row must be RGBA8",
      );
      pixels.set(data, row * 16);
    }
    assertCallbackPixels(pixels);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    geometry.dispose();
    material.dispose();
  }
}

export async function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "terrain-splat-array",
    async ({ renderer, scene }) => {
      await verifyCallbacks(renderer);
      const baked = layersTable();
      const material = await loadTerrainSplat({
        assets: packageAssets(baked),
        layerWeight: heightBlend,
        renderer: { raw: renderer },
        table: gameTable(baked),
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
