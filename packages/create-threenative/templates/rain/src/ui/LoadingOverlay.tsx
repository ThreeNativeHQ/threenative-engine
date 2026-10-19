import { useEffect, useState } from "react";

/** How long the curtain fades once the storm is ready; matches `.loading`'s CSS transition. */
const FADE_MS = 800;

/**
 * The study's staged loading overlay, over the engine's own loading bar until the frame the storm
 * is ready. The stages are read off the engine's real startup progress, so the text never claims a
 * stage the launch has not reached. It paints only its text over the engine's own opaque loading
 * screen (the same night colour), and once faded it leaves the page entirely.
 */
export function LoadingOverlay({ progress, ready }: { progress: number; ready: boolean }) {
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setRemoved(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  if (removed) return null;

  const stage = ready
    ? "ENTERING THE STORM"
    : progress < 0.34
      ? "BUILDING THE CLOUD VOLUME"
      : progress < 0.67
        ? "LIGHTING THE COAST"
        : "ENTERING THE STORM";
  return (
    <div aria-busy={!ready} aria-hidden={ready} className={`loading${ready ? " gone" : ""}`}>
      {/* The progress line itself is the engine's canvas loading bar, centred between these two. */}
      <div className="loading-head">
        <div className="loading-title">TEMPEST</div>
        <div aria-live="polite" className="loading-text">
          {stage}
        </div>
      </div>
      <div className="loading-note">
        A procedural, real-time weather study.
        <br />
        Contains lightning flashes. Disable them in
        <br />
        Rendering &amp; Accessibility or press <kbd>X</kbd>.
      </div>
    </div>
  );
}
