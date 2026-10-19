import { GPUReadback } from "@threenative/core";
import type { IComputeDriven } from "@threenative/core";
import type { IAnimalBake } from "@threenative/procedural-animals";
import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  FloatType,
  Mesh,
  RGBAFormat,
  Vector3,
} from "three";
import { Fn, instanceIndex, instancedArray, vec3, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { releaseAll } from "../cleanup.js";
import { animalSkin } from "./dqs.js";
import { deformReference } from "./reference.js";

/** Qualification only: immutable pose snapshots, the rendered DQS node, and asynchronous output. */
type ProbeRenderer = Parameters<IComputeDriven["process"]>[0];
export class AnimalGPUProbe
  extends Mesh<BufferGeometry, MeshBasicNodeMaterial>
  implements IComputeDriven
{
  readonly processCadence = "render";
  readonly warmupNodes = [];
  readonly #compute;
  #renderer: ProbeRenderer | undefined;
  #owned = false;
  readonly #bake: IAnimalBake;
  readonly #packet: Float32Array;
  readonly #texture: DataTexture;
  readonly #readback: GPUReadback;
  readonly #completed = new Set<string>();
  #label: string | undefined;
  #launched = false;
  #lands = 0;
  #released = false;
  #positionError = 0;
  #normalError = 0;
  constructor(bake: IAnimalBake) {
    super(new BufferGeometry(), new MeshBasicNodeMaterial());
    // Hidden during startup compilation; packets are queued only after startup readiness.
    // engine-override: qualification probe, not a transient effect; it stays hidden until startup readiness
    this.visible = false;
    this.frustumCulled = false;
    this.geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(9), 3));
    this.material.colorWrite = this.material.depthWrite = this.material.depthTest = false;
    this.onAfterRender = () => {
      if (this.#renderer?.compiling === false && !this.#released) this.#owned = true;
    };
    this.#bake = bake;
    this.name = "animal-gpu-qualification";
    this.#packet = new Float32Array(bake.bones.length * 20);
    this.#texture = new DataTexture(this.#packet, bake.bones.length * 5, 1, RGBAFormat, FloatType);
    this.#texture.needsUpdate = true;
    const buffers = {
      position: instancedArray(bake.pos.slice(), "vec3"),
      normal: instancedArray(bake.nrm.slice(), "vec3"),
      indices: instancedArray(Float32Array.from(bake.skinIndex), "vec4"),
      weights: instancedArray(bake.skinWeight.slice(), "vec4"),
      output: instancedArray(bake.nV * 2, "vec4"),
    };
    // Referenced vertex attributes give these compute buffers normal Three geometry ownership.
    this.material.positionNode = vec3(buffers.position.toAttribute())
      .add(buffers.normal.toAttribute())
      .add(buffers.indices.toAttribute().xyz)
      .add(buffers.weights.toAttribute().xyz)
      .add(buffers.output.toAttribute().xyz)
      .mul(1e-30);
    const compute = Fn(() => {
      const position = buffers.position.element(instanceIndex);
      const normal = buffers.normal.element(instanceIndex);
      const indices = buffers.indices.element(instanceIndex);
      const weights = buffers.weights.element(instanceIndex);
      buffers.output
        .element(instanceIndex.mul(2))
        .assign(vec4(animalSkin(this.#texture, position, normal, indices, weights, false), 1));
      buffers.output
        .element(instanceIndex.mul(2).add(1))
        .assign(vec4(animalSkin(this.#texture, position, normal, indices, weights, true), 0));
    })().compute(bake.nV);
    compute.name = "animal.dqs-position-normal-proof";
    this.#compute = compute;
    this.#readback = new GPUReadback({ attribute: buffers.output.value, everyFrames: 1 });
  }
  get released() {
    return this.#released;
  }
  get report() {
    return {
      cases: this.#completed.size,
      labels: [...this.#completed],
      positionError: this.#positionError,
      normalError: this.#normalError,
      readbackFailures: this.#readback.stats.failures,
    };
  }
  attachRenderer(renderer: ProbeRenderer): void {
    this.#renderer = renderer;
  }
  queue(label: string, packet: Float32Array): void {
    if (this.#released || this.#label !== undefined || this.#completed.has(label)) return;
    if (packet.length !== this.#packet.length || !packet.every(Number.isFinite))
      throw new Error("TN_ANIMAL_GPU_PROBE_PACKET");
    this.#packet.set(packet);
    this.#texture.needsUpdate = true;
    this.#label = label;
    this.#launched = false;
  }
  process(renderer: ProbeRenderer): void {
    if (this.#released || this.#label === undefined) return;
    if (renderer.compiling !== false) return;
    if (!this.visible) {
      this.visible = true;
      return;
    }
    if (!this.#owned) return;
    if (this.#readback.stats.failures > 0) throw new Error("TN_ANIMAL_GPU_PROBE_READBACK");
    if (this.#readback.stats.lands > this.#lands) {
      const data = this.#readback.data;
      if (
        !data ||
        data.length !== this.#bake.nV * 8 ||
        !data.every(Number.isFinite) ||
        this.#label === undefined
      )
        throw new Error("TN_ANIMAL_GPU_PROBE_MISSING_OUTPUT");
      const observed = new Vector3();
      for (let vertex = 0; vertex < this.#bake.nV; vertex++) {
        const expected = deformReference(this.#bake, this.#packet, vertex);
        this.#positionError = Math.max(
          this.#positionError,
          observed.fromArray(data, vertex * 8).distanceTo(expected.position),
        );
        this.#normalError = Math.max(
          this.#normalError,
          observed.fromArray(data, vertex * 8 + 4).distanceTo(expected.normal),
        );
      }
      this.#completed.add(this.#label);
      this.#label = undefined;
      this.#lands = this.#readback.stats.lands;
      if (this.#positionError > 1e-4 || this.#normalError > 1e-4)
        throw new Error(
          `TN_ANIMAL_GPU_PROBE_ERROR: position=${this.#positionError}, normal=${this.#normalError}`,
        );
      return;
    }
    if (this.#label === undefined || this.#launched) return;
    renderer.compute(this.#compute);
    this.#readback.request(renderer);
    this.#launched = true;
  }
  detach(): void {
    if (this.#released) return;
    this.#released = true;
    this.#label = undefined;
    releaseAll([
      () => this.#readback.dispose(),
      () => this.#compute.dispose(),
      () => this.geometry.dispose(),
      () => this.material.dispose(),
      () => this.#texture.dispose(),
      () => this.removeFromParent(),
    ]);
  }
}
