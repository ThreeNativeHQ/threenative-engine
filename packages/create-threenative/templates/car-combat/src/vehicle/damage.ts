// Per-panel and per-part damage (reference cards carmageddon/impact-damage-routing and
// subsystem-damage). An impact is classified against the car's box into a region, and every rule
// that matches adds levels to a named part. Parts saturate, a car is wrecked by a real impact
// only, and repair crawls back instead of snapping.

export type Region = "front" | "rear" | "left" | "right";
export const REGIONS: readonly Region[] = ["front", "rear", "left", "right"];
export type Part =
  | "engine"
  | "transmission"
  | "driver"
  | "wheel0"
  | "wheel1"
  | "wheel2"
  | "wheel3"
  | "brake0"
  | "brake1"
  | "brake2"
  | "brake3";
export const PARTS: readonly Part[] = [
  "engine",
  "transmission",
  "driver",
  "wheel0",
  "wheel1",
  "wheel2",
  "wheel3",
  "brake0",
  "brake1",
  "brake2",
  "brake3",
];

export const DAMAGE = {
  /** A hit worth less than five levels is ignored: a long scrape never kills a car (crush.c:575). */
  minimumPerHit: 5,
  /** Parts saturate at 99 (crush.c:579). */
  ceiling: 99,
  /** A hit under ten levels cannot push a part across the ceiling (crush.c:580). */
  finishingHit: 10,
  /** Wheel damage past 30 levels pulls the wheel out of true (crush.c:1323). */
  wheelWobbleStart: 30,
  /** Player damage per unit of energy (crush.c:621). */
  playerScale: 30,
  /** Opponent damage per unit of energy: 10, plus one per 20 ranks past 10 (crush.c:624). */
  opponentScale: 10,
  opponentRankFloor: 10,
  opponentRankDivisor: 20,
  /** Kit tuning: rivals are the wreck targets, so they weaken by this factor. */
  rivalFragility: 3,
  /** Kit tuning: metres per second of velocity change that count as one unit of energy. */
  energyReference: 18,
  /** Repair speed in levels per second. Kit tuning; the card repairs vertex by vertex. */
  repairPerSecond: 9,
} as const;

/** Which parts a hit on each region reaches, and by how much of the levels (a rule clause each). */
const RULES: Record<Region, readonly (readonly [Part, number])[]> = {
  front: [["engine", 1], ["driver", 0.35], ["wheel0", 0.3], ["wheel1", 0.3], ["brake0", 0.25], ["brake1", 0.25]],
  rear: [["transmission", 1], ["driver", 0.3], ["wheel2", 0.3], ["wheel3", 0.3], ["brake2", 0.25], ["brake3", 0.25]],
  left: [["wheel0", 0.7], ["wheel2", 0.7], ["brake0", 0.4], ["brake2", 0.4], ["driver", 0.4], ["engine", 0.15]],
  right: [["wheel1", 0.7], ["wheel3", 0.7], ["brake1", 0.4], ["brake3", 0.4], ["transmission", 0.15]],
};

/** Local direction of the hit (from the car's centre toward the point that was struck) to a region. */
export function classify(localX: number, localZ: number, halfWidth: number, halfLength: number): Region {
  // The face the point is nearest, in proportion to the box: depth decides front or back.
  if (Math.abs(localZ) / halfLength >= Math.abs(localX) / halfWidth) return localZ < 0 ? "front" : "rear";
  return localX < 0 ? "left" : "right";
}

/** Levels of damage a velocity change of `dv` m/s deals, before the per-part rules. */
export function impactLevels(dv: number, player: boolean, rank = 40): number {
  const energy = (dv / DAMAGE.energyReference) ** 2;
  if (player) return energy * DAMAGE.playerScale;
  const scale = DAMAGE.opponentScale + (Math.max(rank, DAMAGE.opponentRankFloor) - DAMAGE.opponentRankFloor) / DAMAGE.opponentRankDivisor;
  return energy * scale * DAMAGE.rivalFragility;
}

export class CarDamage {
  readonly parts: Record<Part, number> = Object.fromEntries(PARTS.map((part) => [part, 0])) as Record<Part, number>;
  /** 0..1 crumple of each body panel, for the mesh. */
  readonly crush: Record<Region, number> = { front: 0, left: 0, rear: 0, right: 0 };
  hits = 0;

  /** Applies one impact. Returns the levels the hit was worth (0 when ignored). */
  hit(region: Region, levels: number): number {
    if (levels < DAMAGE.minimumPerHit) return 0;
    this.hits += 1;
    for (const [part, weight] of RULES[region]) {
      const amount = levels * weight;
      const next = this.parts[part] + amount;
      const capped = next >= DAMAGE.ceiling && amount < DAMAGE.finishingHit ? DAMAGE.ceiling - 1 : Math.min(DAMAGE.ceiling, next);
      this.parts[part] = Math.max(this.parts[part], capped);
    }
    this.crush[region] = Math.min(1, this.crush[region] + levels / DAMAGE.ceiling);
    return levels;
  }

  /** Wrecked: the engine, transmission or driver is finished, or all four wheels are (crush.c:545). */
  get wrecked(): boolean {
    const p = this.parts;
    const end = DAMAGE.ceiling;
    return p.engine >= end || p.transmission >= end || p.driver >= end || (p.wheel0 >= end && p.wheel1 >= end && p.wheel2 >= end && p.wheel3 >= end);
  }

  /** Power left: 1 until the engine takes more than ten levels, then 1% less per level. */
  get power(): number {
    return Math.max(0, 1 - Math.max(0, this.parts.engine - 10) / 100);
  }

  /** Brake efficiency of one axle (0 front, 1 rear), averaged over its two units (car.c:2394). */
  axleBrake(axle: 0 | 1): number {
    const average = (this.parts[`brake${axle * 2}` as Part] + this.parts[`brake${axle * 2 + 1}` as Part]) / 2;
    const grace = DAMAGE.ceiling / 5;
    if (average <= grace) return 1;
    const t = Math.min(1, (average - grace) / (DAMAGE.ceiling - grace));
    return 1 - t * t;
  }

  get brakeEfficiency(): number {
    return (this.axleBrake(0) + this.axleBrake(1)) / 2;
  }

  /** The handbrake dies once either rear brake unit reaches 60 levels (constants.h:920). */
  get handbrakeWorks(): boolean {
    return this.parts.brake2 < 60 && this.parts.brake3 < 60;
  }

  /** Grip kept by a wheel: past 30 levels it drags the car, down to half at the ceiling. */
  wheelGrip(index: number): number {
    const level = this.parts[`wheel${index}` as Part];
    return level <= DAMAGE.wheelWobbleStart ? 1 : 1 - 0.5 * ((level - DAMAGE.wheelWobbleStart) / (DAMAGE.ceiling - DAMAGE.wheelWobbleStart));
  }

  /** Radians the wheel hangs out of true (crush.c:1323). */
  wheelWobble(index: number): number {
    return Math.max(0, this.parts[`wheel${index}` as Part] - DAMAGE.wheelWobbleStart) * 0.004;
  }

  get total(): number {
    return PARTS.reduce((sum, part) => sum + this.parts[part], 0);
  }

  /** The share of the car left, 0..1, for the HUD: the worst of the three critical parts. */
  get health(): number {
    const worst = Math.max(this.parts.engine, this.parts.transmission, this.parts.driver);
    return 1 - worst / DAMAGE.ceiling;
  }

  /** Repair runs the damage backwards: every part and panel eases toward new. */
  repair(dt: number): void {
    for (const part of PARTS) this.parts[part] = Math.max(0, this.parts[part] - DAMAGE.repairPerSecond * dt);
    for (const region of REGIONS) this.crush[region] = Math.max(0, this.crush[region] - (DAMAGE.repairPerSecond / DAMAGE.ceiling) * dt);
  }

  get repaired(): boolean {
    return this.total === 0 && REGIONS.every((region) => this.crush[region] === 0);
  }
}
