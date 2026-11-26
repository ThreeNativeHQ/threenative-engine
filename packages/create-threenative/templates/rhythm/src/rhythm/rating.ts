/**
 * The rating meter, borrowed from parappa-the-rapper-2 `rank-ladder`. The original moves one notch
 * per judged line along a 17-entry ladder that folds into five display bands (src/main/scrctrl.c:2923),
 * and only the top two bands clear the stage. The bands decide how a line moves the rating:
 * the top band is tested against the threshold, the good band moves only on a clean line or a
 * collapse and otherwise drifts to its middle, the bad and awful bands move on whether the score
 * was positive at all (scrctrl.c:2946). This ladder keeps those rules at nine entries so a short
 * song can climb to the top and fall off the bottom.
 */
export type Level = "cool" | "good" | "bad" | "awful" | "end";

/** Index 0 is the best entry; the last index is the fall that ends the stage. */
export const LADDER_SIZE = 9;
export const START_RUNG = 3;
const GOOD_MIDDLE = 3;

/** Which display band an entry belongs to. */
export function levelOf(rung: number): Level {
  if (rung <= 1) return "cool";
  if (rung <= 4) return "good";
  if (rung <= 6) return "bad";
  if (rung === 7) return "awful";
  return "end";
}

/** The rung after one judged line. A lower index is a better rating. */
export function nextRung(rung: number, score: number, threshold: number): number {
  const clean = score >= threshold;
  const level = levelOf(rung);
  let next = rung;
  if (level === "cool") next = clean ? rung - 1 : rung + 1;
  else if (level === "good") {
    if (clean) next = rung - 1;
    else if (score <= 0) next = rung + 1;
    else next = rung + Math.sign(GOOD_MIDDLE - rung);
  } else if (level === "bad" || level === "awful") next = score > 0 ? rung - 1 : rung + 1;
  return Math.max(0, Math.min(LADDER_SIZE - 1, next));
}

/** Only the top two bands clear the stage; anything below sends the player back. */
export const clears = (rung: number): boolean =>
  levelOf(rung) === "cool" || levelOf(rung) === "good";
