import * as THREE from "three/webgpu";
import { film } from "three/addons/tsl/display/FilmNode.js";
import { lut3D } from "three/addons/tsl/display/Lut3DNode.js";
import { LUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";
import { float, pass, renderOutput, texture3D } from "three/tsl";
import { assertCondition, startVisualScene } from "./scene-support.js";

/**
 * PRD-492 Phase 2: a `.cube` table, uploaded as a `Data3DTexture` and sampled by `lut3D`, on the
 * host. The web lane already proved the stage exists; this row proves the host can carry it — the
 * 3D texture upload, the trilinear filter and the grain node all have to work where a game ships.
 */

/** The edge length PRD-492 names. Fine enough that the grid is not what the eye sees. */
const SIZE = 17;

/**
 * The grade, per channel. Deliberately not the identity: an identity table would pass whether the
 * host sampled the texture correctly, ignored it, or substituted a constant.
 */
const GAIN = { r: 0.75, g: 1, b: 0.5 };

/** The chart the frame is graded from: black, white, the three primaries, a grey and a mid blue. */
const CHART = [0x000000, 0xffffff, 0xff0000, 0x00ff00, 0x0000ff, 0x808080, 0x3a7bd5];

/**
 * A `.cube` file as text, red varying fastest — the order `LUTCubeLoader.parse` reads and the axis
 * `lut3D` samples. Written here rather than shipped as a file because the conformance host has no
 * fetch for one, and because a table this row can state in four lines is a table it can also state
 * the expected answer to.
 */
function cubeText() {
  const lines = ['TITLE "conformance lut-grade"', `LUT_3D_SIZE ${SIZE}`, ""];
  for (let texel = 0; texel < SIZE ** 3; texel += 1) {
    const at = (axis) => Math.floor(texel / SIZE ** axis) % SIZE;
    lines.push(
      [at(0) / (SIZE - 1) * GAIN.r, at(1) / (SIZE - 1) * GAIN.g, at(2) / (SIZE - 1) * GAIN.b]
        .map((value) => Math.min(1, value).toFixed(6))
        .join(" "),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What the loader must have produced, read back off the uploaded texture rather than off the text
 * that produced it: the size `lut3D` is told, the 8-bit type every adapter can filter, and the
 * three coordinates that would expose a transposed or unscaled upload. The load is
 * `Number(text) * 255` into a `Uint8Array`, so it truncates and one step of slack is the whole
 * tolerance.
 */
function assertTable(texture, size) {
  assertCondition(size === SIZE, `lut-grade table is ${size}^3, expected ${SIZE}^3`);
  assertCondition(
    texture.type === THREE.UnsignedByteType,
    "lut-grade table must be 8-bit; a float table would need the optional float32-filterable feature",
  );
  const byteAt = (red, green, blue, channel) =>
    texture.image.data[((blue * SIZE + green) * SIZE + red) * 4 + channel];
  for (const [red, green, blue] of [
    [0, 0, 0],
    [SIZE - 1, SIZE - 1, SIZE - 1],
    [SIZE - 1, 0, 0],
    [0, 0, SIZE - 1],
  ]) {
    const expected = [
      (red / (SIZE - 1)) * GAIN.r,
      (green / (SIZE - 1)) * GAIN.g,
      (blue / (SIZE - 1)) * GAIN.b,
    ];
    for (let channel = 0; channel < 3; channel += 1) {
      const want = Math.floor(Math.min(1, expected[channel]) * 255);
      const got = byteAt(red, green, blue, channel);
      assertCondition(
        Math.abs(got - want) <= 1,
        `lut-grade table (${red},${green},${blue}) channel ${channel} holds ${got}, expected ${want}`,
      );
    }
  }
}

export function startScene(canvas, dimensions) {
  return startVisualScene(canvas, dimensions, "lut-grade", ({ renderer, scene, camera }) => {
    const loader = new LUTCubeLoader();
    const table = loader.parse(cubeText());
    assertTable(table.texture3D, table.size);

    // The chart itself: unlit quads, so the frame is the table's colours and nothing else.
    const swatches = CHART.map((color, index) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.52, 0.9),
        new THREE.MeshBasicMaterial({ color }),
      );
      mesh.position.set((index - (CHART.length - 1) / 2) * 0.6, 0, 0);
      scene.add(mesh);
      return mesh;
    });

    const scenePass = pass(scene, camera);
    // Exactly the starter's arrangement: the table is authored against the picture, so the stage
    // applies the output transform itself and the pipeline stops applying a second one.
    const graded = lut3D(renderOutput(scenePass), texture3D(table.texture3D), table.size, 1);
    // Grain at zero intensity: the node has to build and sample on the host, and it must leave
    // every swatch exactly where the table put it.
    const pipeline = new THREE.RenderPipeline(renderer);
    pipeline.outputNode = film(graded, float(0));
    pipeline.outputColorTransform = false;
    const render = () => {
      pipeline.render();
    };
    render();
    return {
      detail: { blueGain: GAIN.b, redGain: GAIN.r, size: table.size, swatches: swatches.length },
      render,
      swatches,
    };
  });
}