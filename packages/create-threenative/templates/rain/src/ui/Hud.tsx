import type { GameState } from "../state.js";

export interface IHudProps {
  /** The game's published state. The mirror, never the live store, so it works on every target. */
  readonly state: GameState;
  readonly send: (intent: string, payload?: unknown) => void;
  readonly say: (text: string) => void;
  /** Whether the weather panel is open on a narrow screen. Pure presentation, so it is local. */
  readonly panelOpen: boolean;
  readonly setPanelOpen: (open: boolean) => void;
  /** The toast line and whether it is showing. Held by `GameUi`, printed here in the sheet. */
  readonly toast: string;
  readonly toastVisible: boolean;
}

export interface ISceneSizes {
  readonly height: number;
  readonly width: number;
}

/** What a capture really produced: the encoded image's own size, or why there was none. */
export interface ICaptureResult extends ISceneSizes {
  readonly blob?: Blob;
  readonly bytes: number;
  readonly ok: boolean;
  readonly reason?: string;
}

/** The page's own scene canvas. Null where there is no canvas to read, which is the honest answer. */
export function sceneCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('[data-threenative-canvas="true"] canvas');
}

/**
 * Fullscreen, as the browser actually does it, reported as what the document says afterwards.
 *
 * There is no engine capability for this and no cross-platform promise to make here: this is the
 * document's own fullscreen element, so the failure is reported in the toast rather than swallowed
 * into a button that looks like it worked, and the returned answer is the element's own state.
 */
export async function toggleFullscreen(say: (text: string) => void): Promise<boolean> {
  try {
    if (document.fullscreenElement === null) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (why) {
    say(`Fullscreen is not available in this viewer: ${(why as Error).message}`);
    return false;
  }
  const on = document.fullscreenElement !== null;
  say(on ? "Fullscreen on" : "Fullscreen off");
  return on;
}

const PNG_MAGIC = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PROBE_PX = 32;

/**
 * Prove the frame is a real image rather than guessing at it.
 *
 * A byte floor is a guess: it rejected a valid 390x844 phone capture for being small and would
 * have accepted a large blank one. What a blank frame actually is, is a PNG that decodes to a
 * single flat colour — so the guard decodes the bytes and counts distinct colours. The magic bytes
 * are read too, because a renderer that hands the page a buffer which is not a PNG at all must be
 * named as that rather than as a dark picture.
 */
async function proveFrame(canvas: HTMLCanvasElement): Promise<ICaptureResult> {
  const empty = { bytes: 0, height: 0, ok: false, width: 0 } as const;
  const blob = await new Promise<Blob | null>((done) => {
    canvas.toBlob(done, "image/png");
  });
  if (blob === null || blob.size === 0) return { ...empty, reason: "the canvas encoded no image" };
  const magic = new Uint8Array(await blob.slice(0, PNG_MAGIC.length).arrayBuffer());
  if (magic.length !== PNG_MAGIC.length || !magic.every((byte, at) => byte === PNG_MAGIC.at(at))) {
    return { ...empty, reason: "the encoded bytes are not a PNG" };
  }
  const bitmap = await createImageBitmap(blob).catch(() => undefined);
  if (bitmap === undefined) return { ...empty, reason: "the PNG did not decode" };
  const probe = document.createElement("canvas");
  probe.width = PROBE_PX;
  probe.height = PROBE_PX;
  const sampled = probe.getContext("2d", { willReadFrequently: true });
  if (sampled === null) {
    bitmap.close();
    return { ...empty, reason: "no 2d context to sample the frame with" };
  }
  sampled.drawImage(bitmap, 0, 0, PROBE_PX, PROBE_PX);
  bitmap.close();
  const pixels = sampled.getImageData(0, 0, PROBE_PX, PROBE_PX).data;
  const colours = new Set<number>();
  for (let at = 0; at < pixels.length; at += 4) {
    colours.add(
      ((pixels.at(at) ?? 0) << 16) | ((pixels.at(at + 1) ?? 0) << 8) | (pixels.at(at + 2) ?? 0),
    );
  }
  if (colours.size < 2) {
    return { ...empty, reason: "the frame decoded to a single flat colour" };
  }
  return { blob, bytes: blob.size, height: canvas.height, ok: true, width: canvas.width };
}

/**
 * Save the frame, through the page's own canvas, and report what was really written.
 *
 * A WebGPU canvas can hand the page a blank read, so the image is proved before the download is
 * offered rather than after: the toast carries the encoded size and a failed read says why.
 */
export async function captureScene(say: (text: string) => void): Promise<ICaptureResult> {
  const canvas = sceneCanvas();
  const result =
    canvas === null
      ? ({ bytes: 0, height: 0, ok: false, reason: "no scene canvas", width: 0 } as const)
      : await proveFrame(canvas);
  if (!result.ok || result.blob === undefined) {
    say(`Scene image unavailable: ${result.reason ?? "unknown"}`);
    return result;
  }
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a");
  link.download = `rain-${Date.now()}.png`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);
  say(`Scene image saved · ${result.width}x${result.height} · ${result.bytes} bytes`);
  return result;
}

/**
 * The parts of the interface that are not the weather panel: the topbar and its controls, the
 * compass, the hero title, the sound pill, the telemetry footer, the status toast, and the button
 * that brings a hidden interface back.
 *
 * Every readout is the game's published value — the live atmosphere for telemetry, the mirrored
 * booleans for the controls — so nothing here can drift from what the simulation is doing.
 */
export function Hud({ send, say, panelOpen, setPanelOpen, state, toast, toastVisible }: IHudProps) {
  const soundOn = state.audioEnabled && !state.muted;
  return (
    <>
      <div className={`interface${state.uiHidden ? " hidden" : ""}`}>
        <header className="topbar">
          <div className="brand">
            <div className="mark">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                aria-hidden="true"
              >
                <path d="M6 15a4 4 0 0 1 0-8 6 6 0 0 1 11.4-.5A4.5 4.5 0 0 1 18 15M10 12l-2 5h4l-2 5" />
              </svg>
            </div>
            <div>
              <div className="brand-title">ATMOSPHERICS</div>
              <div className="brand-sub">INTERACTIVE FIELD STUDIES / 001</div>
            </div>
          </div>
          <div className="top-actions">
            <div className="status">
              <span className="dot" />
              REALTIME ENVIRONMENT
            </div>
            <button
              aria-label="Toggle weather controls"
              className="icon-btn panel-toggle"
              data-tn-interactive
              onClick={() => setPanelOpen(!panelOpen)}
              title="Weather controls"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h16M4 17h16" />
                <circle cx="9" cy="7" r="2" />
                <circle cx="15" cy="17" r="2" />
              </svg>
            </button>
            <button
              aria-label={state.paused ? "Resume simulation" : "Pause simulation"}
              aria-pressed={state.paused}
              className={`icon-btn${state.paused ? " active" : ""}`}
              data-tn-interactive
              onClick={() => send(state.paused ? "resume" : "pause")}
              title="Pause [Space]"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M9 5v14M15 5v14" />
              </svg>
            </button>
            <button
              aria-label="Save scene image"
              className="icon-btn desktop"
              data-tn-interactive
              onClick={() => captureScene(say)}
              title="Save scene image [P]"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h4l2-3h4l2 3h4v13H4z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>
            <button
              aria-label="Fullscreen"
              className="icon-btn desktop"
              data-tn-interactive
              onClick={() => {
                void toggleFullscreen(say);
              }}
              title="Fullscreen [F]"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5" />
              </svg>
            </button>
            <button
              aria-label="Controls and accessibility"
              className="icon-btn"
              data-tn-interactive
              onClick={() => send("help")}
              title="Controls and accessibility"
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01" />
              </svg>
            </button>
          </div>
        </header>

        <div className="compass">
          <div className="letters">
            <span>NW</span>
            <span>{state.heading}°</span>
            <span>NE</span>
          </div>
          <div className="ticks" />
        </div>

        <section className="hero">
          <div className="eyebrow">A COASTAL WEATHER STUDY</div>
          <h1>TEMPEST</h1>
          <p>Somewhere between stillness and the storm.</p>
        </section>

        <footer className="bottom-bar">
          <div className="telemetry">
            <div>
              <div className="metric-label">PRECIPITATION</div>
              <div className="metric-value">
                <span>{(state.weather.rain * 48).toFixed(1)}</span>
                <small>mm/h</small>
              </div>
            </div>
            <div>
              <div className="metric-label">WIND SPEED</div>
              <div className="metric-value">
                <span>{(state.weather.wind * 72).toFixed(1)}</span>
                <small>km/h</small>
              </div>
            </div>
            <div>
              <div className="metric-label">FRAME RATE</div>
              <div className="metric-value">
                <span>{state.fps > 0 ? Math.round(state.fps) : "—"}</span>
                <small>fps</small>
              </div>
            </div>
          </div>
          {/* The pill and the key hints share one column, so neither can be drawn over the other or
              over the panel above them however short the window is. */}
          <div className="bottom-actions">
            <button
              aria-label={soundOn ? "Mute rain and thunder audio" : "Enable rain and thunder audio"}
              aria-pressed={soundOn}
              className={`sound-pill${soundOn ? " active" : ""}`}
              data-tn-interactive
              id="sound"
              onClick={() => {
                if (soundOn) {
                  send("setMuted", true);
                  return;
                }
                send("setAudioEnabled", true);
                send("setMuted", false);
              }}
              type="button"
            >
              <span className="sound-wave">
                <span />
                <span />
                <span />
                <span />
              </span>
              <span>{soundOn ? "SOUND ON" : "ENABLE SOUND"}</span>
            </button>
            <div className="key-hint">
              <kbd>DRAG</kbd> LOOK &nbsp; <kbd>W A S D</kbd> MOVE &nbsp; <kbd>Q E</kbd> ALTITUDE
              <br />
              <kbd>H</kbd> HIDE INTERFACE &nbsp; <kbd>R</kbd> RESET CAMERA
            </div>
          </div>
        </footer>

        <output aria-live="polite" className={`toast${toastVisible ? " visible" : ""}`}>
          {toast}
        </output>
      </div>
      {/* Outside the sheet, because the sheet is hidden when this is the way back. */}
      <button
        className={`restore${state.uiHidden ? " visible" : ""}`}
        data-tn-interactive
        onClick={() => send("showUi")}
        type="button"
      >
        SHOW INTERFACE · H
      </button>
    </>
  );
}
