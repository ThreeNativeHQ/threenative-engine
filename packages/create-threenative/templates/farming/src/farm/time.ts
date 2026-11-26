// The calendar and the day clock, as plain numbers. No Three.js: the scene reads this, the HUD
// shows it, and `Farm.ts` advances it.
//
// Reference: harvest-moon-64 card `day-season-clock` (src/game/time.c).

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

/** Seven weekdays: time.c:128. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The day counter wraps to the next season at 31, so a season holds 30 days: time.c:132. */
export const DAYS_PER_SEASON = 30;
const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS.length;
/** The year stops at 99: time.c:145. */
const MAX_YEAR = 99;

/** The date turns at six in the morning, so every day starts there: time.c:118. */
export const WAKE_MINUTE = 6 * 60;
/**
 * Game-owned: a farmer still awake at 02:00 faints. The card only ends the day at the 06:00
 * rollover, which would leave twenty hours of work; two in the morning keeps the day short.
 */
export const FAINT_MINUTE = 26 * 60;
/**
 * The clock adds ten in-game seconds per update: time.c:107. The card does not verify the update
 * rate. At the console's 30 updates a second that is 300 in-game seconds, so five minutes pass
 * every real second and a 06:00 to 02:00 day lasts four real minutes.
 */
export const MINUTES_PER_SECOND = 5;

export interface IDate {
  readonly dayIndex: number;
  /** Day of the season, 1 to 30. */
  readonly day: number;
  readonly season: Season;
  readonly weekday: string;
  readonly year: number;
}

/** The date of a day counted from the first morning of spring in year 1. */
export function dateOf(dayIndex: number): IDate {
  return {
    day: (dayIndex % DAYS_PER_SEASON) + 1,
    dayIndex,
    season: SEASONS[Math.floor(dayIndex / DAYS_PER_SEASON) % SEASONS.length] ?? "spring",
    weekday: WEEKDAYS[dayIndex % WEEKDAYS.length] ?? "Mon",
    year: Math.min(MAX_YEAR, Math.floor(dayIndex / DAYS_PER_YEAR) + 1),
  };
}

export function dateLabel(date: IDate): string {
  const season = date.season.charAt(0).toUpperCase() + date.season.slice(1);
  return `${season} ${date.day}, ${date.weekday}`;
}

/** "06:00" from minutes since the day's midnight. A minute past 24:00 reads as the small hours. */
export function clockLabel(minute: number): string {
  const wrapped = Math.floor(minute) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
