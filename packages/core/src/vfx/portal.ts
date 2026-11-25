import { InstancedMesh, PlaneGeometry } from "three";
import {
  Fn,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  positionLocal,
  sin,
  smoothstep,
  time,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { type ComputeNode, MeshBasicNodeMaterial, type StorageBufferNode } from "three/webgpu";
import * as three from "three/webgpu";
import type { IComputeDriven } from "../compute-driven.js";
import {
  type IParticleOptions,
  type IVfxOverrides,
  createDonorParticle,
  layerAmount,
  overrideLayer,
} from "./particles.js";
import { type ArchiveLayer, godotPortalVortexLayers } from "./presets.js";

type ComputeRenderer = Parameters<IComputeDriven["process"]>[0];

function layerPhase(layer: ArchiveLayer, seed: number) {
  const lifetime = float(layer.lifetime[0]).add(
    hash(instanceIndex.add(seed + 53)).mul(layer.lifetime[1] - layer.lifetime[0]),
  );
  return fract(time.div(lifetime).add(hash(instanceIndex.add(seed + 59))));
}

/**
 * The GPU ribbon field that spirals into a portal vortex; `createPortalVortex` builds it.
 * @situation the spiral ribbons of a portal or a warp gate
 * @constraint build it with `createPortalVortex`, then add it with ctx.add; it is compute-driven
 * @example ctx.add(createPortalVortex().ribbons);
 */
export class RibbonField extends InstancedMesh implements IComputeDriven {
  readonly warmupNodes: readonly ComputeNode[];
  readonly capacity: number;
  #positions: StorageBufferNode<"vec3">;
  #start: ComputeNode;
  #process: ComputeNode;
  #renderer: ComputeRenderer | undefined;
  #released = false;
  #dispatches = 0;

  constructor(layer: ArchiveLayer, seed: number, capacity: number) {
    const positions = instancedArray(capacity, "vec3");
    const color = layer.color;
    const material = new MeshBasicNodeMaterial({
      blending: three.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    const phase = layerPhase(layer, seed);
    const radius = layer.shape.type === "sphereSurface" ? layer.shape.radius : 0.38;
    const swirl = hash(instanceIndex.add(seed + 3)).mul(Math.PI * 2);
    material.positionNode = positionLocal.add(positions.element(instanceIndex));
    material.colorNode = vec4(
      vec3(color[0], color[1], color[2]),
      smoothstep(1, 0, uv().sub(0.5).length().mul(2)).mul(
        mix(0.35, color[3], sin(phase.mul(Math.PI)).max(0)),
      ),
    );
    const start = Fn(() => {
      positions
        .element(instanceIndex)
        .assign(vec3(cos(swirl).mul(radius), sin(swirl).mul(radius), sin(swirl.mul(2)).mul(0.08)));
    })().compute(capacity);
    const process = Fn(() => {
      const currentPhase = layerPhase(layer, seed);
      const angle = swirl
        .add(time.mul(layer.vortex?.strength ?? 1))
        .add(currentPhase.mul(layer.vortex?.strength ?? 1));
      const currentRadius = float(radius).add(
        currentPhase.mul(layer.velocity.speed[1]).mul(layer.lifetime[1]),
      );
      positions
        .element(instanceIndex)
        .assign(
          vec3(
            cos(angle).mul(currentRadius),
            sin(angle).mul(currentRadius),
            sin(angle.mul(2)).mul(0.1),
          ),
        );
    })().compute(capacity);
    const width = Math.max(0.045, (layer.ribbonWidth ?? layer.size) * 2.2);
    const height = Math.max(0.42, layer.size * 8);
    super(new PlaneGeometry(width, height), material, capacity);
    this.capacity = capacity;
    this.#positions = positions;
    this.#start = start;
    this.#process = process;
    this.warmupNodes = [start, process];
    this.frustumCulled = false;
    this.addEventListener("removed", this.#onRemoved);
  }

  get released(): boolean {
    return this.#released;
  }

  get dispatches(): number {
    return this.#dispatches;
  }

  debug(): Record<string, unknown> {
    return { capacity: this.capacity, dispatches: this.#dispatches, released: this.#released };
  }

  attachRenderer(renderer: ComputeRenderer): void {
    if (this.#released) throw new Error("RibbonField cannot be attached after release.");
    this.#renderer = renderer;
    renderer.compute(this.#start);
  }

  process(renderer = this.#renderer): void {
    if (this.#released || !this.visible) return;
    if (renderer === undefined) throw new Error("RibbonField is not attached to a renderer.");
    renderer.compute(this.#process);
    this.#dispatches += 1;
  }

  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    this.#renderer = undefined;
    this.#start.dispose();
    this.#process.dispose();
    this.#positions.value.dispose();
    this.geometry.dispose();
    if (Array.isArray(this.material)) {
      for (const material of this.material) material.dispose();
    } else {
      this.material.dispose();
    }
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}

export interface IPortalVortex {
  readonly ring: IParticleOptions;
  readonly ribbons: RibbonField;
  readonly spawnCommands: number;
  readonly gpuCapacity: number;
}

export function createPortalVortex(overrides: IVfxOverrides = {}): IPortalVortex {
  const seed = overrides.seed ?? 229;
  const layers = godotPortalVortexLayers([0, 0, 0]);
  const ringLayer = layers[0];
  const ribbonLayer = layers[1];
  if (ringLayer === undefined || ribbonLayer === undefined) {
    throw new Error("Donor godot-portal-vortex must contain ring and ribbon layers.");
  }
  const ring = createDonorParticle(
    overrideLayer(ringLayer, overrides),
    seed,
    layerAmount(ringLayer, overrides.amount),
  );
  const ribbons = new RibbonField(
    overrideLayer(ribbonLayer, overrides),
    seed + 1,
    layerAmount(ribbonLayer, overrides.amount),
  );
  return {
    ring,
    ribbons,
    spawnCommands: 1,
    gpuCapacity: ring.amount + ribbons.capacity,
  };
}
