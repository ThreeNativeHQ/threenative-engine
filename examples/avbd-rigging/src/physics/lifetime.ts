import { ComputeDrivenRegistry, type IComputeDriven } from "@threenative/core";
import type { Object3D } from "three";

const prototype = ComputeDrivenRegistry.prototype;
const add = prototype.add;
const remove = prototype.remove;

/** Qualification only: observes the real registry via its public methods; never schedules it. */
export class RiggingRegistrations {
  #registry: ComputeDrivenRegistry | undefined;
  #baseline: number | undefined;
  #live = false;
  #wanted: (object: Object3D & IComputeDriven) => boolean;
  #add: typeof add;
  #remove: typeof remove;

  constructor(wanted: (object: Object3D & IComputeDriven) => boolean) {
    this.#wanted = wanted;
    const observation = this;
    this.#add = function (this: ComputeDrivenRegistry, object, renderer): void {
      if (observation.#wanted(object)) {
        if (observation.#registry !== undefined && observation.#registry !== this)
          throw new Error("TN_RIGGING_REGISTRY: qualification encountered a second registry.");
        observation.#registry = this;
        observation.#baseline ??= this.size;
      }
      add.call(this, object, renderer);
    };
    this.#remove = function (this: ComputeDrivenRegistry, driven): void {
      remove.call(this, driven);
    };
  }

  install(): void {
    if (this.#live || prototype.add !== add || prototype.remove !== remove)
      throw new Error("TN_RIGGING_REGISTRY: another observer owns the public method wrappers.");
    prototype.add = this.#add;
    prototype.remove = this.#remove;
    this.#live = true;
  }

  get snapshot(): { registrations: number; baseline: number } {
    if (this.#registry === undefined || this.#baseline === undefined)
      throw new Error("TN_RIGGING_REGISTRY: the real rigging registry has not been observed.");
    return { registrations: this.#registry.size, baseline: this.#baseline };
  }

  dispose(): void {
    if (!this.#live) return;
    if (prototype.add !== this.#add || prototype.remove !== this.#remove)
      throw new Error("TN_RIGGING_REGISTRY: method ownership changed during qualification.");
    prototype.add = add;
    prototype.remove = remove;
    this.#live = false;
  }
}

export interface IStorageObservation {
  storageAttributes: number;
  storageBytes: number;
  readbackBuffers: number;
  readbackBytes: number;
  attributes: number;
  attributesSize: number;
  geometries: number;
  indexAttributes: number;
  indexAttributesSize: number;
  indirectStorageAttributes: number;
  indirectStorageAttributesSize: number;
  programs: number;
  programsSize: number;
  renderTargets: number;
  textures: number;
  texturesSize: number;
  uniformBuffers: number;
  uniformBuffersSize: number;
  total: number;
}

/** The pinned cohort's public renderer.info accounting, not an inferred disposed flag. */
export function observeStorage(info: unknown): IStorageObservation {
  if (typeof info !== "object" || info === null || !("memory" in info))
    throw new Error("TN_RIGGING_RESOURCES: public renderer memory observations are unavailable.");
  const memory = info.memory;
  if (typeof memory !== "object" || memory === null)
    throw new Error("TN_RIGGING_RESOURCES: renderer memory is malformed.");
  const value = (name: string): number => {
    const result = Reflect.get(memory, name);
    if (!Number.isSafeInteger(result) || result < 0)
      throw new Error(`TN_RIGGING_RESOURCES: ${name} is not an observed nonnegative count.`);
    return result;
  };
  return {
    storageAttributes: value("storageAttributes"),
    storageBytes: value("storageAttributesSize"),
    readbackBuffers: value("readbackBuffers"),
    readbackBytes: value("readbackBuffersSize"),
    attributes: value("attributes"),
    attributesSize: value("attributesSize"),
    geometries: value("geometries"),
    indexAttributes: value("indexAttributes"),
    indexAttributesSize: value("indexAttributesSize"),
    indirectStorageAttributes: value("indirectStorageAttributes"),
    indirectStorageAttributesSize: value("indirectStorageAttributesSize"),
    programs: value("programs"),
    programsSize: value("programsSize"),
    renderTargets: value("renderTargets"),
    textures: value("textures"),
    texturesSize: value("texturesSize"),
    uniformBuffers: value("uniformBuffers"),
    uniformBuffersSize: value("uniformBuffersSize"),
    total: value("total"),
  };
}
