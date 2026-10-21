import { SurfaceCache } from "../../../../core/src/render/surface-cache.ts";
import { THREE, assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-639: the Surface Cache answers what a traced ray reads where it lands. It is plain TypeScript in core,
 * so the host runs it unmodified; this row proves the host agrees with the browser on the numbers. A grid of
 * flat tiles is painted with what the cache returns:
 *   row 0, row 1  the albedo of an sRGB map at v = 0.25 and v = 0.75, one tile per texel column
 *   row 2         a map under a half colour factor, a flat white, a half-metal grey and a pure metal
 *   row 3         the emissive map times the emissive intensity, divided by it to fit the display
 * Nothing here is lit: each tile is MeshBasicMaterial, so the picture is the cache's output.
 */
const SIZE = 8;
const TEXELS = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++)
    TEXELS.set([(x * 32 + 16) & 255, (y * 32 + 16) & 255, ((x ^ y) * 36 + 20) & 255, 255], (y * SIZE + x) * 4);

function map() {
  const texture = new THREE.DataTexture(TEXELS, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const decode = (byte) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function startScene(canvas, dimensions) {
  return startVisualScene(
    canvas,
    dimensions,
    "surface-cache-albedo",
    ({ scene }) => {
      const mapped = new THREE.MeshStandardMaterial({ color: 0xffffff, map: map() });
      const tinted = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), map: map() });
      const flat = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const half = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.6, 0.3, 0.2), metalness: 0.5 });
      const metal = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1 });
      const glow = new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xffffff,
        emissiveIntensity: 4,
        emissiveMap: map(),
      });
      const cache = SurfaceCache.from([mapped, tinted, flat, half, metal, glow]);
      const out = [0, 0, 0];
      const tile = (column, row, rgb) => {
        const mesh = new THREE.Mesh(
          new THREE.PlaneGeometry(0.9, 0.9),
          new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace) }),
        );
        mesh.position.set(column - (SIZE - 1) / 2, 1.5 - row, 0);
        scene.add(mesh);
      };
      for (let i = 0; i < SIZE; i++) {
        const u = (i + 0.5) / SIZE;
        cache.albedo(0, u, 0.25, out);
        tile(i, 0, out);
        if (i === 3) {
          // glTF layout: v = 0 is the top row, so v = 0.25 reads texel row 1.
          assertCondition(Math.abs(out[0] - decode(TEXELS[(1 * SIZE + 3) * 4])) < 1e-3, "mapped albedo must be the decoded texel");
        }
        cache.albedo(0, u, 0.75, out);
        tile(i, 1, out);
        cache.emissive(5, u, 0.25, out);
        tile(i, 3, out.map((v) => v / 4));
      }
      cache.albedo(1, 3.5 / SIZE, 0.25, out);
      const tinted3 = [...out];
      cache.albedo(0, 3.5 / SIZE, 0.25, out);
      assertCondition(Math.abs(tinted3[1] - out[1] * 0.5) < 1e-3, "the colour factor must scale the map");
      tile(0, 2, tinted3);
      for (const [column, slot] of [[1, 2], [2, 3], [3, 4]]) {
        cache.albedo(slot, 0.5, 0.5, out);
        tile(column, 2, out);
      }
      cache.albedo(4, 0.5, 0.5, out);
      assertCondition(out[0] === 0 && out[1] === 0 && out[2] === 0, "a pure metal has no diffuse albedo");
      assertCondition(cache.report.mappedMaterials === 3 && cache.report.flatMaterials === 3, "three mapped, three flat");
      return { detail: { mapped: cache.report.mappedMaterials, tileEdge: cache.report.tileEdge } };
    },
    {
      background: 0x101018,
      camera: () => {
        const camera = new THREE.OrthographicCamera(-4.5, 4.5, 2.53, -2.53, 0.1, 10);
        camera.position.set(0, 0, 5);
        return camera;
      },
    },
  );
}
