// Stroke icons drawn at 24 px; colour follows the text around them.
const PATHS = {
  blizzard: "M3 8h13a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 17h6",
  camera: "M3 8h4l2-3h6l2 3h4v12H3V8zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  drop: "M12 3v12M7 10l5 5 5-5M5 20h14",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1.4 1-2 1-2 3M12 17h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  muted: "M11 5L6 9H3v6h3l5 4V5zM16 9l5 6m0-6l-5 6",
  pause: "M8 5v14M16 5v14",
  play: "M8 5l11 7-11 7V5z",
  push: "M4 12h12M12 7l5 5-5 5M20 5v14",
  reset: "M3 10a9 9 0 1 1 2 8M3 4v6h6",
  snow: "M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9 5l3 3 3-3m-6 14l3-3 3 3",
  sound: "M11 5L6 9H3v6h3l5 4V5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
  close: "M6 6l12 12M18 6L6 18",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className = "h-[17px] w-[17px]",
}: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.6}
      viewBox="0 0 24 24"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The snowflake mark beside the title. */
export function Mark() {
  return (
    <svg
      aria-hidden="true"
      className="h-[25px] w-[25px]"
      fill="none"
      stroke="#f0f7f8"
      strokeWidth={1.25}
      viewBox="0 0 32 32"
    >
      <path d="M16 3v26M4.7 9.5l22.6 13M4.7 22.5l22.6-13M12 6l4 4 4-4M12 26l4-4 4 4M6 14l5-1-1-5M26 18l-5 1 1 5M6 18l5 1-1 5M26 14l-5-1 1-5" />
    </svg>
  );
}
