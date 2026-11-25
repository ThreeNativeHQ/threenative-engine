// Playback and rig diagnostics for a model with clips. The authoring half (bone landmarks, the
// attach gizmo, the dope sheet and its op log) is Pose Lab itself, mounted at `<base>pose/` and
// opened over the stage, so `/__assets/` and `animation_open_view` edit the same files.
import * as three from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clipBoneCoverage, clipTrackBindings } from "../../../../core/src/clip-audit.js";
import { type IModelInfo, type IViewerHost, getJson } from "./viewers.js";

type LoopMode = "repeat" | "once" | "ping-pong";
const LOOPS: Record<LoopMode, three.AnimationActionLoopStyles> = {
  repeat: three.LoopRepeat,
  once: three.LoopOnce,
  "ping-pong": three.LoopPingPong,
};
const FRAME = 1 / 30;

interface IDefect {
  readonly kind: string;
  readonly bone: string;
  readonly detail: string;
  readonly fromTime: number;
  readonly toTime: number;
}

/** The bone a locomotion clip moves the character by: the first root-ish bone with position tracks. */
function rootBone(root: three.Object3D, clip: three.AnimationClip): three.Object3D | undefined {
  const moved = clip.tracks
    .filter((track) => track.name.endsWith(".position"))
    .map((track) => track.name.slice(0, -".position".length));
  const named = ["hips", "pelvis", "root", "mixamorig:hips"];
  for (const want of named) {
    const hit = moved.find((name) => name.toLowerCase().includes(want));
    if (hit) return root.getObjectByName(hit);
  }
  return moved[0] ? root.getObjectByName(moved[0]) : undefined;
}

export function animationPanel(host: IViewerHost, gltf: GLTF, info: IModelInfo) {
  const root = gltf.scene;
  const clips = gltf.animations;
  const mixer = new three.AnimationMixer(root);
  let action: three.AnimationAction | undefined;
  let clip = clips[0] as three.AnimationClip;
  let playing = true;
  let lockRoot = false;
  let speed = 1;
  let loop: LoopMode = "repeat";
  let defects: IDefect[] = [];
  let lockedBone: three.Object3D | undefined;
  let lockedStart = new three.Vector3();
  const skeleton = new three.SkeletonHelper(root);
  skeleton.visible = false;
  const forward = new three.ArrowHelper(
    new three.Vector3(0, 0, 1),
    new three.Vector3(),
    1,
    0xe0fb50,
  );
  forward.visible = false;
  root.add(forward);
  host.view.scene.add(skeleton);
  const size = new three.Box3().setFromObject(root).getSize(new three.Vector3());
  forward.setLength(Math.max(0.5, size.z * 0.8));
  forward.position.y = size.y * 0.05;

  const panel = host.overlay(
    "inset-x-2 bottom-12 grid gap-1.5 rounded border border-line bg-app/92 p-2 text-xs",
  );
  const row = host.el("div", "flex flex-wrap items-center gap-1.5");
  const select = host.el("select", "field w-auto py-0.5");
  select.name = "clip";
  select.setAttribute("aria-label", "Clip");
  const fadeTo = host.el("select", "field w-auto py-0.5");
  fadeTo.name = "crossfade";
  fadeTo.setAttribute("aria-label", "Crossfade to");
  for (const c of clips) {
    select.append(new Option(c.name, c.name));
    fadeTo.append(new Option(`→ ${c.name}`, c.name));
  }
  const button = (label: string, title: string, onClick: () => void) => {
    const b = host.el("button", "tool w-auto px-2 text-ink", label);
    b.title = title;
    b.setAttribute("aria-label", title);
    b.onclick = onClick;
    return b;
  };
  const pressed = (label: string, title: string, on: boolean, apply: (on: boolean) => void) => {
    const b = button(label, title, () => {
      const next = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(next));
      apply(next);
      host.invalidate();
    });
    b.setAttribute("aria-pressed", String(on));
    return b;
  };
  const play = button("Pause", "Play or pause", () => {
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
    if (action) action.paused = !playing;
  });
  const loopSelect = host.el("select", "field w-auto py-0.5");
  loopSelect.name = "loop";
  loopSelect.setAttribute("aria-label", "Loop mode");
  for (const mode of Object.keys(LOOPS)) loopSelect.append(new Option(mode, mode));
  loopSelect.onchange = () => {
    loop = loopSelect.value as LoopMode;
    start(clip, false);
  };
  const speedSelect = host.el("select", "field w-auto py-0.5");
  speedSelect.name = "speed";
  speedSelect.setAttribute("aria-label", "Playback speed");
  for (const value of [0.1, 0.25, 0.5, 1, 1.5, 2])
    speedSelect.append(new Option(`${value}×`, String(value)));
  speedSelect.value = "1";
  speedSelect.onchange = () => {
    speed = Number(speedSelect.value);
  };
  const step = (by: number) => {
    playing = false;
    play.textContent = "Play";
    if (!action) return;
    action.paused = false;
    mixer.update(by);
    action.paused = true;
    afterUpdate();
  };
  const ground = host.el("span", "tabular-nums text-muted");
  row.append(
    select,
    play,
    button("◀", "Back one frame", () => step(-FRAME)),
    button("▶", "Forward one frame", () => step(FRAME)),
    loopSelect,
    speedSelect,
    fadeTo,
    button("Crossfade", "Crossfade to the clip on the left over 0.3 s", () => {
      const next = clips.find((c) => c.name === fadeTo.value);
      if (next) start(next, true);
    }),
    pressed("Skeleton", "Show the bone overlay", false, (on) => {
      skeleton.visible = on;
    }),
    pressed("Forward", "Show the model's +Z forward axis", false, (on) => {
      forward.visible = on;
    }),
    pressed(
      "Lock root",
      "Pin the root bone at its start while inspecting locomotion",
      false,
      (on) => {
        lockRoot = on;
        lockedBone = on ? rootBone(root, clip) : undefined;
        if (lockedBone) lockedStart = lockedBone.position.clone();
      },
    ),
    ground,
  );
  if (info.poseLab)
    row.append(
      button("Pose Lab", "Open Pose Lab: landmarks, attach gizmo, dope sheet and op log", () =>
        openPoseLab(host, info),
      ),
    );

  // The ruler: the scrubber over the clip, with each defect drawn where it happens.
  const ruler = host.el("div", "relative h-6 rounded bg-sidebar");
  const spans = host.el("div", "absolute inset-0");
  const scrub = host.el(
    "input",
    "absolute inset-0 w-full cursor-ew-resize opacity-60 accent-accent",
  );
  scrub.type = "range";
  scrub.name = "time";
  scrub.min = "0";
  scrub.step = "0.001";
  scrub.setAttribute("aria-label", "Timeline");
  scrub.oninput = () => {
    if (!action) return;
    action.time = Number(scrub.value);
    action.paused = false;
    mixer.update(0);
    action.paused = !playing;
    afterUpdate();
  };
  ruler.append(spans, scrub);
  const notes = host.el("div", "flex flex-wrap gap-2 text-muted");
  panel.append(row, ruler, notes);

  const audit = () => {
    const bindings = clipTrackBindings(root, clip);
    let coverage = "";
    try {
      const report = clipBoneCoverage(root, clip);
      coverage = report.undriven.length
        ? `${report.undriven.length} of ${report.bones} bones undriven`
        : `drives all ${report.bones} bones`;
    } catch {
      coverage = "no bones";
    }
    notes.replaceChildren(
      host.el(
        "span",
        bindings.unbound.length ? "text-danger" : "text-story",
        bindings.unbound.length
          ? `● ${bindings.unbound.length} of ${bindings.tracks} tracks unbound (${bindings.unbound[0]?.track})`
          : `● ${bindings.tracks} tracks bound`,
      ),
      host.el("span", "", `● ${coverage}`),
      host.el("span", "", `● ${clip.duration.toFixed(2)} s`),
    );
  };
  const drawDefects = () => {
    spans.replaceChildren();
    for (const defect of defects) {
      const span = host.el(
        "button",
        "absolute top-0 h-full cursor-pointer bg-danger/55 hover:bg-danger",
      );
      span.style.left = `${(100 * defect.fromTime) / clip.duration}%`;
      span.style.width = `${Math.max(0.6, (100 * (defect.toTime - defect.fromTime)) / clip.duration)}%`;
      span.title = `${defect.kind} · ${defect.bone} · ${defect.detail}`;
      span.setAttribute("aria-label", span.title);
      span.onclick = () => {
        scrub.value = String(defect.fromTime);
        scrub.dispatchEvent(new Event("input"));
      };
      spans.append(span);
    }
  };
  const verify = async () => {
    defects = [];
    drawDefects();
    if (!info.poseLab) return;
    const scale = info.inspection.units.label === "likely centimetres" ? 0.01 : 1;
    try {
      const report = await getJson<{ defects: IDefect[]; passed: boolean }>(
        `${host.base}pose/api/verify?path=${encodeURIComponent(info.path)}&clip=${encodeURIComponent(clip.name)}&scale=${scale}`,
      );
      defects = report.defects;
      drawDefects();
      notes.append(
        host.el(
          "span",
          report.passed ? "text-story" : "text-danger",
          report.passed
            ? "● animation_verify: no defects"
            : `● animation_verify: ${defects.length} defects`,
        ),
      );
    } catch (error) {
      notes.append(host.el("span", "text-doc", `● verify: ${(error as Error).message}`));
    }
  };

  const afterUpdate = () => {
    if (lockRoot && lockedBone) {
      lockedBone.position.x = lockedStart.x;
      lockedBone.position.z = lockedStart.z;
    }
    if (action) scrub.value = String(action.time);
    // Ground clearance: the lowest bone (or the mesh bounds without a skeleton) against y = 0.
    let low = Number.POSITIVE_INFINITY;
    const at = new three.Vector3();
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      if ((node as three.Bone).isBone) low = Math.min(low, node.getWorldPosition(at).y);
    });
    if (!Number.isFinite(low)) low = new three.Box3().setFromObject(root).min.y;
    ground.textContent = `ground ${low >= 0 ? "+" : ""}${(low * 100).toFixed(1)} cm`;
    ground.className = `tabular-nums ${low < -0.01 ? "text-danger" : "text-muted"}`;
    host.invalidate();
  };

  const start = (next: three.AnimationClip, fade: boolean) => {
    const previous = action;
    clip = next;
    select.value = next.name;
    scrub.max = String(next.duration);
    action = mixer.clipAction(next);
    action.reset();
    action.setLoop(LOOPS[loop], Number.POSITIVE_INFINITY);
    action.clampWhenFinished = loop === "once";
    action.paused = !playing;
    if (previous && previous !== action && fade) {
      action.play();
      previous.crossFadeTo(action, 0.3, false);
    } else {
      mixer.stopAllAction();
      action.play();
    }
    lockedBone = lockRoot ? rootBone(root, clip) : undefined;
    if (lockedBone) lockedStart = lockedBone.position.clone();
    audit();
    void verify();
    afterUpdate();
  };
  select.onchange = () => {
    const next = clips.find((c) => c.name === select.value);
    if (next) start(next, false);
  };
  start(clip, false);

  return {
    playing: () => playing,
    tick(dt: number) {
      mixer.update(dt * speed);
      afterUpdate();
    },
    leave() {
      mixer.stopAllAction();
      host.view.scene.remove(skeleton);
      skeleton.dispose();
      panel.remove();
    },
  };
}

/** Pose Lab over the stage, opened on this model: same op log and recipe files as the MCP view. */
function openPoseLab(host: IViewerHost, info: IModelInfo): void {
  const layer = host.overlay("inset-0 z-20 grid grid-rows-[auto_1fr] bg-app");
  const bar = host.el("div", "flex items-center gap-2 border-b border-line px-2 py-1");
  const close = host.el("button", "tool w-auto px-2 text-ink", "Close Pose Lab");
  close.onclick = () => layer.remove();
  bar.append(host.el("span", "flex-1 font-bold text-white", `Pose Lab · ${info.path}`), close);
  const frame = host.el("iframe", "size-full border-0");
  frame.title = "Pose Lab";
  frame.src = `${host.base}pose/?host=${encodeURIComponent(info.path)}`;
  layer.append(bar, frame);
}
