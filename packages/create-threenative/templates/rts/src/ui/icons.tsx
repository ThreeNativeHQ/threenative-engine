/**
 * Line icons for every unit, structure, order and resource, on a 64×64 grid, drawn in
 * `currentColor` so a panel's CSS colours them. Inline SVG, so they cost no asset and render the
 * same in the native web view.
 */
const ICON_PATHS: Record<string, string> = {
  fighter:
    "M32 5 40 27 58 41 58 48 39 43 38 55 32 51 26 55 25 43 6 48 6 41 24 27Z M32 16V41 M14 41 26 37 M50 41 38 37",
  bomber:
    "M32 8 42 27 59 48 46 49 36 43 32 54 28 43 18 49 5 48 22 27Z M26 27 32 19 38 27 M17 38V48 M47 38V48",
  flak: "M10 51V40H54V51Z M17 40V31H47V40 M19 31 29 8 35 11 25 34 M32 31 42 8 48 11 38 34 M17 46H20 M27 46H30 M37 46H40 M47 46H50",
  medic:
    "M10 48V28L22 19H43L54 28V48Z M23 29H29V23H35V29H41V35H35V41H29V35H23Z M17 48V54 M47 48V54",
  starport:
    "M5 42 14 17 32 7 50 17 59 42 45 55H19Z M17 23V42 M17 32H37 M37 23V42 M46 21V43 M43 24H50 M43 29H50 M43 34H50",
  bunker:
    "M8 45V29L17 14H47L56 29V45L46 52H18Z M8 30H56 M18 22H46 M17 37H25 M39 37H47 M27 52V41H37V52",
  antiair:
    "M10 54 22 44H42L54 54Z M27 44V31H37V44 M17 31V18H47V31Z M22 18V7 M42 18V7 M28 24H36 M8 12H13 M51 12H56",
  garrison: "M6 20H28V43H6 M19 32H47 M36 22 47 32 36 42 M51 13H59V51H51",
  core: "M12 22 32 10 52 22 52 43 32 55 12 43Z M12 22 32 34 52 22 M32 34V55 M23 28V17 M41 28V17 M23 42 32 47 41 42",
  barracks:
    "M10 52V26L32 12 54 26V52H10 M18 52V32H46V52 M25 52V34 M39 52V34 M17 25H47 M27 18V24 M37 18V24",
  factory:
    "M10 53V23L22 17V29L36 20V29L50 23V53H10 M18 53V40H32V53 M41 36H46 M41 43H46 M17 23V11H23V19",
  relay:
    "M14 52V32H50V52H14 M24 32V22H40V32 M32 22V8 M22 13 32 7 42 13 M22 22 32 17 42 22 M22 40V45 M32 40V45 M42 40V45",
  refinery:
    "M17 47V25C17 15 47 15 47 25V47 M17 25C17 35 47 35 47 25 M17 46C17 57 47 57 47 46 M25 16V10H39V16 M11 34V48 M53 34V48 M28 37V44 M36 37V44",
  turret: "M16 54 23 43H41L48 54H16 M27 43V31H37V43 M19 31V20H45V31H19 M23 20V8 M41 20V8 M27 25H37",
  ranger:
    "M19 36 15 25 19 12 32 7 45 12 49 25 45 36 39 40 39 46 50 50 55 58H9L14 50 25 46 25 40Z M20 23H44L40 30H24Z M26 36H38 M32 11V18",
  worker:
    "M14 45V25L24 16H40L50 25V45H14 M23 16V10H41V16 M21 28H43V36H21Z M10 33H5V48H14 M50 33H59V48H50 M23 45V54 M41 45V54",
  tank: "M15 24H49V50H15Z M8 20H16V54H8Z M48 20H56V54H48Z M23 25 32 19 41 25V37H23Z M29 25V5H35V25 M23 43H41",
  hover: "M32 8 45 31 55 27 60 48 42 44 32 53 22 44 4 48 9 27 19 31Z M26 29 32 21 38 29 32 38Z",
  attack: "M9 55 26 38 M38 26 55 9 M36 10H55V29 M12 17 17 12 52 47 47 52Z",
  move: "M10 32H53 M36 15 53 32 36 49",
  hold: "M13 11H51V53H13Z M23 22V42 M41 22V42",
  stop: "M17 9H47L55 17V47L47 55H17L9 47V17Z M23 23 41 41 M41 23 23 41",
  build: "M12 54 36 30 M32 12 42 22 51 13C59 30 47 42 34 35L18 54Z",
  army: "M14 24 23 18 32 24 32 42 23 48 14 42Z M34 13 43 7 52 13 52 31 43 37 M9 33H4V50L14 56 23 50",
  ore: "M17 15 32 5 47 15 55 34 32 58 9 34Z M17 15 26 34 32 58 38 34 47 15 M9 34H55 M17 15H47",
  gas: "M32 7 49 22 49 43 32 56 15 43 15 22Z M32 7V56 M15 22 32 33 49 22",
  supply: "M11 44V23L32 11 53 23V44 M11 23 32 35 53 23 M32 35V55 M21 49 32 55 43 49",
  rally: "M17 56V9 M17 11H48L40 23 48 35H17",
};

export function Icon({
  name,
  className = "",
}: { readonly name: string; readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`icon ${className}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.6}
      viewBox="0 0 64 64"
    >
      <path d={ICON_PATHS[name] ?? ICON_PATHS.core} />
    </svg>
  );
}

/** The helmeted trooper the selection card shows for a Vanguard; other types show their icon. */
export function TrooperPortrait() {
  return (
    <svg aria-hidden="true" className="portrait-art" viewBox="0 0 140 150">
      <defs>
        <linearGradient id="helmet" x2="1" y2="1">
          <stop stopColor="#a5c0c7" />
          <stop offset=".4" stopColor="#607c88" />
          <stop offset="1" stopColor="#253e4c" />
        </linearGradient>
        <linearGradient id="chest" x2="1" y2="1">
          <stop stopColor="#415e6c" />
          <stop offset="1" stopColor="#182b38" />
        </linearGradient>
      </defs>
      <path
        d="M0 150 10 117 37 103 43 89H96L103 104 131 117 140 150"
        fill="url(#chest)"
        stroke="#839aa2"
      />
      <path d="M24 119 36 144H7L13 122 32 110M116 119 104 144H133L127 122 108 110" fill="#526d79" />
      <path d="M40 105 54 125H87L101 105 90 94H51" fill="#142c38" />
      <path
        d="M32 70 30 43 40 23 69 13 98 23 110 43 108 73 96 100 72 111 47 100Z"
        fill="url(#helmet)"
        stroke="#9bb7c0"
        strokeWidth={1.2}
      />
      <path d="M33 49 51 56H91L109 49 105 76 87 91H54L36 76Z" fill="#122a37" />
      <path d="M38 52 56 59H87L103 52 97 72 85 76H57L43 70Z" fill="#57e6e6" />
      <path d="M46 63H97L94 69H50Z" fill="#b5ffef" />
      <path d="M61 16H80L83 43H57Z" fill="#334d5b" />
      <path d="M59 22H82L83 28H58" fill="#78f2ea" />
      <path d="M47 91 59 83H84L95 93 84 105H59Z" fill="#304652" />
      <path d="M61 91H80M61 97H80" stroke="#81919a" strokeWidth={2} />
      <path
        d="M32 57 22 61V81L39 89 M108 57 118 61V81L101 89"
        fill="#435b68"
        stroke="#1f3745"
        strokeWidth={3}
      />
      <path d="M53 125H88L92 150H49Z" fill="#68828b" />
      <path d="M62 129H80V134H62" fill="#72eee3" />
      <path d="M26 35V12" stroke="#56717f" strokeWidth={4} />
      <circle cx="26" cy="10" fill="#a6f8ec" r="3" />
    </svg>
  );
}
