import { describe, expect, it } from "vitest";
import {
  PARTICLE_KINDS,
  type ParticleKindName,
  ParticleKindTable,
  createParticleKindEmitter,
} from "../src/particle-kinds.js";

describe("ParticleKindTable", () => {
  it("starts every kind at its stock look and reports it back", () => {
    const table = new ParticleKindTable(["flame", "smoke"]);
    expect(table.kinds).toEqual(["flame", "smoke"]);
    const flame = table.get("flame");
    expect(flame.lifetime[0]).toBeLessThan(flame.lifetime[1]);
    expect(flame.colour).toHaveLength(3);
    expect(flame.gravity).toBe(0);
    expect(table.get("smoke").gravity).toBe(0);
  });

  it("knows only the kinds it was asked for", () => {
    const table = new ParticleKindTable(["flame"]);
    expect(table.has("flame")).toBe(true);
    expect(table.has("debris")).toBe(false);
    expect(() => table.get("debris")).toThrow(RangeError);
    expect(() => table.set("debris", { cone: 1 })).toThrow(RangeError);
  });

  it("retunes a kind in place and leaves the rest of it alone", () => {
    const table = new ParticleKindTable(["flame"]);
    const before = table.get("flame");
    table.set("flame", { colour: [0.2, 0.4, 1], cone: 0.3, lifetime: [0.9, 1.2] });
    const after = table.get("flame");
    expect(after.colour).toEqual([0.2, 0.4, 1]);
    expect(after.cone).toBe(0.3);
    expect(after.lifetime).toEqual([0.9, 1.2]);
    // The fields the patch did not name are untouched.
    expect(after.drag).toBe(before.drag);
    expect(after.highlight).toEqual(before.highlight);
  });

  it("rebuilds nothing when its behaviour is retuned: same nodes, same material, same kernels", () => {
    const table = new ParticleKindTable(["flame"]);
    const nodes = table.nodes("flame");
    const emitter = createParticleKindEmitter({ amount: 256, kind: "flame", table });
    const material = emitter.material;
    const { process, spawn } = emitter;

    // Everything that decides how a particle *moves* is a uniform the compute kernel reads.
    table.set("flame", { buoyancy: 0.5, cone: 1.4, drag: 0.2, gravity: 1, lifetime: [0.5, 0.8] });

    // A retune is a uniform write. Same node graph, same material, same kernels: no new pipeline.
    expect(table.nodes("flame")).toBe(nodes);
    expect(emitter.material).toBe(material);
    expect(emitter.process).toBe(process);
    expect(emitter.spawn).toBe(spawn);
    expect(nodes.shape.value.x).toBeCloseTo(1.4, 6);
    expect(nodes.lifetime.value.y).toBeCloseTo(0.8, 6);
  });

  it("bakes the look, so a colour is a new emitter rather than a live uniform", () => {
    // Measured, not chosen: a `SpriteNodeMaterial` whose `colorNode` is built from uniform nodes
    // draws nothing on this three build, so the sprite's colour and size are literals taken when
    // the emitter is built. This test exists so that stays a stated contract and not a surprise.
    const table = new ParticleKindTable(["flame"]);
    const before = createParticleKindEmitter({ amount: 128, kind: "flame", table });
    table.set("flame", { colour: [0, 1, 0] });
    const unchanged = createParticleKindEmitter({ amount: 128, kind: "flame", table });
    expect(unchanged.material).not.toBe(before.material);
    // A caller that wants the new colour asks for it explicitly.
    const explicit = createParticleKindEmitter({
      amount: 128,
      kind: "flame",
      look: { colour: [0, 1, 0], highlight: [0, 1, 0] },
      table,
    });
    expect(explicit.material).toBeDefined();
  });

  it("rejects values a kernel cannot use", () => {
    const table = new ParticleKindTable(["flame"]);
    expect(() => table.set("flame", { cone: Number.NaN })).toThrow(TypeError);
    expect(() => table.set("flame", { drag: -1 })).toThrow(RangeError);
    expect(() => table.set("flame", { lifetime: [1, 0.2] })).toThrow(RangeError);
    expect(() => table.set("flame", { colour: [1, Number.NaN, 0] })).toThrow(TypeError);
    expect(() => new ParticleKindTable(["flame", "flame"])).toThrow(RangeError);
    expect(() => new ParticleKindTable(["nope" as ParticleKindName])).toThrow(RangeError);
  });

  it("ships a stock kind for every name it publishes", () => {
    const table = new ParticleKindTable();
    expect(table.kinds).toEqual([...PARTICLE_KINDS]);
    for (const kind of PARTICLE_KINDS) {
      const values = table.get(kind);
      expect(values.speed[0]).toBeGreaterThan(0);
      expect(values.size[0]).toBeGreaterThan(0);
      expect(values.lifetime[0]).toBeGreaterThan(0);
    }
  });

  it("builds an emitter whose capacity is its own, so two emitters never share a ring", () => {
    const table = new ParticleKindTable(["flame"]);
    const small = createParticleKindEmitter({ amount: 128, kind: "flame", table });
    const large = createParticleKindEmitter({ amount: 512, kind: "flame", table });
    expect(small.amount).toBe(128);
    expect(large.amount).toBe(512);
    expect(small.material).not.toBe(large.material);
  });
});
