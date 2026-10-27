import { useUiIntent, useUiState } from "@threenative/ui";
import { townSchematic } from "../render/town-schematic.js";
import { type GameState, TARGET_GOAL } from "../state.js";
import { Crosshair, type ICrosshairPrimitiveProps } from "./Crosshair.js";
import { Minimap } from "./Minimap.js";
import { TouchOverlay } from "./TouchOverlay.js";

const KEYS: readonly (readonly [string, string])[] = [
  ["WASD", "Move"],
  ["Mouse 1", "Fire"],
  ["R", "Reload"],
  ["Enter", "Retry"],
];

function Legend() {
  return (
    <div className="desktop-only pointer-events-none flex items-center gap-3 bg-black/45 px-4 py-2 text-[13px] font-semibold tracking-wide">
      {KEYS.map(([key, label], index) => (
        <span className="flex items-center gap-2" key={key}>
          {index > 0 ? <i className="mr-1 not-italic text-white/25">|</i> : null}
          <b className="font-bold text-[#ffa63d]">{key}</b>
          <span className="font-normal text-white/85">{label}</span>
        </span>
      ))}
    </div>
  );
}

function ShieldGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 2l8 3v6c0 5.2-3.4 9.6-8 11-4.6-1.4-8-5.8-8-11V5l8-3z" />
    </svg>
  );
}

/** Bust silhouette used for every roster chip; the chip tint carries the team. */
function SoldierBust() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full" aria-hidden="true">
      <path
        d="M16 5c-3.6 0-6 2.7-6 6.2 0 2.4 1 4.5 2.6 5.6C9 18 6.4 20.4 6 24h20c-.4-3.6-3-6-6.6-7.2 1.6-1.1 2.6-3.2 2.6-5.6C22 7.7 19.6 5 16 5z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * One roster slot: dark plate, team-tinted bust, thin accent rail on top.
 *
 * `down` is the reference's dead-player treatment — the chip desaturates and
 * the bust fades rather than disappearing, so the roster keeps its shape and
 * the row still reads as five slots.
 */
function PortraitChip({ tone, down }: { tone: "ct" | "t"; down?: boolean }) {
  const ct = tone === "ct";
  return (
    <span
      className={`relative block h-[38px] w-[30px] overflow-hidden rounded-[3px] border transition-[opacity,filter] duration-300 ${
        ct ? "border-[#7fb3e8]/70" : "border-[#e8c66f]/70"
      } bg-gradient-to-b ${ct ? "from-[#274a68] to-[#12202e]" : "from-[#6b5524] to-[#241b0c]"} ${
        down === true ? "opacity-40 grayscale" : ""
      }`}
    >
      <i className={`absolute inset-x-0 top-0 h-[2px] ${ct ? "bg-[#7fb3e8]" : "bg-[#e8c66f]"}`} />
      <span
        className={`block p-[3px] ${ct ? "text-[#a9d2f5]" : "text-[#f0d491]"} ${
          down === true ? "opacity-45" : ""
        }`}
      >
        <SoldierBust />
      </span>
      {down === true ? (
        <i className="absolute inset-x-[5px] top-1/2 h-[2px] -translate-y-1/2 rotate-[-24deg] bg-[#ff5f4d]/80" />
      ) : null}
    </span>
  );
}

/** The header roster is five a side, per the design sheet's "5 vs 5". */
const ROSTER = [0, 1, 2, 3, 4] as const;

function WebCrosshairPrimitive({ children, hidden, hitFlash, part }: ICrosshairPrimitiveProps) {
  if (part === "vertical") {
    return <i className="absolute left-1/2 top-0 h-full w-[1.5px] -translate-x-1/2 bg-white/90" />;
  }
  if (part === "horizontal") {
    return <i className="absolute left-0 top-1/2 h-[1.5px] w-full -translate-y-1/2 bg-white/90" />;
  }
  return (
    <div
      className="absolute left-1/2 top-1/2 h-[13px] w-[13px] -translate-x-1/2 -translate-y-1/2"
      style={{
        opacity: hidden ? 0 : 1,
        transform: `translate(-50%, -50%) scale(${(1 + hitFlash * 0.7).toFixed(3)})`,
      }}
    >
      {children}
    </div>
  );
}

/** Gold roundel with a winged star, centred on the bottom HUD row. */
function RankEmblem() {
  return (
    <svg viewBox="0 0 48 48" className="h-[42px] w-[42px]" aria-hidden="true">
      <circle cx="24" cy="24" r="21" fill="#101418" stroke="#d8b25c" strokeWidth="2.4" />
      <path
        d="M4 24c5-4 9-5 14-4l-3 4c-4-.6-8-.4-11 0zM44 24c-5-4-9-5-14-4l3 4c4-.6 8-.4 11 0z"
        fill="#d8b25c"
      />
      <path
        d="M24 12l2.7 6.1 6.6.6-5 4.4 1.5 6.5L24 26l-5.8 3.6 1.5-6.5-5-4.4 6.6-.6L24 12z"
        fill="#f0cd7a"
      />
    </svg>
  );
}

function BulletsGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="mb-[3px] h-[15px] w-[15px]" aria-hidden="true">
      <rect x={1} y={6} width={3} height={9} rx={1} fill="#ffa63d" />
      <rect x={6.5} y={3} width={3} height={12} rx={1} fill="#ffa63d" />
      <rect x={12} y={1} width={3} height={14} rx={1} fill="#ffa63d" />
    </svg>
  );
}

/**
 * Go full screen and lock to landscape, on the one tap a phone player is guaranteed to make.
 *
 * Two things this fixes, both measured on a Pixel 8 in Chrome. Portrait gives the game a 411x784
 * surface for a scene composed at 1280x720, so the horizontal field of view a shooter needs is
 * simply not there. And even rotated, Chrome's URL bar and gesture bar leave 303 px of height out
 * of 1080 — nearly three quarters of the screen spent on browser furniture.
 *
 * Both APIs are DOM-only and both are gated behind a user gesture, which is why this is a button
 * and not something the scene does at boot. `src/ui/` is the web-only half of this game by
 * contract — the native target never builds it, and the native target has neither problem, because
 * `threenative.config.ts` already declares `orientation: "landscape"` and `fullscreen: true`.
 *
 * Failure is silent and non-fatal on purpose: iOS Safari has no `requestFullscreen` on elements
 * and no orientation lock at all, and a player there should get the game, not an error.
 */
async function goImmersive(): Promise<void> {
  try {
    if (document.fullscreenElement === null) {
      await document.documentElement.requestFullscreen({
        navigationUI: "hide",
      });
    }
  } catch {
    // Refused (iOS, or no gesture credit left). The orientation attempt below may still work.
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (to: string) => Promise<void>;
    };
    await orientation.lock?.("landscape");
  } catch {
    // No orientation lock on this platform. The player rotates the phone themselves.
  }
}

/**
 * A HUD control a thumb can actually press.
 *
 * Everything else under `.touch-only` is `pointer-events-none`, because the gameplay controls are
 * read from `ctx.input.raw.pointers` inside the scene and a div that swallowed touches would make
 * the game stop responding exactly where its controls are drawn. These two are the exception: they
 * are React actions, not gameplay input, so they take their own events and sit clear of the
 * thumb bands the scene reads.
 */
function TouchAction({
  onPress,
  children,
  className = "",
}: {
  onPress: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      // The host decides on pointer-down whether a press belongs to the UI or falls through to
      // the game, and it decides from the rectangles the page publishes for elements marked
      // this way. Without it the button is drawn, is styled `pointer-events-auto`, and still
      // never receives the press on native: the platform hands the gesture to the game before
      // any CSS runs. `pointer-events-auto` is a web-only half of the story.
      data-tn-interactive
      // `onPointerDown`, not `onClick`: a click needs a press and a release inside the same
      // element and waits out the gesture, which on a phone is a control that feels broken.
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
      className={`pointer-events-auto touch-none select-none ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The round minimap, and the only HUD part that moves every tick.
 *
 * `blips`, the player position and the yaw are published on every frame so the map can follow
 * them. Reading the whole state with `useUiState<GameState>()` re-rendered every line of this
 * file at that cadence; each part below subscribes to its own fields, so a frame publish renders
 * this component and leaves the roster, clock and wallet alone.
 */
function MinimapPanel() {
  const playerX = useUiState<GameState, number>((state) => state.playerX);
  const playerZ = useUiState<GameState, number>((state) => state.playerZ);
  const playerYaw = useUiState<GameState, number>((state) => state.playerYaw);
  const blips = useUiState<GameState, GameState["blips"]>((state) => state.blips);
  if (
    playerX === undefined ||
    playerZ === undefined ||
    playerYaw === undefined ||
    blips === undefined
  ) {
    return null;
  }
  return (
    <Minimap
      schematic={townSchematic}
      playerX={playerX}
      playerZ={playerZ}
      playerYaw={playerYaw}
      blips={blips}
    />
  );
}

/**
 * The header clock, to the whole second the header prints.
 *
 * `timeRemaining` changes every frame. Rounded inside the selector, the component re-renders once
 * a second, which is the only rate its text can change.
 */
function RoundClock() {
  const seconds = useUiState<GameState, number>((state) =>
    Math.max(0, Math.floor(state.timeRemaining)),
  );
  if (seconds === undefined) return null;
  const minutes = Math.floor(seconds / 60);
  const part = String(seconds % 60).padStart(2, "0");
  return (
    <div className="min-w-[86px] rounded-[3px] border border-white/15 bg-black/60 px-3 py-0.5 text-center">
      <div className="text-[26px] font-bold leading-tight tabular-nums text-white">
        {minutes}
        <span className="text-[#ffa63d]">:</span>
        {part}
      </div>
    </div>
  );
}

/**
 * Team rosters flanking the round clock, score beneath — five defenders in blue against five
 * attackers in gold, like the reference's 5-vs-5 header.
 *
 * The roster only changes when a soldier falls, so the selector reads the dead set as a bit mask
 * rather than the blips array the minimap needs every frame.
 */
function TopCentre() {
  const downMask = useUiState<GameState, number>((state) =>
    state.blips.reduce((mask, blip, index) => (blip.alive ? mask : mask | (1 << index)), 0),
  );
  const playerDown = useUiState<GameState, boolean>((state) => state.health <= 0);
  const playing = useUiState<GameState, boolean>((state) => state.phase === "playing");
  const targetsHit = useUiState<GameState, number>((state) => state.targetsHit);
  const down = downMask ?? 0;
  let soldiersDown = 0;
  for (const index of ROSTER) {
    if ((down & (1 << index)) !== 0) soldiersDown += 1;
  }
  const soldiersStanding = Math.max(0, ROSTER.length - soldiersDown);
  return (
    <div className="hud-top absolute left-1/2 top-2 flex -translate-x-1/2 flex-col items-center drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
      <div className="flex items-start gap-2">
        <div className="flex items-center gap-[3px] pt-1">
          {ROSTER.map((index) => (
            <PortraitChip
              key={`ct-${index}`}
              tone="ct"
              // Slot 0 is the player; the rest of the side is unfilled, and
              // showing it greyed is honest about a roster nobody occupies.
              down={index === 0 ? playerDown === true : true}
            />
          ))}
        </div>
        <RoundClock />
        <div className="flex items-center gap-[3px] pt-1">
          {ROSTER.map((index) => (
            <PortraitChip
              key={`t-${index}`}
              tone="t"
              // A blip that has not been reported yet counts as standing, so
              // the row reads full during the asset-loading window.
              down={(down & (1 << index)) !== 0}
            />
          ))}
        </div>
      </div>
      <div className="mt-0.5 text-[19px] font-bold leading-none tabular-nums tracking-[0.08em] text-white">
        {soldiersDown}
        <span className="mx-1.5 text-white/45">:</span>
        {soldiersStanding}
      </div>
      <div className="mt-[3px] text-[12px] font-semibold leading-none tracking-[0.04em] text-white/60">
        {ROSTER.length} vs {ROSTER.length}
      </div>
      {playing === true ? (
        <div className="mt-1 text-[13px] font-bold tracking-[0.05em] text-white/85">
          CLEAR THE TOWN · HIT {Math.max(0, TARGET_GOAL - (targetsHit ?? 0))} TARGETS
        </div>
      ) : null}
    </div>
  );
}

/** Armour badge, health readout, rank emblem and ammo on one shared baseline. */
function BottomCentre() {
  const health = useUiState<GameState, number>((state) => state.health) ?? 0;
  const ammo = useUiState<GameState, number>((state) => state.ammo) ?? 0;
  const reserve = useUiState<GameState, number>((state) => state.reserve) ?? 0;
  const lowHealth = health < 35;
  return (
    <div className="hud-bottom absolute bottom-4 left-1/2 flex -translate-x-1/2 items-end gap-9">
      <div className="flex items-end gap-3">
        <span className="relative inline-block h-[34px] w-[30px]">
          <ShieldGlyph className="h-full w-full fill-[#274a68] stroke-[#7fb3e8] stroke-[1.4]" />
          <span className="absolute inset-x-0 top-[11px] text-center text-[12px] font-bold leading-none tabular-nums text-white">
            100
          </span>
        </span>
        <span>
          <span
            className={`block text-[36px] font-bold leading-none tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] ${
              lowHealth ? "text-[#ff5f4d]" : "text-white"
            }`}
          >
            {Math.round(health)}
          </span>
          <i
            className={`mt-[3px] block h-[3px] w-[74px] ${lowHealth ? "bg-[#ff5f4d]" : "bg-[#e8c66f]"}`}
            style={{ transformOrigin: "left" }}
          >
            <i
              className={`block h-full ${lowHealth ? "bg-[#ff5f4d]" : "bg-[#ffd166]"}`}
              style={{ width: `${Math.min(100, Math.max(0, health))}%` }}
            />
          </i>
        </span>
      </div>
      <RankEmblem />
      <div className="flex items-baseline gap-2 tabular-nums drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
        <span className="text-[38px] font-bold leading-none text-white">{ammo}</span>
        <span className="text-[19px] font-semibold text-white/55">| {reserve}</span>
        <BulletsGlyph />
      </div>
    </div>
  );
}

/**
 * Crosshair, with a hit marker that blooms outward on a scoring hit.
 *
 * It is hidden while aiming down the sights. The weapon's own optic is the aim reference there,
 * and a second reticle floating beside the red dot reads as a misaligned sight.
 */
function Reticle() {
  const aiming = useUiState<GameState, boolean>((state) => state.aiming) ?? false;
  const hitFlash = useUiState<GameState, number>((state) => state.hitFlash) ?? 0;
  return (
    <>
      <Crosshair aiming={aiming} hitFlash={hitFlash} Primitive={WebCrosshairPrimitive} />
      {hitFlash > 0 ? (
        <div
          className="absolute left-1/2 top-1/2 h-[26px] w-[26px] -translate-x-1/2 -translate-y-1/2 rotate-45"
          style={{ opacity: Math.min(1, hitFlash * 1.6) }}
        >
          <i className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-[#ffd166]" />
          <i className="absolute left-0 top-1/2 h-[2px] w-full -translate-y-1/2 bg-[#ffd166]" />
        </div>
      ) : null}
    </>
  );
}

/**
 * Red only while a round is landing. It used to be driven by `health < 45`, which is a
 * low-health indicator wearing a damage vignette's clothes: a soldier at 40 with nobody
 * shooting him got a permanently red screen, and the 70 rounds it takes to walk from 100
 * to 30 produced no feedback at all. The health bar and the health number already say
 * "you are nearly dead".
 */
function DamageVignette() {
  const hurtFlash = useUiState<GameState, number>((state) => state.hurtFlash) ?? 0;
  if (hurtFlash <= 0) return null;
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(circle at 50% 55%, rgba(0,0,0,0) 42%, rgba(190,26,20,0.5) 100%)",
        opacity: Math.min(1, hurtFlash),
      }}
    />
  );
}

/** End-of-round card. An intent, not a state write: the game owns what "restart" means. */
function EndCard() {
  const phase = useUiState<GameState, GameState["phase"]>((state) => state.phase);
  const score = useUiState<GameState, number>((state) => state.score) ?? 0;
  const targetsHit = useUiState<GameState, number>((state) => state.targetsHit) ?? 0;
  const sendIntent = useUiIntent();
  if (phase === undefined || phase === "playing") return null;
  // The same two lines the keyboard's Enter path runs in `Play.update`. A phone has no Enter key,
  // and until this existed a mobile player who ran out of time had no way to start another round —
  // the end card told them to press a key their device does not have.
  const restart = () => sendIntent("restart");
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/45">
      <div
        className={`text-[42px] font-bold tracking-[0.08em] ${
          phase === "complete" ? "text-[#3ddc6b]" : "text-[#ff5f4d]"
        }`}
      >
        {phase === "complete" ? "TOWN CLEAR" : "RUN OVER"}
      </div>
      <div className="mt-2 text-[18px] font-bold tracking-[0.06em] text-white">
        SCORE {String(score).padStart(4, "0")} · {targetsHit} HITS
      </div>
      <div className="desktop-only mt-6 text-[15px] font-bold tracking-[0.14em] text-[#ffa63d]">
        PRESS ENTER TO RUN IT AGAIN
      </div>
      <div className="touch-show mt-6">
        <TouchAction
          onPress={restart}
          className="rounded-[4px] border-2 border-[#ffa63d] bg-[#ffa63d]/15 px-8 py-3 text-[16px] font-bold tracking-[0.16em] text-[#ffa63d] active:bg-[#ffa63d]/35"
        >
          RUN IT AGAIN
        </TouchAction>
      </div>
      {/* Poly Haven's licence requires a visible credit wherever its API was
          used to source assets, and "visible" means a player has to be able
          to see it — CREDITS.md alone does not discharge that. The sky,
          barrel, gutter, wall lamp and buoy all came from there. ambientCG
          (the plaster, brick, flagstone, concrete, quaystone and steel) is
          CC0 and asks for nothing; it is named here as courtesy, not duty. */}
      <div className="mt-10 text-center text-[11px] leading-relaxed tracking-[0.06em] text-white/40">
        Environment textures and props: Poly Haven (CC0) · ambientCG (CC0)
        <br />
        Audio: Kenney (CC0) · Sonniss
      </div>
    </div>
  );
}

export function Hud() {
  // Nothing to draw until the game has published a frame. The web view loads this page before the
  // game has run a tick, so an empty first paint is the normal path here, not a failure.
  const ready = useUiState<GameState, boolean>(() => true);
  if (ready !== true) return null;

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-sans">
      {/* Top left: the round minimap, north-up. It renders the plain map data
          the town builder emits — no scene objects cross into the HUD. */}
      <MinimapPanel />

      {/* Top centre: the 5-vs-5 header. */}
      <TopCentre />

      {/* Bottom centre: the armour, health, rank and ammo cluster. */}
      <BottomCentre />

      {/* Top right: one tap to full screen and landscape. Placed opposite the minimap and above
          the right thumb's look band, so it is reachable but never under a finger that is aiming. */}
      <div className="hud-immersive touch-show pointer-events-none absolute right-2 top-2">
        <TouchAction
          onPress={() => {
            void goImmersive();
          }}
          className="rounded-[4px] border border-white/25 bg-black/50 px-2.5 py-1.5 text-[11px] font-bold tracking-[0.12em] text-white/75"
        >
          FULL
        </TouchAction>
      </div>

      {/* Thumb controls. A root-level sibling on purpose: every child here is positioned against
          the full HUD surface, and nesting these inside the legend stack below put the fire button
          62 px from the right edge of a 62 px chip instead of the right edge of the screen. */}
      <TouchOverlay />

      {/* Bottom left: money chip over the key legend. */}
      <div className="hud-corner absolute bottom-3 left-3 flex flex-col items-start gap-2.5">
        <div className="pl-1 text-[16px] font-bold tabular-nums tracking-[0.03em] text-[#ffd166] drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          $10000
        </div>
        <Legend />
      </div>

      <Reticle />
      <DamageVignette />
      <EndCard />
    </div>
  );
}
