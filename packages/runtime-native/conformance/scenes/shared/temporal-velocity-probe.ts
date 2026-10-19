import {
  DataUtils,
  HalfFloatType,
  Matrix4,
  type PerspectiveCamera,
  type Scene,
  type Vector3,
} from "three";
import { velocity } from "three/tsl";
import type { PassNode, WebGPURenderer } from "three/webgpu";

export function projectedMotion(
  current: Vector3,
  previous: Vector3,
  view: Matrix4,
  previousView: Matrix4,
  projection: Matrix4,
  previousProjection: Matrix4,
): Vector3 {
  return current
    .clone()
    .applyMatrix4(view)
    .applyMatrix4(projection)
    .sub(previous.clone().applyMatrix4(previousView).applyMatrix4(previousProjection));
}

/** The two pixel coordinates a history read compares: where the installed resolve reaches for, and
 * where the point independently projected. TRAANode samples `historyUV = uv - velocity *
 * vec2( 0.5, - 0.5 )`, and that `uv` counts raster rows from the top, so the measured NDC delta
 * moves the sample half its width left in x and half its height *down* in y: the history sample sits
 * where the point was, one frame back. */
export function reprojectedHistory(
  pixel: [number, number],
  velocityNdc: readonly [number, number],
  previousNdc: Vector3,
  width: number,
  height: number,
): { history: [number, number]; previous: [number, number] } {
  return {
    history: [pixel[0] - (velocityNdc[0] * width) / 2, pixel[1] + (velocityNdc[1] * height) / 2],
    previous: [(previousNdc.x * 0.5 + 0.5) * width, (-previousNdc.y * 0.5 + 0.5) * height],
  };
}

/** Fixture-only readback: never used for a performance claim or as the engine's motion source. */
export function createTemporalVelocityProbe(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
  scenePass: PassNode,
  points: () => Record<string, Vector3>,
) {
  const projection = new Matrix4();
  const drawProjection = new Matrix4();
  const previousView = new Matrix4();
  const previousProjection = new Matrix4();
  let previousPoints: Record<string, Vector3> | undefined;
  let projectionError: number | null = null;
  let last: unknown = null;
  const beforeRender = scene.onBeforeRender;
  scene.onBeforeRender = (...args) => {
    drawProjection.copy(camera.projectionMatrix);
    projectionError =
      velocity.projectionMatrix === null
        ? null
        : Math.max(
            ...projection.elements.map((value, index) =>
              Math.abs(value - (velocity.projectionMatrix?.elements[index] ?? Number.NaN)),
            ),
          );
    beforeRender.apply(scene, args);
  };
  return {
    before: () => {
      projection.copy(camera.projectionMatrix);
    },
    observation: () => last,
    read: async () => {
      const current = points();
      const target = scenePass.renderTarget;
      const velocityIndex = target.textures.findIndex((texture) => texture.name === "velocity");
      if (velocityIndex < 0)
        throw new Error("Velocity diagnostic requires an actual MRT attachment");
      const samples = [];
      if (previousPoints)
        for (const [name, world] of Object.entries(current)) {
          const previous = previousPoints[name];
          if (!previous) throw new Error(`Missing previous diagnostic point: ${name}`);
          const ndc = world
            .clone()
            .applyMatrix4(camera.matrixWorldInverse)
            .applyMatrix4(drawProjection);
          // The same point through the unjittered projection the resolve samples with, so the anchor
          // below carries no jitter and can be compared with a previous frame on the same footing.
          const currentNdc = world
            .clone()
            .applyMatrix4(camera.matrixWorldInverse)
            .applyMatrix4(projection);
          const x = Math.floor((ndc.x * 0.5 + 0.5) * target.width);
          const y = Math.floor((-ndc.y * 0.5 + 0.5) * target.height);
          if (x < 0 || x >= target.width || y < 0 || y >= target.height)
            throw new Error(`Diagnostic point outside raster: ${name}`);
          const data = await renderer.readRenderTargetPixelsAsync(
            target,
            x,
            y,
            1,
            1,
            velocityIndex,
          );
          const decode = (value: number) =>
            target.textures[velocityIndex]?.type === HalfFloatType
              ? DataUtils.fromHalfFloat(value)
              : value;
          const rawX = data[0];
          const rawY = data[1];
          if (rawX === undefined || rawY === undefined)
            throw new Error("Incomplete velocity readback");
          const actual: [number, number] = [decode(rawX), decode(rawY)];
          const expected = projectedMotion(
            world,
            previous,
            camera.matrixWorldInverse,
            previousView,
            projection,
            previousProjection,
          );
          if (![...actual, expected.x, expected.y].every(Number.isFinite))
            throw new Error("Nonfinite motion diagnostic");
          // The continuous, unjittered anchor every pixel length below is measured from. The integer
          // pair above is the floor of the *jittered* draw projection and names the MRT texel this
          // read took; the sub-pixel jitter between the two would otherwise be compared as motion.
          const currentPixel: [number, number] = [
            (currentNdc.x * 0.5 + 0.5) * target.width,
            (-currentNdc.y * 0.5 + 0.5) * target.height,
          ];
          // Where the measured vector reprojects this point, beside where it independently projected
          // last frame. A wrong vector has to be able to miss the second.
          const { history: historyPixel, previous: previousPixel } = reprojectedHistory(
            currentPixel,
            actual,
            previous.clone().applyMatrix4(previousView).applyMatrix4(previousProjection),
            target.width,
            target.height,
          );
          samples.push({
            name,
            pixel: [x, y],
            actualNdc: actual,
            expectedNdc: [expected.x, expected.y],
            historyPixel,
            previousPixel,
            measuredPixels: Math.hypot(
              historyPixel[0] - currentPixel[0],
              historyPixel[1] - currentPixel[1],
            ),
            expectedPixels: Math.hypot(
              previousPixel[0] - currentPixel[0],
              previousPixel[1] - currentPixel[1],
            ),
            misregistrationPixels: Math.hypot(
              historyPixel[0] - previousPixel[0],
              historyPixel[1] - previousPixel[1],
            ),
            errorPixels: Math.hypot(
              ((actual[0] - expected.x) * target.width) / 2,
              ((actual[1] - expected.y) * target.height) / 2,
            ),
          });
        }
      last = { projectionError, samples };
      previousPoints = current;
      previousView.copy(camera.matrixWorldInverse);
      previousProjection.copy(projection);
    },
    dispose: () => {
      scene.onBeforeRender = beforeRender;
    },
  };
}
