// Playtest stations: each key sets up one mechanic in one tick, so a scenario proves a rule in seconds
// instead of waiting through a whole turn of dice. They answer only under a playtest runner (see
// `UNDER_PLAYTEST` in the scene), never in a real build. Delete them with the playtests.
import { type IPlayer, type Match, TURN_LIMIT } from "./match/turn.js";

function at(match: Match, seat: number): IPlayer {
  return match.players[seat] as IPlayer;
}

/** Hand the turn to a seat, ready to roll. */
function turnOf(match: Match, seat: number): void {
  match.active = seat;
  match.phase = "roll";
  match.prompt = "";
}

export const STATIONS: Readonly<Record<string, (match: Match) => void>> = {
  // On the start space, next roll 2: lands on a blue space.
  station1: (match) => {
    turnOf(match, 0);
    match.seat(at(match, 0), { chain: 0, slot: 0 });
    match.forcedRoll = 2;
  },
  // One before a red space with 1 coin, next roll 1: red takes three and the ledger clamps at zero.
  station2: (match) => {
    turnOf(match, 0);
    match.seat(at(match, 0), { chain: 0, slot: 5 });
    at(match, 0).coins = 1;
    match.forcedRoll = 1;
  },
  // Three before the junction, next roll 4: the walk reaches the junction with three steps left.
  station3: (match) => {
    turnOf(match, 0);
    match.seat(at(match, 0), { chain: 0, slot: 3 });
    match.forcedRoll = 4;
  },
  // One before the live star with 25 coins, next roll 1: the star is on offer.
  station4: (match) => {
    turnOf(match, 0);
    match.seatBefore(at(match, 0), match.star.space);
    at(match, 0).coins = 25;
    match.forcedRoll = 1;
  },
  // The same with 19 coins: one short of the price.
  station5: (match) => {
    turnOf(match, 0);
    match.seatBefore(at(match, 0), match.star.space);
    at(match, 0).coins = 19;
    match.forcedRoll = 1;
  },
  // CPU 1 one before the live star with 25 coins, next roll 1: the CPU decides alone.
  station6: (match) => {
    turnOf(match, 1);
    match.seatBefore(at(match, 1), match.star.space);
    at(match, 1).coins = 25;
    match.forcedRoll = 1;
  },
  // The dash minigame now.
  station7: (match) => match.skipToMinigame("dash"),
  // The rope minigame now, with flawless CPU hops, so the human is the only one who can lose.
  station8: (match) => {
    match.perfectCpu = true;
    match.skipToMinigame("rope");
  },
  // The last turn, with the human two stars ahead: the minigame ends the match and the human wins.
  station9: (match) => {
    match.turn = TURN_LIMIT;
    at(match, 0).stars = 2;
    match.skipToMinigame("dash");
  },
  // Every roll is 1, so a whole round of CPU turns takes seconds.
  station10: (match) => {
    match.fastRolls = true;
  },
};

export const STATION_NAMES = Object.keys(STATIONS);
