import { useEffect, useMemo, useRef, useState } from "react";
import {
  type AnimationPose,
  type RecipeV3,
  migrateRecipe,
  poseAt,
  upsertKeyframe,
} from "./recipe.js";
import { type AnchorId, type AnchorInfo, CalibrationScene, type TransformValue } from "./scene.js";

type Mode = "rotate" | "scale" | "translate";
const DEFAULT_KEY = "$default";
const EMPTY: TransformValue = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const ANCHORS = new Set<AnchorId>([
  "head",
  "hips",
  "left-foot",
  "left-hand",
  "right-foot",
  "right-hand",
]);
const rounded = (value: TransformValue): TransformValue => ({
  position: value.position.map((item) => Number(item.toFixed(4))) as [number, number, number],
  rotation: value.rotation.map((item) => Number(item.toFixed(3))) as [number, number, number],
  scale: value.scale.map((item) => Number(item.toFixed(4))) as [number, number, number],
});
const fileStem = (path: string): string =>
  (path.split("/").at(-1) ?? "model")
    .replace(/\.[^.]+$/u, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-");

function requestParameters() {
  const query = new URLSearchParams(location.search);
  const anchor = query.get("anchor");
  return {
    anchor:
      anchor !== null && ANCHORS.has(anchor as AnchorId) ? (anchor as AnchorId) : "right-hand",
    attached: query.get("attach") ?? "",
    host: query.get("host") ?? "",
    output: query.get("output") ?? "",
  };
}

export function App({ project }: { readonly project: string }) {
  const requested = useMemo(requestParameters, []);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<CalibrationScene | undefined>(undefined);
  const [models, setModels] = useState<string[]>([]);
  const [host, setHost] = useState(requested.host);
  const [attached, setAttached] = useState(requested.attached);
  const [anchor, setAnchor] = useState<AnchorId>(requested.anchor);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const [anchors, setAnchors] = useState<readonly AnchorInfo[]>([]);
  const [clips, setClips] = useState<readonly { duration: number; name: string }[]>([]);
  const [clip, setClip] = useState("");
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const [time, setTime] = useState(0);
  const timeRef = useRef(time);
  timeRef.current = time;
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<Mode>("translate");
  const [transform, setTransform] = useState<TransformValue>(EMPTY);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const [tracks, setTracks] = useState<Record<string, AnimationPose>>({});
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const key = clip || DEFAULT_KEY;
  const activeTrack = tracks[key];
  const output = useMemo(
    () =>
      requested.output ||
      `pose-recipes/${fileStem(host || "host")}-${fileStem(attached || "attached")}.pose.json`,
    [attached, host, requested.output],
  );

  const showPoseAt = (value: number): void => {
    setTime(value);
    scene.current?.seek(value);
    const track = tracksRef.current[clipRef.current || DEFAULT_KEY];
    if (track?.attachment === "detached") return;
    const pose = poseAt(track, value);
    if (pose === undefined) return;
    setTransform(pose);
    scene.current?.setTransform(pose);
  };

  useEffect(() => {
    fetch("/api/models")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Model scan failed (${response.status}).`);
        return (await response.json()) as { models: string[] };
      })
      .then(({ models: found }) => {
        setModels(found);
        if (!found.includes(host)) setHost(found[0] ?? "");
        if (!found.includes(attached)) setAttached(found.find((item) => item !== found[0]) ?? "");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [attached, host]);

  useEffect(() => {
    if (canvas.current === null) return;
    const instance = new CalibrationScene(canvas.current, {
      anchors: setAnchors,
      animations: (value) => {
        setClips(value);
        setClip(value[0]?.name ?? "");
      },
      error: setError,
      time: (value) => {
        setTime(value);
        const track = tracksRef.current[clipRef.current || DEFAULT_KEY];
        if (track?.attachment === "detached") return;
        const pose = poseAt(track, value);
        if (pose !== undefined) {
          setTransform(pose);
          scene.current?.setTransform(pose);
        }
      },
      transform: (value) => setTransform(rounded(value)),
    });
    scene.current = instance;
    return () => {
      instance.dispose();
      scene.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!host || !attached || host === attached) return;
    setError("");
    void scene.current?.load(host, attached, anchorRef.current);
  }, [attached, host]);

  useEffect(() => scene.current?.play(playing), [playing]);

  useEffect(() => {
    scene.current?.setDetached(false);
    scene.current?.setEditable(true);
    scene.current?.useClip(clip);
    const track = tracksRef.current[clip || DEFAULT_KEY];
    const first = track?.keyframes[0];
    if (first !== undefined) {
      setTime(first.time);
      setTransform(first.transform);
      scene.current?.seek(first.time);
      scene.current?.setTransform(first.transform);
    }
    if (track?.attachment === "detached") {
      scene.current?.setDetached(true);
      scene.current?.setEditable(false);
    }
  }, [clip]);

  useEffect(() => {
    if (!host || !attached) return;
    fetch(`/api/recipe?path=${encodeURIComponent(output)}`)
      .then(async (response) => {
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`Recipe load failed (${response.status}).`);
        return (await response.json()) as {
          recipe?: RecipeV3 | Parameters<typeof migrateRecipe>[0];
        };
      })
      .then((body) => {
        if (body?.recipe === undefined) return;
        const recipe = migrateRecipe(body.recipe);
        if (recipe === undefined) return;
        const loaded: Record<string, AnimationPose> = {
          ...(recipe.default === undefined ? {} : { [DEFAULT_KEY]: recipe.default }),
          ...recipe.animations,
        };
        tracksRef.current = loaded;
        setTracks(loaded);
        const track = loaded[clipRef.current || DEFAULT_KEY];
        scene.current?.setDetached(false);
        scene.current?.setEditable(true);
        const first = track?.keyframes[0];
        if (first !== undefined) {
          setTime(first.time);
          setTransform(first.transform);
          scene.current?.seek(first.time);
          scene.current?.setTransform(first.transform);
        }
        if (track?.attachment === "detached") {
          scene.current?.setDetached(true);
          scene.current?.setEditable(false);
        }
        setMessage(
          `Loaded ${output}${body.recipe.version === 2 ? " · legacy poses preserved" : ""}`,
        );
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [attached, host, output]);

  const capture = (source = tracksRef.current): Record<string, AnimationPose> => {
    const active = source[clipRef.current || DEFAULT_KEY];
    if (active?.attachment === "detached") {
      setMessage("Detached preview is locked · switch to Follow anchor to edit the release pose");
      return source;
    }
    const current = {
      ...source,
      [clipRef.current || DEFAULT_KEY]: upsertKeyframe(source[clipRef.current || DEFAULT_KEY], {
        time: timeRef.current,
        transform: transformRef.current,
      }),
    };
    tracksRef.current = current;
    setTracks(current);
    setMessage(`Keyframe captured at ${Math.round(timeRef.current * 100)}%`);
    return current;
  };

  const switchClip = (next: string): void => {
    capture();
    setClip(next);
  };

  const setAttachment = (attachment: "attached" | "detached"): void => {
    const current = tracksRef.current;
    const next = {
      ...current,
      [key]: {
        attachment,
        keyframes: current[key]?.keyframes ?? [],
      },
    };
    tracksRef.current = next;
    setTracks(next);
    if (attachment === "detached") {
      scene.current?.setDetached(true);
      scene.current?.setEditable(false);
      setPlaying(false);
      setMessage("Detached in world space · Play to preview the host moving away");
    } else {
      scene.current?.setDetached(false);
      scene.current?.setEditable(true);
      const pose = poseAt(next[key], time);
      if (pose !== undefined) {
        setTransform(pose);
        scene.current?.setTransform(pose);
      }
    }
  };

  const editAxis = (group: keyof TransformValue, index: number, value: number): void => {
    const next = {
      ...transform,
      [group]: transform[group].map((item, axis) => (axis === index ? value : item)),
    } as TransformValue;
    setTransform(next);
    scene.current?.setTransform(next);
  };

  const removeNearestKeyframe = (): void => {
    if (activeTrack === undefined) return;
    const nearest = [...activeTrack.keyframes].sort(
      (a, b) => Math.abs(a.time - time) - Math.abs(b.time - time),
    )[0];
    if (nearest === undefined) return;
    const next = {
      ...tracks,
      [key]: {
        ...activeTrack,
        keyframes: activeTrack.keyframes.filter((frame) => frame !== nearest),
      },
    };
    tracksRef.current = next;
    setTracks(next);
  };

  const save = async (): Promise<void> => {
    const selected = anchors.find((item) => item.id === anchor);
    if (selected === undefined) return;
    const current = capture();
    const recipe: RecipeV3 = {
      anchor: selected,
      animations: Object.fromEntries(
        Object.entries(current).filter(([entry]) => entry !== DEFAULT_KEY),
      ),
      attached,
      ...(current[DEFAULT_KEY] === undefined ? {} : { default: current[DEFAULT_KEY] }),
      host,
      version: 3,
    };
    const response = await fetch(`/api/recipe?path=${encodeURIComponent(output)}`, {
      body: JSON.stringify({ recipe }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; path?: string };
    if (!response.ok) return setError(body.error ?? `Save failed (${response.status}).`);
    setMessage(`Saved ${body.path ?? output}`);
  };

  return (
    <main className="lab">
      <header className="bar">
        <div className="brand">
          <b>◇</b>POSE LAB
        </div>
        <small>{project} · model attachment workbench</small>
        <span className="grow" />
        <span className="saved">{message}</span>
        <button type="button" onClick={() => void save()}>
          Save recipe
        </button>
      </header>
      <div className="body">
        <aside className="side left">
          <section className="section">
            <h2>Models</h2>
            <label>
              Host model
              <select value={host} onChange={(event) => setHost(event.target.value)}>
                <option value="">Select GLB…</option>
                {models.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Attached model
              <select value={attached} onChange={(event) => setAttached(event.target.value)}>
                <option value="">Select GLB…</option>
                {models.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <button
              className="wide secondary"
              type="button"
              onClick={() => scene.current?.groundHost()}
            >
              Ground host to floor
            </button>
            <p className="hint">
              Grounding measures rendered meshes, independent of the model axis or origin.
            </p>
          </section>
        </aside>
        <section className="workspace">
          <section className="viewport">
            <canvas ref={canvas} />
            <div className="title">
              ANCHOR / ALIGN
              <small>
                {anchor.replace("-", " ")} · {activeTrack?.attachment ?? "attached"}
              </small>
            </div>
            <nav className="tools">
              {(["translate", "rotate", "scale"] as const).map((item) => (
                <button
                  className={mode === item ? "on" : ""}
                  disabled={activeTrack?.attachment === "detached"}
                  key={item}
                  type="button"
                  onClick={() => {
                    setMode(item);
                    scene.current?.setMode(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </nav>
            {activeTrack?.attachment === "detached" && (
              <div className="release-note">WORLD-SPACE RELEASE PREVIEW</div>
            )}
            {error && <div className="error">{error}</div>}
          </section>
          <section className="dope-editor">
            <header className="editor-bar">
              <button
                className="transport"
                type="button"
                onClick={() => setPlaying((value) => !value)}
              >
                {playing ? "Ⅱ" : "▶"}
              </button>
              <select
                aria-label="Animation clip"
                value={clip}
                onChange={(event) => switchClip(event.target.value)}
              >
                <option value="">Default / static</option>
                {clips.map((item) => (
                  <option key={item.name}>{item.name}</option>
                ))}
              </select>
              <span className="timecode">
                {String(Math.round(time * 1000)).padStart(4, "0")} <i>/ 1000</i>
              </span>
              <button
                type="button"
                onClick={() => capture()}
                disabled={activeTrack?.attachment === "detached"}
              >
                ◆ Add key
              </button>
              <button className="secondary" type="button" onClick={removeNearestKeyframe}>
                Delete nearest
              </button>
              <span className="grow" />
              <div className="segmented compact">
                <button
                  className={activeTrack?.attachment !== "detached" ? "on" : ""}
                  type="button"
                  onClick={() => setAttachment("attached")}
                >
                  Follow anchor
                </button>
                <button
                  className={activeTrack?.attachment === "detached" ? "danger on" : "danger"}
                  type="button"
                  onClick={() => setAttachment("detached")}
                >
                  Detach / release
                </button>
              </div>
            </header>
            <div className="sheet">
              <div className="lane-label ruler-label">CHANNELS</div>
              <div className="ruler">
                {Array.from({ length: 11 }, (_, index) => index * 10).map((mark) => (
                  <span key={mark} style={{ left: `${mark}%` }}>
                    {mark}
                  </span>
                ))}
              </div>
              {(["POSITION", "ROTATION", "SCALE"] as const).map((channel, index) => (
                <div className="lane-row" key={channel}>
                  <div className="lane-label" style={{ gridRow: index + 2 }}>
                    <i />
                    {channel}
                  </div>
                  <div className="lane-track" style={{ gridRow: index + 2 }}>
                    {(activeTrack?.keyframes ?? []).map((frame) => (
                      <button
                        aria-label={`Go to ${channel.toLowerCase()} keyframe ${frame.time}`}
                        className="key-diamond"
                        key={frame.time}
                        style={{ left: `${frame.time * 100}%` }}
                        type="button"
                        onClick={() => showPoseAt(frame.time)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="lane-row attachment-lane">
                <div className="lane-label">
                  <i />
                  ATTACHMENT
                </div>
                <div
                  className={`event-clip ${activeTrack?.attachment === "detached" ? "released" : ""}`}
                >
                  {activeTrack?.attachment === "detached"
                    ? "DETACH → WORLD"
                    : `FOLLOW · ${anchor.toUpperCase()}`}
                </div>
              </div>
              <div className="playhead" style={{ left: `calc(132px + (100% - 132px) * ${time})` }}>
                <b />
              </div>
              <input
                className="scrubber"
                aria-label="Animation timeline"
                type="range"
                min="0"
                max="1"
                step="0.001"
                value={time}
                onChange={(event) => showPoseAt(Number(event.target.value))}
              />
            </div>
          </section>
        </section>
        <aside className="side right">
          <section className="section">
            <h2>Anchor</h2>
            <div className="landmarks">
              {anchors.map((item) => (
                <button
                  className={`landmark ${item.source} ${item.id === anchor ? "on" : ""}`}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setAnchor(item.id);
                    scene.current?.selectAnchor(item.id);
                  }}
                >
                  <i />
                  <span>
                    {item.label}
                    <br />
                    <small>{item.node}</small>
                  </span>
                  <small>{item.source}</small>
                </button>
              ))}
            </div>
          </section>
          {(["position", "rotation", "scale"] as const).map((group) => (
            <section className="section" key={group}>
              <h2>{group}</h2>
              <div className="axis">
                {(["X", "Y", "Z"] as const).map((axis, index) => (
                  <label key={axis}>
                    {axis}
                    <input
                      type="number"
                      disabled={activeTrack?.attachment === "detached"}
                      step={group === "rotation" ? 1 : 0.01}
                      value={transform[group][index]}
                      onChange={(event) => editAxis(group, index, Number(event.target.value))}
                    />
                  </label>
                ))}
              </div>
              {group === "scale" && (
                <div className="preset">
                  {[0.25, 0.5, 0.75, 1].map((ratio) => (
                    <button
                      key={ratio}
                      type="button"
                      onClick={() => scene.current?.sizeToHost(ratio)}
                    >
                      {ratio * 100}%
                    </button>
                  ))}
                </div>
              )}
            </section>
          ))}
        </aside>
      </div>
      <footer className="status">
        <span>
          <b>● READY</b> · {anchors.filter((item) => item.source === "detected").length}/
          {anchors.length} landmarks detected
        </span>
        <span>recipe v3 · {output}</span>
      </footer>
    </main>
  );
}
