// The match: four pawns take turns on the board, then a minigame decides who gains coins. The whole
// turn is one state machine and every transition is in `update`, so a rule is read in one place:
//
//   roll -> rolling -> [junction] -> walk -> [star -> award] -> ... -> land -> settle -> next pawn
//   after the fourth pawn: intro -> minigame -> result -> next turn, or over at the turn limit
//
// The match owns no meshes. A pawn's board position is plain numbers, and the scene dresses them.
import {
  CHAINS,
  type ICursor,
  type ISpace,
  JUNCTION,
  createSpaces,
  cursorBefore,
  lookahead,
  spaceAt,
} from "../board/layout.js";
import { StarRotation } from "../board/star.js";
import { Dash } from "../minigames/dash.js";
import { type IMiniInput, type IMinigame, MINIGAME_PRIZE } from "../minigames/minigame.js";
import { Rope } from "../minigames/rope.js";
import { Stream } from "../rng.js";
import { JUNCTION_NODES, STAR_NODES, decide } from "./decide.js";

/** Four pawns. mario-party-1 `turn-rotation-reseat` (src/overlays/ovl_3E_FirstMap/257020.c:276). */
export const ROSTER = 4;
/** The shortest play type, shortened: ten turns. mario-party-1 `match-turn-limits` (src/57330.c:211). */
export const TURN_LIMIT = 10;
/** A blue space pays and a red space takes three coins. mario-party-1 `landed-space-coins` (257020.c:325, :331). */
export const COIN_STEP = 3;
/** The pause after a coin change, 30 updates at 60 Hz. mario-party-1 `landed-space-coins` (257020.c:328, rate unverified). */
export const SETTLE_TIME = 0.5;
/** The star costs 20 coins. mario-party-1 `star-purchase` (src/overlays/ovl_5E_StarVisitEternalStar/298AE0.c:395). */
export const STAR_PRICE = 20;
/** No pawn holds more than 99 stars. mario-party-1 `star-purchase` (298AE0.c:387). */
export const STAR_CAP = 99;
/** The die has ten faces and a pawn starts on ten coins. No card pins either: the kit's own. */
export const DIE_SIDES = 10;
export const START_COINS = 10;
/** Fixed travel per second between spaces, and the timings of the beats. No card pins these. */
const WALK_SPEED = 6;
const ROLL_TIME = 0.8;
const THINK_TIME = 0.6;
const AWARD_TIME = 1.2;
const INTRO_TIME = 2.4;
const RESULT_TIME = 2.4;
const MESSAGE_TIME = 2.5;

export type TurnPhase =
  | "roll"
  | "rolling"
  | "junction"
  | "walk"
  | "star"
  | "award"
  | "settle"
  | "intro"
  | "minigame"
  | "result"
  | "over";

export interface IPlayer {
  readonly seat: number;
  readonly name: string;
  readonly human: boolean;
  coins: number;
  stars: number;
  /** Where the pawn stands, and the slot it looks ahead to. mario-party-1 `board-chain-cursor`. */
  cur: ICursor;
  next: ICursor;
  x: number;
  z: number;
  /** Facing, three.js yaw: 0 faces +z. */
  yaw: number;
  walking: boolean;
  lastRoll: number;
}

export interface IMatchEvent {
  readonly name: string;
  readonly seat: number;
  readonly value: number;
}

export class Match {
  readonly rng: Stream;
  readonly spaces: ISpace[] = createSpaces();
  readonly star: StarRotation;
  readonly players: IPlayer[] = [];
  readonly events: IMatchEvent[] = [];
  turn = 1;
  active = 0;
  phase: TurnPhase = "roll";
  die = 0;
  stepsLeft = 0;
  prompt: "" | "junction" | "star" = "";
  message = "";
  minigame: IMinigame | undefined;
  /** Seats best first, once the match is over. */
  ranking: number[] = [];
  /** Playtest hooks, set by a station: the next roll, every roll, the minigame, a flawless CPU. */
  forcedRoll = 0;
  fastRolls = false;
  forcedMinigame: "dash" | "rope" | undefined;
  perfectCpu = false;
  #timer = 0;
  #length = 1;
  #messageTimer = 0;
  #askedAt = -1;

  constructor(seed: number) {
    this.rng = new Stream(seed);
    this.star = new StarRotation(this.spaces, this.rng);
    for (let seat = 0; seat < ROSTER; seat += 1) {
      const player: IPlayer = {
        seat,
        name: seat === 0 ? "You" : `CPU ${seat}`,
        human: seat === 0,
        coins: START_COINS,
        stars: 0,
        cur: { chain: 0, slot: 0 },
        next: { chain: 0, slot: 1 },
        x: 0,
        z: 0,
        yaw: 0,
        walking: false,
        lastRoll: 0,
      };
      this.players.push(player);
      this.seat(player, player.cur);
    }
    this.#start(THINK_TIME);
  }

  get current(): IPlayer {
    return this.players[this.active] as IPlayer;
  }

  /** The space a pawn stands on, and its world point. */
  spaceOf(player: IPlayer): ISpace {
    return this.spaces[spaceAt(player.cur)] as ISpace;
  }

  /**
   * Seat a pawn on a cursor: the position comes from the space record, never from memory, and the
   * lookahead points one slot ahead. mario-party-1 `board-chain-cursor` (src/4D770.c:332).
   */
  seat(player: IPlayer, cursor: ICursor): void {
    player.cur = cursor;
    player.next = lookahead(cursor);
    const space = this.spaces[spaceAt(cursor)] as ISpace;
    player.x = space.x;
    player.z = space.z;
    player.walking = false;
  }

  /** Put the pawn one step before `id`. For playtest stations. */
  seatBefore(player: IPlayer, id: number): void {
    this.seat(player, cursorBefore(id));
  }

  /** How far the current timed beat has run, 0 to 1: the star's flight reads it. */
  get beat(): number {
    return Math.min(1, Math.max(0, 1 - this.#timer / this.#length));
  }

  /** Jump to the minigame round now. For playtest stations. */
  skipToMinigame(id: "dash" | "rope"): void {
    this.forcedMinigame = id;
    this.active = ROSTER - 1;
    this.phase = "settle";
    this.#start(0);
  }

  /** The human pressed the confirm key: roll, take the shortcut, or buy the star. */
  confirm(): void {
    this.#answer(true);
  }

  /** The human pressed the decline key: stay on the ring, or leave the star. */
  decline(): void {
    this.#answer(false);
  }

  update(dt: number, input: IMiniInput): void {
    this.#messageTimer = Math.max(0, this.#messageTimer - dt);
    if (this.#messageTimer === 0) this.message = "";
    const cpu = !this.current.human;
    switch (this.phase) {
      case "roll":
        if (cpu && this.#elapsed(dt)) this.#roll();
        break;
      case "rolling":
        if (this.#elapsed(dt)) {
          this.stepsLeft = this.die;
          this.#next();
        }
        break;
      case "junction":
        if (cpu && this.#elapsed(dt)) this.#branch(decide(JUNCTION_NODES, this.#view(), this.rng));
        break;
      case "walk":
        this.#walk(dt);
        break;
      case "star":
        if (cpu && this.#elapsed(dt)) this.#buy(decide(STAR_NODES, this.#view(), this.rng));
        break;
      case "award":
        if (this.#elapsed(dt)) {
          this.current.stars += 1;
          this.star.advance();
          this.#emit("star", this.current.stars);
          this.#next();
        }
        break;
      case "settle":
        if (this.#elapsed(dt)) this.#rotate();
        break;
      case "intro":
        if (this.#elapsed(dt)) this.phase = "minigame";
        break;
      case "minigame":
        this.#play(dt, input);
        break;
      case "result":
        if (this.#elapsed(dt)) this.#endTurn();
        break;
      case "over":
        break;
    }
  }

  #answer(yes: boolean): void {
    if (!this.current.human) return;
    if (this.phase === "roll" && yes) this.#roll();
    else if (this.phase === "junction") this.#branch(yes);
    else if (this.phase === "star") this.#buy(yes);
  }

  #view(): { coins: number; starOnBranch: boolean } {
    return {
      coins: this.current.coins,
      starOnBranch: (CHAINS[JUNCTION.branch.chain]?.ids ?? []).includes(this.star.space),
    };
  }

  #roll(): void {
    const player = this.current;
    const value =
      this.forcedRoll > 0
        ? this.forcedRoll
        : this.fastRolls
          ? 1
          : this.rng.die(DIE_SIDES, player.lastRoll);
    this.forcedRoll = 0;
    player.lastRoll = value;
    this.die = value;
    this.phase = "rolling";
    this.#start(ROLL_TIME);
    this.#emit("roll", value);
  }

  /** The next beat of a move: land when no steps remain, ask at the junction, else walk. */
  #next(): void {
    const player = this.current;
    if (this.stepsLeft === 0) {
      this.#land(player);
      return;
    }
    const atJunction = player.cur.chain === 0 && spaceAt(player.cur) === JUNCTION.space;
    if (atJunction && this.#askedAt !== JUNCTION.space) {
      this.#askedAt = JUNCTION.space;
      this.phase = "junction";
      this.prompt = "junction";
      this.#start(THINK_TIME);
      return;
    }
    this.phase = "walk";
  }

  /** A yes rewrites only the lookahead: the branch head. The current space stays. */
  #branch(yes: boolean): void {
    const player = this.current;
    if (yes) player.next = { ...JUNCTION.branch };
    this.#emit("branch", yes ? 1 : 0);
    this.prompt = "";
    this.phase = "walk";
  }

  /**
   * Step toward the next space at a fixed travel per update. Under one step from the target the pawn
   * snaps onto it, so it never idles between two spaces or drifts off the graph.
   * mario-party-1 `board-walk-and-turn` (src/overlays/ovl_3D_EternalStar/254480.c:892).
   */
  #walk(dt: number): void {
    const player = this.current;
    const target = this.spaces[spaceAt(player.next)] as ISpace;
    const dx = target.x - player.x;
    const dz = target.z - player.z;
    const distance = Math.hypot(dx, dz);
    const travel = WALK_SPEED * dt;
    player.walking = true;
    player.yaw = Math.atan2(dx, dz);
    if (distance > travel) {
      player.x += (dx / distance) * travel;
      player.z += (dz / distance) * travel;
      return;
    }
    player.x = target.x;
    player.z = target.z;
    player.walking = false;
    player.cur = player.next;
    player.next = lookahead(player.cur);
    this.stepsLeft -= 1;
    this.#askedAt = -1;
    this.#emit("step", spaceAt(player.cur));
    if (target.type === "star") this.#visit(player);
    else this.#next();
  }

  /**
   * The star visit, on a pass or a landing. The gate runs before any prompt: a pawn at the cap is
   * refused, a pawn under the price gets the shortfall, and only the rest see the question.
   * mario-party-1 `star-purchase` (src/overlays/ovl_5E_StarVisitEternalStar/298AE0.c:387-395).
   */
  #visit(player: IPlayer): void {
    if (player.stars >= STAR_CAP) this.#say("You hold the most stars allowed");
    else if (player.coins < STAR_PRICE) this.#say(`Need ${STAR_PRICE} coins for a star`);
    else {
      this.phase = "star";
      this.prompt = "star";
      this.#start(THINK_TIME);
      return;
    }
    this.#next();
  }

  /**
   * A yes debits the price at once and starts the award. The star count rises when the award ends,
   * not here, so a declined sale never grants a star. mario-party-1 `star-purchase` (298AE0.c:424).
   */
  #buy(yes: boolean): void {
    const player = this.current;
    this.prompt = "";
    if (!yes) {
      this.#next();
      return;
    }
    player.coins -= STAR_PRICE;
    this.phase = "award";
    this.#start(AWARD_TIME);
    this.#emit("buy", player.coins);
  }

  /** Blue pays three, red takes three and the ledger clamps at zero. Other spaces do nothing. */
  #land(player: IPlayer): void {
    const type = this.spaceOf(player).type;
    const step = type === "blue" ? COIN_STEP : type === "red" ? -COIN_STEP : 0;
    this.phase = "settle";
    this.#start(step === 0 ? SETTLE_TIME / 2 : SETTLE_TIME);
    if (step === 0) return;
    player.coins = Math.max(0, player.coins + step);
    this.#say(step > 0 ? `+${COIN_STEP} coins` : `-${COIN_STEP} coins`);
    this.#emit("coins", player.coins);
  }

  /**
   * Hand the turn on, wrapping at the roster size, and re-seat every pawn from its cursor. Re-seating
   * all four repairs a pawn an event displaced. mario-party-1 `turn-rotation-reseat` (257020.c:276).
   */
  #rotate(): void {
    this.active = (this.active + 1) % ROSTER;
    for (const player of this.players) this.seat(player, player.cur);
    if (this.active === 0) this.#startMinigame();
    else this.#begin();
  }

  #begin(): void {
    this.phase = "roll";
    this.#start(THINK_TIME);
    this.#emit("turn", this.active);
  }

  #startMinigame(): void {
    const id = this.forcedMinigame ?? (this.turn % 2 === 1 ? "dash" : "rope");
    this.forcedMinigame = undefined;
    this.minigame = id === "dash" ? new Dash(this.rng) : new Rope(this.rng, this.perfectCpu);
    this.perfectCpu = false;
    this.phase = "intro";
    this.#start(INTRO_TIME);
    this.#emit(id, 0);
  }

  #play(dt: number, input: IMiniInput): void {
    const game = this.minigame;
    if (game === undefined) return;
    game.update(dt, input);
    if (!game.done) return;
    const winner = this.players[game.winner] as IPlayer;
    winner.coins += MINIGAME_PRIZE;
    this.#say(`${winner.name} won ${game.title}: +${MINIGAME_PRIZE} coins`);
    this.#emit("minigame-won", game.winner);
    this.phase = "result";
    this.#start(RESULT_TIME);
  }

  #endTurn(): void {
    this.minigame = undefined;
    this.turn += 1;
    if (this.turn > TURN_LIMIT) {
      this.turn = TURN_LIMIT;
      this.ranking = [...this.players]
        .sort((a, b) => b.stars - a.stars || b.coins - a.coins || a.seat - b.seat)
        .map((player) => player.seat);
      this.phase = "over";
      this.#emit("over", this.ranking[0] as number);
      return;
    }
    this.#begin();
  }

  #say(text: string): void {
    this.message = text;
    this.#messageTimer = MESSAGE_TIME;
  }

  #emit(name: string, value: number): void {
    this.events.push({ name, seat: this.active, value });
  }

  #start(seconds: number): void {
    this.#timer = seconds;
    this.#length = Math.max(seconds, 1e-6);
  }

  /** Count the beat's timer down; true once it has run out. A CPU's thinking pause uses it too. */
  #elapsed(dt: number): boolean {
    this.#timer -= dt;
    return this.#timer <= 0;
  }
}
