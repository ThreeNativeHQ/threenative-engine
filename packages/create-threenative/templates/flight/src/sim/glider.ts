// The hang glider, flown on the engine's `FlightModel`.
//
// The engine owns lift, drag and stall: lift and drag come from the airspeed and the angle of
// attack, a wing past its critical angle loses lift, and a stalled wing drops its nose. This file
// owns only the airframe (a 95 kg glider and pilot under a 24 m² sail), the air it flies in (the
// wind and the thermals ride in as the model's wind vector) and a small speed-stability term.
//
// The engine's elevator is a load command, so a plane keeps its trim speed only by being fast. A
// hang glider is speed-stable: it noses down when slow and noses up when fast. The term below adds
// that, which is what keeps a dive from running away and gives a stall its recovery.
//
// Reference, pilotwings-64-n64decomp `stall-threshold`: the heads-up warning shows under 8 m/s
// (`hang_glider1.c:423`). The stall itself is the engine's, so the game does not copy the card's
// latch (4 and 12) any more.
import { FlightModel } from "@threenative/core";
import type { IAircraftAirframe, IFlightState } from "@threenative/core";
import type { IVec3 } from "./world.js";

/** The heads-up warning shows under this airspeed. Reference: `hang_glider1.c:423`. */
export const STALL_WARNING = 8;
/** The glide the pilot trims for, m/s. */
export const TRIM_SPEED = 17;
/** Stick gain on the roll: full right banks about 30 degrees, a turn that still glides. */
const TURN_AUTHORITY = 0.6;
/** Pull added per m/s over the trim speed (and pushed under it). */
const SPEED_STABILITY = 0.04;
/** The stick the stability term may add, so it cannot out-pull the pilot. */
const STABILITY_LIMIT = { high: 0.5, low: -0.4 };
/** A wing is stalled over this share of its lift collapse, and flies again under the lower one. */
const STALL_IN = 0.5;
const STALL_OUT = 0.1;

const AIRFRAME: IAircraftAirframe = Object.freeze({
  chord: 1.6,
  dryMass: 95,
  fuelMass: 0,
  pitchInertia: 60,
  power: 0,
  propEfficiency: 0,
  rollInertia: 90,
  span: 10.5,
  staticThrust: 0,
  wingArea: 24,
  yawInertia: 120,
});

/** Every field the engine reads, so a state the game built is a whole `IFlightState`. */
function newState(): IFlightState {
  return {
    aileron: 0,
    aoa: 0,
    assist: true,
    beta: 0,
    brakePos: 0,
    brakes: false,
    controlAileron: 0,
    drag: 0,
    elevator: 0,
    engineCut: false,
    flapPos: 0,
    flaps: 0,
    flightTime: 0,
    fuel: 0,
    gear: false,
    gearPos: 0,
    gforce: 1,
    groundSpeed: 0,
    heading: 0,
    hp: 100,
    ias: 0,
    lift: 0,
    mass: 0,
    payloadDrag: 0,
    payloadMass: 0,
    pitch: 0,
    pitchRate: 0,
    roll: 0,
    rollRate: 0,
    rpm: 0,
    rudder: 0,
    speed: TRIM_SPEED,
    stall: 0,
    throttle: 0,
    thrust: 0,
    trim: 0.04,
    vx: 0,
    vy: 0,
    vz: 0,
    x: 0,
    y: 0,
    yawRate: 0,
    z: 0,
  };
}

/** A view of three state fields as one point, so the game moves the glider by writing `pos.y`. */
function view(state: IFlightState, x: "x" | "vx", y: "y" | "vy", z: "z" | "vz"): IVec3 {
  return {
    get x() {
      return state[x];
    },
    set x(value: number) {
      state[x] = value;
    },
    get y() {
      return state[y];
    },
    set y(value: number) {
      state[y] = value;
    },
    get z() {
      return state[z];
    },
    set z(value: number) {
      state[z] = value;
    },
  };
}

export interface IGliderInput {
  /** +1 pulls the nose up, -1 pushes it down. */
  readonly pitch: number;
  /** +1 banks right. */
  readonly roll: number;
}

export class Glider {
  readonly state: IFlightState = newState();
  readonly pos: IVec3 = view(this.state, "x", "y", "z");
  readonly vel: IVec3 = view(this.state, "vx", "vy", "vz");
  stalled = false;
  readonly #wind: IVec3 = { x: 0, y: 0, z: 0 };
  #model: FlightModel;

  constructor(x: number, y: number, z: number, heading: number, air: IVec3) {
    this.#model = new FlightModel({
      airframe: AIRFRAME,
      deckHeight: -1000,
      state: this.state,
      wind: this.#wind,
    });
    this.place(x, y, z, heading, 0, air);
  }

  /** Put the glider in trim at a point, with a heading (game yaw) and a bank (+ is right). */
  place(x: number, y: number, z: number, heading: number, bank: number, air: IVec3): void {
    const { state } = this;
    state.x = x;
    state.y = y;
    state.z = z;
    // The engine's heading is a compass angle: 0 flies down -Z and a right turn adds to it.
    state.heading = Math.PI - heading;
    state.pitch = -0.1;
    state.roll = -bank;
    state.speed = TRIM_SPEED;
    Object.assign(this.#wind, air);
    this.#model.reset();
    this.stalled = false;
  }

  /** The game's yaw: forward is (sin, 0, cos), and a right turn lowers it. */
  get heading(): number {
    return Math.PI - this.state.heading;
  }

  /** Bank angle, + is right wing down. */
  get bank(): number {
    return -this.state.roll;
  }

  /** Nose angle over the horizon. */
  get attitude(): number {
    return this.state.pitch;
  }

  /** Speed through the air, m/s. */
  get airspeed(): number {
    return this.state.speed;
  }

  step(dt: number, input: IGliderInput, air: IVec3): void {
    const { state } = this;
    Object.assign(this.#wind, air);
    const stability = Math.min(
      STABILITY_LIMIT.high,
      Math.max(STABILITY_LIMIT.low, (state.speed - TRIM_SPEED) * SPEED_STABILITY),
    );
    this.#model.step(dt, {
      pitch: Math.min(1, Math.max(-1, input.pitch + stability)),
      turn: input.roll * TURN_AUTHORITY,
    });
    this.stalled = state.stall > (this.stalled ? STALL_OUT : STALL_IN);
  }
}
