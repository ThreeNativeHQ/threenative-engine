import { AlwaysDepth, Mesh, OrthographicCamera, PlaneGeometry, Scene, type Vector3 } from "three";
import { positionGeometry, vec4 } from "three/tsl";
import {
  MeshBasicNodeMaterial,
  type NodeFrame,
  type RenderTarget,
  type Renderer,
} from "three/webgpu";
import type { IPageRect } from "./virtual-shadow-pages.js";

/** A rectangle of a shadow map in texels, measured from its top-left corner. */
export interface IPixelRect {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/**
 * One rectangle of a level's map redrawn on its own: the pages it covers, whether the depth it
 * holds must be put back to the far plane first, and the texels the camera aimed at.
 */
export interface IPartialPass {
  /** Set by the level when it aims its camera at {@link rect}; a pass without it renders whole. */
  pixels: IPixelRect | undefined;
  readonly rect: IPageRect;
  /** The pass follows an eviction, so the old depth in {@link rect} is cleared before drawing. */
  readonly reset: boolean;
}

/** The stock shadow node, which this module replaces one method of. */
export interface IPartialShadowNode {
  readonly shadow: {
    readonly camera: OrthographicCamera & { reversedDepth?: boolean };
    readonly mapSize: { readonly height: number; readonly width: number };
  };
  readonly shadowMap: RenderTarget;
  renderShadow(frame: NodeFrame): void;
}

/**
 * The texels of a `size` x `size` map that a set of world points land on through `camera`, rounded
 * out to whole texels. The camera is read as it stands, so whichever way the level's axes fall the
 * rectangle is the one the stock render would have drawn those pages into.
 */
export function pixelRect(
  camera: OrthographicCamera,
  size: number,
  corners: readonly Vector3[],
): IPixelRect {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const ndc = corner
      .clone()
      .applyMatrix4(camera.matrixWorldInverse)
      .applyMatrix4(camera.projectionMatrix);
    const px = ((ndc.x + 1) / 2) * size;
    const py = ((1 - ndc.y) / 2) * size;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  // A corner computed to a hair either side of a texel edge must not drop or add a texel row.
  const x = Math.max(0, Math.round(minX));
  const y = Math.max(0, Math.round(minY));
  return {
    height: Math.min(size, Math.round(maxY)) - y,
    width: Math.min(size, Math.round(maxX)) - x,
    x,
    y,
  };
}

const quadScene = new Scene();
const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quads = new Map<number, Mesh>();

/** A quad whose every fragment writes `far` to depth and the stock clear's transparent black to colour. */
function farQuad(far: number): Mesh {
  let quad = quads.get(far);
  if (quad === undefined) {
    const material = new MeshBasicNodeMaterial({
      colorWrite: true,
      depthTest: true,
      depthWrite: true,
    });
    material.fragmentNode = vec4(0);
    material.depthFunc = AlwaysDepth;
    material.vertexNode = vec4(positionGeometry.x, positionGeometry.y, far, 1);
    quad = new Mesh(new PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    quads.set(far, quad);
  }
  return quad;
}

/**
 * Reset depth to the far plane and transmitted-shadow colour to transparent black in the viewport. A WebGPU clear wipes the whole
 * attachment whatever the viewport, so the rectangle is cleared by drawing over it.
 */
function resetDepth(renderer: Renderer, reversed: boolean): void {
  const quad = farQuad(reversed ? 0 : 1);
  quadScene.add(quad);
  // The shadow pass owns the render-object function and would draw the quad with the depth material.
  const held = renderer.getRenderObjectFunction();
  renderer.setRenderObjectFunction(null);
  try {
    renderer.render(quadScene, quadCamera);
  } finally {
    renderer.setRenderObjectFunction(held);
    quadScene.remove(quad);
  }
}

/**
 * Make a stock shadow node draw only the rectangle its level aimed at, when the level has one.
 *
 * The level has already aimed the shadow camera with a view offset and baked the receivers' matrix
 * from the full projection, so this does not call `updateMatrices` again. The viewport is the same
 * rectangle, so a texel here is the texel the whole-map render would have written, and the depth
 * load is kept: the shadow pass forces an auto clear, which this turns off for the draw.
 */
export function installPartialRender(
  node: IPartialShadowNode,
  current: () => IPartialPass | undefined,
): void {
  const stock = node.renderShadow.bind(node);
  node.renderShadow = (frame) => {
    const pass = current();
    const pixels = pass?.pixels;
    if (pass === undefined || pixels === undefined) {
      stock(frame);
      return;
    }
    const { renderer, scene, camera, object, material } = frame;
    if (renderer === null || scene === null) {
      stock(frame);
      return;
    }
    const { shadow, shadowMap } = node;
    const { height, width } = shadow.mapSize;
    const scissor = shadowMap.scissor.clone();
    const scissorTest = renderer.getScissorTest();
    // `setSize` puts the viewport back to the whole map, so the rectangle is set after it.
    shadowMap.setSize(width, height, shadowMap.depth);
    shadowMap.viewport.set(pixels.x, pixels.y, pixels.width, pixels.height);
    const autoClear = renderer.autoClear;
    const name = scene.name;
    try {
      renderer.autoClear = false;
      shadowMap.scissor.copy(shadowMap.viewport);
      // Three reads the target rectangle but the renderer's scissor-test flag.
      renderer.setScissorTest(true);
      if (pass.reset) resetDepth(renderer, shadow.camera.reversedDepth === true);
      scene.name = "Shadow Map [ partial ]";
      renderer.render(scene, shadow.camera);
    } finally {
      // Nested renders overwrite Three's shared NodeFrame; the next rectangle needs its caller.
      frame.scene = scene;
      frame.camera = camera;
      frame.object = object;
      frame.material = material;
      renderer.autoClear = autoClear;
      scene.name = name;
      shadowMap.viewport.set(0, 0, width, height);
      shadowMap.scissor.copy(scissor);
      renderer.setScissorTest(scissorTest);
    }
  };
}
