import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { type CastPhase, CastPool, type ISpell } from "../src/spells/cast-pool.js";

function projectile(overrides: Partial<ISpell> = {}): ISpell {
  return {
    name: "test-bolt",
    shape: "projectile",
    speed: 10,
    timing: { charge: 0.5, impact: 0.2, linger: 0.5, travel: 1 },
    ...overrides,
  };
}

describe("CastPool", () => {
  it("steps charge, travel, impact, linger and done in order", () => {
    const pool = new CastPool();
    const phases: CastPhase[] = [];
    const spell = projectile({
      phase: (_cast, phase) => phases.push(phase),
    });
    const cast = pool.cast(spell, new Vector3(0, 0, 10), { from: new Vector3(0, 0, 0) });

    expect(cast.phase).toBe("charge");
    expect(cast.pos.toArray()).toEqual([0, 0, 0]);

    // Charge completes and the ball is released but not yet moved.
    pool.update(0.5);
    expect(cast.phase).toBe("travel");
    expect(cast.pos.toArray()).toEqual([0, 0, 0]);

    // 4 m per 0.4 s at 10 m/s, still short of the target at 10 m.
    pool.update(0.4);
    expect(cast.pos.z).toBeCloseTo(4, 5);
    pool.update(0.4);
    expect(cast.pos.z).toBeCloseTo(8, 5);

    // This step passes the target, so the ball lands on it rather than flying past it.
    pool.update(0.4);
    expect(cast.phase).toBe("impact");
    expect(cast.pos.toArray()).toEqual([0, 0, 10]);

    pool.update(0.2);
    expect(cast.phase).toBe("linger");
    pool.update(0.5);
    expect(cast.phase).toBe("done");
    expect(phases).toEqual(["charge", "travel", "impact", "linger", "done"]);
  });

  it("lands a projectile on the floor the world reports, not at y = 0", () => {
    const pool = new CastPool({ groundAt: () => 4 });
    // Aiming down and forwards from the floor's own height, so the ball has to reach the floor.
    const cast = pool.cast(
      projectile({ timing: { charge: 0, impact: 1, linger: 1, travel: 9 } }),
      new Vector3(0, 0, 30),
      { from: new Vector3(0, 4, 0) },
    );
    pool.update(0);
    expect(cast.phase).toBe("travel");
    for (let step = 0; step < 4 && cast.phase === "travel"; step++) pool.update(0.1);
    expect(cast.phase).toBe("impact");
    expect(cast.pos.y).toBeLessThan(4);
  });

  it("recycles the oldest cast when the pool is full and never grows", () => {
    const pool = new CastPool({ castSlots: 2 });
    const spell = projectile();
    const first = pool.cast(spell, new Vector3(0, 0, 4), { from: new Vector3() });
    expect(first.index).toBe(0);
    pool.update(0.1);
    const second = pool.cast(spell, new Vector3(1, 0, 4), { from: new Vector3() });
    expect(second.index).toBe(1);
    expect(pool.count).toBe(2);

    const third = pool.cast(spell, new Vector3(2, 0, 4), { from: new Vector3() });
    // The oldest record is the one that had been alive longest, and the pool kept its two slots.
    expect(third).toBe(first);
    expect(pool.casts).toHaveLength(2);
    expect(first.phase).toBe("charge");
    expect(third.to.toArray()).toEqual([2, 0, 4]);
  });

  it("allocates nothing per cast: slots, targets and scratch survive a recast", () => {
    const pool = new CastPool({ castSlots: 1 });
    const spell = projectile({ timing: { charge: 0, impact: 0, linger: 0, travel: 0 } });
    const slots = pool.casts;
    const cast = pool.cast(spell, new Vector3(0, 0, 1), { from: new Vector3() });
    const record = cast;
    const scratch = cast.data;
    const from = cast.from;
    const to = cast.to;

    pool.update(0);
    // Charge releases into travel, and a zero-length travel lands on the next step.
    for (let step = 0; step < 3 && cast.phase !== "done"; step++) pool.update(0);
    expect(cast.phase).toBe("done");
    const again = pool.cast(spell, new Vector3(0, 0, 2), { from: new Vector3(0, 1, 0) });

    expect(again).toBe(record);
    expect(pool.casts).toBe(slots);
    expect(again.data).toBe(scratch);
    expect(again.from).toBe(from);
    expect(again.to).toBe(to);
    expect(again.dir.length()).toBeCloseTo(1, 6);
  });

  it("takes a seed, so the same seed reproduces the same cast", () => {
    const pool = new CastPool();
    const a = pool.cast(projectile(), new Vector3(0, 0, 1), { seed: 7 });
    const b = pool.cast(projectile(), new Vector3(0, 0, 1), { seed: 7 });
    expect(a.seed).toBe(7);
    expect(b.seed).toBe(7);
    const c = pool.cast(projectile(), new Vector3(0, 0, 1));
    expect(c.seed).not.toBe(7);
  });

  it("skips travel for a strike and lands on release", () => {
    const pool = new CastPool();
    const cast = pool.cast(
      projectile({ shape: "strike", timing: { charge: 0.3 } }),
      new Vector3(3, 0, 3),
      {
        from: new Vector3(),
      },
    );
    pool.update(0.3);
    expect(cast.phase).toBe("impact");
    expect(cast.pos.toArray()).toEqual([3, 0, 3]);
  });

  it("holds a beam open while the button is down", () => {
    const pool = new CastPool();
    const cast = pool.cast(
      projectile({ shape: "beam", timing: { charge: 0, travel: 0.2 } }),
      new Vector3(0, 0, 5),
      {
        from: new Vector3(),
        held: true,
      },
    );
    pool.update(0);
    for (let step = 0; step < 10; step++) pool.update(0.1);
    expect(cast.phase).toBe("travel");
    pool.releaseHeld();
    pool.update(0.3);
    expect(cast.phase).toBe("impact");
  });

  it("rejects a target that is not a finite world point", () => {
    const pool = new CastPool();
    expect(() => pool.cast(projectile(), new Vector3(0, Number.NaN, 0))).toThrow(TypeError);
  });
});
