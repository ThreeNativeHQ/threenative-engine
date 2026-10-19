import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IPhysicsContext } from "@threenative/physics";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { CAR, FEEL, RIDE, SAG } from "../templates/racing/src/entities/CarBody.js";
import { headingError } from "../templates/racing/src/entities/LineDriver.js";
import { cameraBank, chaseCamera } from "../templates/racing/src/render/camera.js";
import { toon } from "../templates/racing/src/render/palette.js";
import { rankRacers, routeProgress } from "../templates/racing/src/track/Ranking.js";
import { TOTAL_LAPS, gridPosition, intersectRay } from "../templates/racing/src/track/Track.js";
import {
  CIRCUIT,
  GRID,
  GRID_DISTANCE,
  KERB_HEIGHT,
  LINE_AT,
  TRACK_WIDTH,
  groundHeight,
} from "../templates/racing/src/track/circuit.js";

const racingRoot = path.resolve("packages/create-threenative/templates/racing");
const read = (file: string): string => readFileSync(path.join(racingRoot, file), "utf8");

describe("the circuit", () => {
  it("is one closed centreline every other surface is derived from", () => {
    const circuit = read("src/track/circuit.ts");
    const track = read("src/track/Track.ts");
    const rival = read("src/entities/Rival.ts");
    const driver = read("src/entities/LineDriver.ts");
    const sector = read("src/track/TrackSector.ts");
    const ranking = read("src/track/Ranking.ts");

    // The defect this replaces: the road was boxes between hand-typed route points and the cars
    // drove a different curve, so the racing line bulged 4.5 m off the tarmac. One `CircuitLine`,
    // read by the road builder, the rival, the driver, the sectors and the ranking, is the only
    // way that cannot come back.
    expect(track).not.toMatch(/ROUTE_POINTS/u);
    for (const source of [track, rival, driver, sector, ranking]) {
      expect(source).toContain("circuit.js");
    }
    expect(existsSync(path.join(racingRoot, "src/track/Driveline.ts"))).toBe(false);
    expect(circuit).toContain("class CircuitLine");
  });

  it("measures as a real circuit: a long straight, a hairpin, a sweeper and esses", () => {
    // 850 m at the tyres' lateral limit is about a 49 s ideal lap, so a three-lap race is 40-70 s a lap
    // on a car whose top speed is 17 m/s. A 1.2 km layout at that pace would be a 70 s lap with no
    // corners in it, which is why the circuit is scaled to the car rather than to a real circuit.
    expect(CIRCUIT.totalLength).toBeGreaterThan(700);
    expect(CIRCUIT.totalLength).toBeLessThan(1000);
    expect(CIRCUIT.spacing).toBeLessThanOrEqual(1.2);

    let tightest = Number.POSITIVE_INFINITY;
    const centre = new Vector3();
    for (let index = 0; index < CIRCUIT.count; index += 1) {
      const sample = CIRCUIT.at(
        (index * CIRCUIT.totalLength) / CIRCUIT.count,
        CIRCUIT.createSample(),
      );
      tightest = Math.min(tightest, sample.radius);
      centre.copy(sample.point);
    }
    // The hairpin is the tightest thing on the circuit. It is laid out on a 16.5 m arc, and the
    // sampled curvature (turn per 2 x spacing, then a 21-tap box filter) reads it at about 31 m:
    // that is the number the banking, the kerbs and the driver's braking are all tuned against.
    expect(tightest).toBeGreaterThan(24);
    expect(tightest).toBeLessThan(36);
    // No two parts of the circuit pass close enough for their road surfaces to touch. The walk
    // skips neighbours within 40 m of arc, so this is a genuine self-approach rather than the
    // seam or the inside of the hairpin measured against its own exit.
    let closest = Number.POSITIVE_INFINITY;
    const other = new Vector3();
    for (let index = 0; index < CIRCUIT.count; index += 1) {
      CIRCUIT.at((index * CIRCUIT.totalLength) / CIRCUIT.count, CIRCUIT.createSample());
      centre.copy(CIRCUIT.at((index * CIRCUIT.totalLength) / CIRCUIT.count).point);
      for (let step = 40; step < CIRCUIT.count - 40; step += 1) {
        CIRCUIT.at((((index + step) % CIRCUIT.count) * CIRCUIT.totalLength) / CIRCUIT.count);
        other.copy(
          CIRCUIT.at((((index + step) % CIRCUIT.count) * CIRCUIT.totalLength) / CIRCUIT.count)
            .point,
        );
        closest = Math.min(closest, centre.distanceTo(other));
      }
    }
    expect(closest).toBeGreaterThan(2 * (TRACK_WIDTH / 2) + 6);
  });

  it("banks the fast corners and keeps the hairpin flatter than a road, not a ramp", () => {
    let steepest = 0;
    let straight = 0;
    for (let index = 0; index < CIRCUIT.count; index += 1) {
      const sample = CIRCUIT.at(
        (index * CIRCUIT.totalLength) / CIRCUIT.count,
        CIRCUIT.createSample(),
      );
      if (Math.abs(sample.curvature) < 1e-4) straight = Math.max(straight, Math.abs(sample.bank));
      else steepest = Math.max(steepest, Math.abs(sample.bank));
    }
    // A straight is level, a corner is banked into it, and neither is a wall.
    expect(straight).toBeLessThan(0.005);
    expect(steepest).toBeGreaterThan(0.02);
    expect(steepest).toBeLessThanOrEqual(0.12);
  });

  it("puts the grid on the main straight, both cars behind the line, the rival on pole", () => {
    expect(GRID_DISTANCE.rival).toBeGreaterThan(GRID_DISTANCE.player);
    // The player is second: the rival's slot is further down the straight and on the other side.
    expect(GRID.player).toBeLessThan(0);
    expect(GRID.rival).toBeGreaterThan(0);
    expect(GRID.rival).toBeGreaterThan(GRID.player);
    // Both short of the start/finish line, so the first gate either car meets is the lap.
    const finish = LINE_AT.finish * CIRCUIT.totalLength;
    expect(GRID_DISTANCE.rival).toBeLessThan(finish);
    // And the sectors come after it, in driving order, or no lap could ever complete.
    expect(LINE_AT.sector1).toBeGreaterThan(LINE_AT.finish);
    expect(LINE_AT.sector2).toBeGreaterThan(LINE_AT.sector1);
    expect(TOTAL_LAPS).toBe(3);

    const player = gridPosition("player", new Vector3());
    const rival = gridPosition("rival", new Vector3());
    expect(player.distanceTo(rival)).toBeGreaterThan(4);
    // Both sit on the tarmac, not on the grass beside it.
    expect(Math.abs(player.y - groundHeight(player.x, player.z))).toBeLessThan(0.2);
  });

  it("keeps a kerb a rumble strip rather than a wall", () => {
    expect(KERB_HEIGHT).toBeLessThan(RIDE - CAR.shape.height / 2);
  });

  it("does not withhold the first frame for the sky photograph", () => {
    const race = read("src/scenes/Race.ts");
    // `await`ing the texture in `load()` held scene entry for a decode, and the playtest bridge
    // describes the scene before the runtime enters it, so `survives` read
    // TN_PLAYTEST_CAPABILITY_MISSING for `runtime.components`.
    const load = race.slice(race.indexOf("override load"), race.indexOf("override enter"));
    expect(load).toContain('texture("sky.jpg")');
    // The sampling continuation may await after decode; the load hook itself must still
    // return immediately so the player registry is populated synchronously.
    expect(load).toContain("override load(ctx: GameCtx): void");
    expect(load).toContain('void ctx.assets.texture("sky.jpg").then(');
    expect(load.split(".then(")[0]).not.toMatch(/\bawait\b/u);
  });
});

describe("racing route promotion", () => {
  it("keeps the horizon upright and banks from lateral load, not from world x", () => {
    const camera = new PerspectiveCamera();
    const target = new Vector3(-3, RIDE, -18);
    const heading = new Vector3(1, 0, 0);

    // Facing along +x is the case the old `cameraRoll` got wrong: it banked on `heading.x`, so on
    // this straight — and on every straight of a square circuit — the horizon tilted for no reason.
    chaseCamera(camera, target, heading, 1);
    camera.rotateZ(cameraBank(0, FEEL.lateral));
    const level = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    expect(Math.abs(level.z)).toBeLessThan(0.05);
    expect(level.y).toBeGreaterThan(0.8);

    // Loaded to the right, the camera leans with the car and no more.
    const banked = cameraBank(FEEL.lateral, FEEL.lateral);
    expect(banked).toBeGreaterThan(0);
    expect(cameraBank(FEEL.lateral * 4, FEEL.lateral)).toBe(banked);
    expect(cameraBank(-FEEL.lateral, FEEL.lateral)).toBe(-banked);
  });

  it("anchors the chase camera to measured velocity, so a sliding car keeps the corner in view", () => {
    const camera = new PerspectiveCamera();
    const target = new Vector3(0, RIDE, 0);
    // The nose points along +x while the car is travelling along +z: a car sideways in a corner.
    // Anchored to the nose the camera would sit off to the side, looking at the tarmac.
    const sliding = chaseCamera(camera, target, new Vector3(1, 0, 0), 1, { x: 0, y: 0, z: 8 });
    expect(sliding).toBeUndefined();
    expect(camera.position.z).toBeLessThan(-5);
    expect(Math.abs(camera.position.x)).toBeLessThan(1);
  });

  it("drives both cars on the same measured chassis, through the same controller", () => {
    const player = read("src/entities/RacingCar.ts");
    const rival = read("src/entities/Rival.ts");
    const chassis = read("src/entities/CarBody.ts");
    const driver = read("src/entities/LineDriver.ts");

    // One `VehicleBody3D`, one chassis, two drivers. The defect this replaces was a car whose speed
    // and heading were numbers it rewrote every frame; neither driver may own a speed any more.
    expect(chassis).toContain("VehicleBody3D");
    expect(player).toContain("new CarBody");
    expect(rival).toContain("new CarBody");
    expect(rival).toContain("new LineDriver");
    expect(player).toContain("engineForce");
    expect(player).toContain("brake");
    // The two fields the fake kept as its own truth. Read the source, not the prose: the
    // comment above `RacingCar` names both of them while describing what replaced them.
    for (const source of [player, rival]) {
      expect(source.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(/#speed\b\s*=|#heading\b/u);
    }
    // The rival has no controller of its own: a second driver would be a second, worse car. Its
    // steering, throttle and braking all live in the one LineDriver the autopilot also uses.
    expect(rival.replace(/\/\*[\s\S]*?\*\//gu, "")).not.toMatch(/steering\s*=|engineForce\s*=/u);
    expect(driver).toContain("class LineDriver");
    // The suspension is measured, not assumed: the sag is gravity over four times the stiffness.
    expect(SAG).toBeCloseTo(CAR.gravity / (4 * CAR.suspensionStiffness), 10);
    expect(RIDE).toBeCloseTo(CAR.suspensionRestLength - SAG, 10);
    expect(RIDE).toBeGreaterThan(0.15);
  });

  it("steers toward the line instead of away from it", () => {
    const from = new Vector3(0, 0, 0);
    // Facing +x. A point ahead and to the driver's right (+z) is a positive error; one to the left
    // is negative. Getting this backwards drives the car into the barriers at the first corner,
    // which is a two-minute playtest loop to find and one line to fix.
    expect(headingError(0, new Vector3(4, 0, 2), from)).toBeGreaterThan(0);
    expect(headingError(0, new Vector3(4, 0, -2), from)).toBeLessThan(0);
    expect(headingError(0, new Vector3(6, 0, 0), from)).toBeCloseTo(0, 10);
    // Wrapped, so a target behind the car is 180° rather than 540°.
    expect(headingError(Math.PI, new Vector3(-5, 0, 0), from)).toBeCloseTo(0, 6);
  });

  it("projects a car onto the circuit in metres, not in whole samples", () => {
    // `PathFollow3D` projects onto 128 samples, which on an 830 m circuit is one every 6.5 m: the
    // autopilot aims 4 m ahead, so a 6.5 m quantisation puts the aim point off the road. This
    // line is the geometry the road is built from, so the tarmac and the aim point cannot differ.
    const half = CIRCUIT.totalLength * 0.3;
    const sample = CIRCUIT.at(half, CIRCUIT.createSample());
    const target = {
      curvature: 0,
      distance: 0,
      lateral: 0,
      point: new Vector3(),
      tangent: new Vector3(),
    };
    CIRCUIT.project(sample.point, target);
    expect(target.distance).toBeCloseTo(half, 1);
    expect(target.lateral).toBeCloseTo(0, 3);
    // A car two metres to the right of the line is two metres to the right of the projection.
    const offset = sample.point.clone().addScaledVector(sample.right, 2);
    CIRCUIT.project(offset, target);
    expect(target.lateral).toBeCloseTo(2, 1);
  });

  it("keeps lap-aware progress and ranking in the racing template", () => {
    const half = CIRCUIT.totalLength / 4;
    const position = CIRCUIT.at(half, CIRCUIT.createSample()).point;
    const ranked = rankRacers(CIRCUIT, [
      { id: "racer-0-behind", lap: 0, position },
      { id: "racer-1-ahead", lap: 1, position },
    ]);

    expect(ranked.map(({ id }) => id)).toEqual(["racer-1-ahead", "racer-0-behind"]);
    expect(ranked[0]?.place).toBe(1);
    expect(ranked[0]?.routeProgress).toBeGreaterThan(CIRCUIT.totalLength);
    expect(routeProgress(CIRCUIT, position, 1)).toBe(ranked[0]?.routeProgress);
    expect(() => routeProgress(CIRCUIT, position, -1)).toThrow(/lap/u);
  });

  it("uses the direct-space ray query and only falls back without that API", () => {
    const query = vi.fn(() => ({ distance: 2, normal: { x: 0, y: 1, z: 0 } }));
    const fallback = vi.fn(() => ({ distance: 99, normalY: -1 }));
    const physics = {
      directSpaceState: { intersectRay: query },
    } as unknown as IPhysicsContext;
    const origin = new Vector3(3, 4, 5);
    const direction = new Vector3(0, -1, 0);

    expect(intersectRay(physics, fallback)(origin, direction, 6)).toEqual({
      distance: 2,
      normalY: 1,
    });
    expect(query).toHaveBeenCalledWith({
      collisionMask: 2,
      from: origin,
      to: new Vector3(3, -2, 5),
    });
    expect(fallback).not.toHaveBeenCalled();

    const fallbackOnly = vi.fn(() => ({ distance: 1, normalY: 0 }));
    expect(intersectRay({} as IPhysicsContext, fallbackOnly)(origin, direction, 6)).toEqual({
      distance: 1,
      normalY: 0,
    });
    expect(fallbackOnly).toHaveBeenCalledOnce();
  });

  it("keeps a direct-space no-hit result instead of probing the visual meshes", () => {
    const query = vi.fn(() => undefined);
    const fallback = vi.fn(() => ({ distance: 99 }));
    const physics = {
      directSpaceState: { intersectRay: query },
    } as unknown as IPhysicsContext;

    expect(
      intersectRay(physics, fallback)(new Vector3(), new Vector3(0, -1, 0), 2),
    ).toBeUndefined();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keys toon materials by color and roughness", () => {
    const matte = toon(0x4a7f93, 0.2);
    const glossy = toon(0x4a7f93, 0.8);

    expect(glossy).not.toBe(matte);
    expect(matte.roughness).toBe(0.2);
    expect(glossy.roughness).toBe(0.8);
    expect(toon(0x4a7f93, 0.2)).toBe(matte);
    expect(toon(0x4a7f93, 0.8)).toBe(glossy);
  });
});
