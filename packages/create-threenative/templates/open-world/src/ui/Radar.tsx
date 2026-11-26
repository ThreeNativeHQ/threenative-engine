import { useUiState } from "@threenative/ui";
import type { Blip, BlipKind, GameState } from "../state.js";

/** Metres from the player to the radar's rim. */
const RANGE = 70;
const COLOURS: Readonly<Record<BlipKind, string>> = {
  cop: "#6f9bff",
  dropoff: "#f5cf52",
  hospital: "#ff6b6b",
  mission: "#f5cf52",
  money: "#7ee08a",
  phone: "#f5cf52",
  police: "#6f9bff",
  respray: "#ff9f43",
};

/**
 * The radar turns with the camera, so the camera's forward is up. A north-up radar is hard to
 * read behind the wheel. A blip past the range sits on the rim and points the way.
 */
export function Radar() {
  const blips = useUiState<GameState, Blip[]>((state) => state.blips);
  const cameraYaw = useUiState<GameState, number>((state) => state.cameraYaw) ?? 0;
  const playerX = useUiState<GameState, number>((state) => state.playerX) ?? 0;
  const playerZ = useUiState<GameState, number>((state) => state.playerZ) ?? 0;
  const roads = useUiState<GameState, number[]>((state) => state.roads);
  const roadHalf = useUiState<GameState, number>((state) => state.roadHalf) ?? 0;
  const roadWidth = useUiState<GameState, number>((state) => state.roadWidth) ?? 0;
  if (blips === undefined) return null;
  // The street grid in world metres, turned with the camera exactly as the blips are below.
  const grid = `rotate(${(cameraYaw * 180) / Math.PI}) scale(${46 / RANGE}) translate(${-playerX} ${-playerZ})`;
  const cos = Math.cos(cameraYaw);
  const sin = Math.sin(cameraYaw);
  const place = (blip: Blip) => {
    const dx = blip.x - playerX;
    const dz = blip.z - playerZ;
    // Camera right is (cos, -sin) in x/z and forward is (-sin, -cos): project onto both.
    let x = dx * cos - dz * sin;
    let y = dx * sin + dz * cos;
    const distance = Math.hypot(x, y);
    const rim = distance > RANGE;
    if (rim) {
      x = (x / distance) * RANGE;
      y = (y / distance) * RANGE;
    }
    return { rim, x: (x / RANGE) * 46, y: (y / RANGE) * 46 };
  };
  return (
    <div className="pointer-events-none absolute bottom-6 left-6 h-[170px] w-[170px] rounded-full bg-black/60 ring-2 ring-white/30">
      <svg viewBox="-50 -50 100 100" className="h-full w-full" role="img" aria-label="radar">
        <title>Radar</title>
        <defs>
          <clipPath id="radar-disc">
            <circle cx="0" cy="0" r="48" />
          </clipPath>
        </defs>
        <g clipPath="url(#radar-disc)">
          <g transform={grid} stroke="#ffffff" strokeOpacity={0.22} strokeWidth={roadWidth}>
            {(roads ?? []).map((road) => (
              <g key={road}>
                <line x1={road} y1={-roadHalf} x2={road} y2={roadHalf} />
                <line x1={-roadHalf} y1={road} x2={roadHalf} y2={road} />
              </g>
            ))}
          </g>
        </g>
        <circle cx="0" cy="0" r="23" fill="none" stroke="#ffffff" strokeOpacity={0.12} />
        {blips.map((blip) => {
          const { rim, x, y } = place(blip);
          const half = rim ? 2 : 2.6;
          return (
            <rect
              key={blip.id}
              x={x - half}
              y={y - half}
              width={half * 2}
              height={half * 2}
              rx={blip.kind === "cop" || blip.kind === "money" ? half : 0.6}
              fill={COLOURS[blip.kind]}
              stroke="#000000"
              strokeWidth={0.8}
            />
          );
        })}
        <path
          d="M 0 -4.5 L 3.2 3.5 L 0 1.8 L -3.2 3.5 Z"
          fill="#ffffff"
          stroke="#000000"
          strokeWidth={0.6}
        />
      </svg>
    </div>
  );
}
