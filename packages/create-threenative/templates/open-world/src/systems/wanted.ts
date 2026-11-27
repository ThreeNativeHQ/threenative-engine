// The wanted level. Crimes add "chaos" points; the star count is a band of the chaos total.
//
// Borrowed from GTA III (re3 @ b050e1cc, `src/core/Wanted.cpp`): the per-crime chaos weights
// (`ReportCrimeNow`, lines 230-258), the star bands at 40 / 200 / 400 / 800 / 1600 chaos
// (`UpdateWantedLevel`, lines 291-326) and the police budget per star (`m_MaximumLawEnforcerVehicles`
// and `m_MaxCops`, same lines). GTA III itself only bleeds chaos away below two stars; the
// line-of-sight evasion below (stars flash while no officer can see you, then drop one) is the later
// series' rule, added because a starter kit needs a way out of a chase that is not a respray.

export type Crime =
  | "hit-ped"
  | "hit-cop"
  | "shoot-ped"
  | "shoot-cop"
  | "steal-car"
  | "run-over-ped"
  | "run-over-cop";

/** Chaos per crime, at full crime sensitivity (re3 `Wanted.cpp:230-258`). */
export const CRIME_CHAOS: Readonly<Record<Crime, number>> = {
  "hit-ped": 5,
  "hit-cop": 45,
  "shoot-ped": 30,
  "shoot-cop": 80,
  "steal-car": 15,
  "run-over-ped": 18,
  "run-over-cop": 80,
};

/** The chaos at which each star starts: index 1 is one star (re3 `Wanted.cpp:291-326`). */
export const STAR_CHAOS = [0, 40, 200, 400, 800, 1600] as const;
/** Five stars is this kit's ceiling; GTA III's sixth (the army) has no asset here. */
export const MAX_STARS = 5;
/** Police cars allowed in the pursuit per star (re3 `m_MaximumLawEnforcerVehicles`). */
export const POLICE_CARS = [0, 1, 2, 2, 2, 3] as const;

/** Seconds out of every officer's sight before the stars start flashing. */
export const EVADE_HIDDEN = 6;
/** Seconds of flashing, still unseen, before one star drops. */
export const EVADE_FLASH = 6;
/** One star with nobody near bleeds chaos at one point a second (re3 `Wanted.cpp:373-383`). */
const ONE_STAR_BLEED = 1;

export class Wanted {
  chaos = 0;
  /** Seconds since any officer last saw the player. */
  unseen = 0;
  /** How many times a star was shed by evasion; read by the playtests. */
  evasions = 0;
  crimes = 0;

  get stars(): number {
    let stars = 0;
    for (let level = 1; level <= MAX_STARS; level += 1)
      if (this.chaos >= (STAR_CHAOS[level] as number)) stars = level;
    return stars;
  }

  /** Stars flash while the player is hidden long enough that the search is losing them. */
  get flashing(): boolean {
    return this.stars > 0 && this.unseen >= EVADE_HIDDEN;
  }

  report(crime: Crime): number {
    const before = this.stars;
    this.chaos = Math.min(this.chaos + CRIME_CHAOS[crime], (STAR_CHAOS[MAX_STARS] as number) * 2);
    this.crimes += 1;
    // A fresh crime is a fresh sighting: a witness calls it in.
    this.unseen = 0;
    return this.stars - before;
  }

  /** `seen`: any officer has line of sight to the player this tick. */
  update(dt: number, seen: boolean): void {
    const stars = this.stars;
    if (stars === 0) {
      this.unseen = 0;
      return;
    }
    this.unseen = seen ? 0 : this.unseen + dt;
    if (stars === 1 && !seen) {
      this.chaos = Math.max(0, this.chaos - ONE_STAR_BLEED * dt);
      // The bleed cleared the last star: that is an escape too.
      if (this.stars === 0) {
        this.unseen = 0;
        this.evasions += 1;
        return;
      }
    }
    if (this.unseen >= EVADE_HIDDEN + EVADE_FLASH) {
      // Drop to the middle of the band below (not its floor, where the one-star bleed would clear
      // it in a second), then start the search again from that level.
      const lower = stars - 1;
      this.chaos =
        lower === 0 ? 0 : ((STAR_CHAOS[lower] as number) + (STAR_CHAOS[lower + 1] as number)) / 2;
      this.unseen = 0;
      this.evasions += 1;
    }
  }

  clear(): void {
    this.chaos = 0;
    this.unseen = 0;
  }
}
