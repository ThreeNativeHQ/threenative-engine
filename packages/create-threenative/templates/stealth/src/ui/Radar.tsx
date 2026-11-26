import { useUiState } from "@threenative/ui";
import { type Box, COMPOUND, CRATES, WALLS } from "../level.js";
import type { GameState, RadarContact } from "../state.js";

/** The radar shows this many metres from its centre to its edge. Keep it equal to RADAR_RANGE in Play.ts. */
const RANGE = 18;
const SIZE = 168;
const SCALE = SIZE / 2 / RANGE;

/** What the radar draws as structure: the perimeter, the inner walls and the tall crates. */
const STRUCTURE: readonly Box[] = [
  [0, -COMPOUND.halfDepth, COMPOUND.halfWidth * 2, 0, 0.4],
  [0, COMPOUND.halfDepth, COMPOUND.halfWidth * 2, 0, 0.4],
  [-COMPOUND.halfWidth, 0, 0.4, 0, COMPOUND.halfDepth * 2],
  [COMPOUND.halfWidth, 0, 0.4, 0, COMPOUND.halfDepth * 2],
  ...WALLS,
  ...CRATES.filter((crate) => crate[3] >= 1.5),
];

/** A view cone as an SVG wedge: centre (x, y) in radar pixels, facing `yaw`. */
function wedge(contact: RadarContact, x: number, y: number): string {
  const reach = contact.range * SCALE;
  // three.js yaw 0 faces +z, which is down on a north-up radar; x stays x.
  const a = contact.yaw - contact.halfAngle;
  const b = contact.yaw + contact.halfAngle;
  const ax = x + Math.sin(a) * reach;
  const ay = y + Math.cos(a) * reach;
  const bx = x + Math.sin(b) * reach;
  const by = y + Math.cos(b) * reach;
  return `M${x},${y} L${ax},${ay} A${reach},${reach} 0 0 0 ${bx},${by} Z`;
}

/**
 * The radar in the corner: north up, the player at the centre, a dot per guard and camera, and
 * each one's view cone. During Alert and Evasion the radar is jammed and shows static instead —
 * the cost of being seen is losing the one tool that let you avoid it.
 */
export function Radar() {
  const radar = useUiState<GameState, readonly RadarContact[]>((state) => state.radar);
  const jammed = useUiState<GameState, boolean>((state) => state.radarJammed === 1);
  const noise = useUiState<GameState, number>((state) => state.noise) ?? 0;
  // The static scrolls at ten steps a second: select the step, not the clock.
  const tick = useUiState<GameState, number>((state) => Math.floor(state.missionTime * 10)) ?? 0;
  const playerX = useUiState<GameState, number>((state) => state.playerX) ?? 0;
  const playerZ = useUiState<GameState, number>((state) => state.playerZ) ?? 0;
  const playerYaw = useUiState<GameState, number>((state) => state.playerYaw) ?? 0;
  if (radar === undefined) return null;
  const centre = SIZE / 2;
  return (
    <section
      id="radar"
      className="pointer-events-none absolute right-6 top-5 rounded border border-line bg-black/70 p-2"
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-label="radar">
        <rect width={SIZE} height={SIZE} fill="#0f1a14" />
        {jammed ? (
          <>
            {Array.from({ length: 14 }, (_, row) => (
              <rect
                key={row}
                x={0}
                y={row * 12 + ((tick * 7) % 12)}
                width={SIZE}
                height={3}
                fill="#3a5a46"
                opacity={0.5}
              />
            ))}
            <text x={centre} y={centre} fill="#d0532a" fontSize={12} textAnchor="middle">
              JAMMING
            </text>
          </>
        ) : (
          <>
            {STRUCTURE.map(([x, z, width, , depth], index) => (
              <rect
                key={index}
                x={centre + (x - width / 2 - playerX) * SCALE}
                y={centre + (z - depth / 2 - playerZ) * SCALE}
                width={Math.max(1.5, width * SCALE)}
                height={Math.max(1.5, depth * SCALE)}
                fill="#4f7a5e"
              />
            ))}
            <circle cx={centre} cy={centre} r={centre - 2} fill="none" stroke="#2c4a36" />
            <circle cx={centre} cy={centre} r={(centre - 2) / 2} fill="none" stroke="#2c4a36" />
            {radar.map((contact, index) => {
              const x = centre + contact.x * SCALE;
              const y = centre + contact.z * SCALE;
              const alert = contact.state === "alert";
              return (
                <g key={`${contact.kind}-${index}`}>
                  {contact.range > 0 && (
                    <path
                      d={wedge(contact, x, y)}
                      fill={alert ? "#d0532a" : "#e8b86a"}
                      opacity={0.28}
                    />
                  )}
                  <circle
                    cx={x}
                    cy={y}
                    r={contact.kind === "camera" ? 2.5 : 3.5}
                    fill={contact.state === "down" ? "#6d6e71" : alert ? "#d0532a" : "#e6e4e1"}
                  />
                </g>
              );
            })}
            <path
              d={`M0,-6 L4,4 L-4,4 Z`}
              transform={`translate(${centre} ${centre}) rotate(${180 - (playerYaw * 180) / Math.PI})`}
              fill="#2a6cf0"
            />
            {noise > 0 && (
              <circle
                cx={centre}
                cy={centre}
                r={noise * SCALE}
                fill="none"
                stroke="#2a6cf0"
                opacity={0.6}
              />
            )}
          </>
        )}
      </svg>
    </section>
  );
}
