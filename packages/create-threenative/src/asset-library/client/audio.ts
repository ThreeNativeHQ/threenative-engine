// The audio viewer: the decoded waveform, a transport (play, pause, loop, volume) and the clip's
// channel, sample-rate, duration and size rows. Web Audio decodes; nothing plays until asked.
import type { IAssetElement } from "../types.js";
import {
  type IFileStats,
  type IViewerHost,
  type IViewerMode,
  fileUrl,
  getJson,
  mb,
} from "./viewers.js";

/** Peak pairs (min, max) per column, the shape a waveform draws. */
export function peaks(samples: Float32Array, columns: number): Float32Array {
  const out = new Float32Array(columns * 2);
  const step = Math.max(1, Math.floor(samples.length / columns));
  for (let c = 0; c < columns; c += 1) {
    let min = 0;
    let max = 0;
    for (let i = c * step; i < Math.min(samples.length, (c + 1) * step); i += 1) {
      const v = samples[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[c * 2] = min;
    out[c * 2 + 1] = max;
  }
  return out;
}

export async function audioView(element: IAssetElement, host: IViewerHost): Promise<IViewerMode> {
  const file = element.path ?? element.id;
  const url = fileUrl(host, file);
  const [info, bytes] = await Promise.all([
    getJson<{ raw: IFileStats; cooked?: IFileStats & { output: string } }>(
      `${host.api}project/info?path=${encodeURIComponent(file)}`,
    ),
    fetch(url).then((response) => response.arrayBuffer()),
  ]);
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(bytes.slice(0));
  host.view.renderer.domElement.style.visibility = "hidden";
  const panel = host.overlay("inset-0 grid content-center gap-4 bg-app p-8");
  const wave = host.el("canvas", "h-48 w-full rounded border border-line bg-sidebar");
  wave.setAttribute("aria-label", `Waveform of ${element.name}`);
  const bar = host.el("div", "flex flex-wrap items-center gap-3");
  const play = host.el("button", "tool w-auto px-3 text-ink", "Play");
  play.name = "play";
  const loopBox = host.el("label", "flex items-center gap-1 text-muted", "Loop ");
  const loop = host.el("input");
  loop.type = "checkbox";
  loop.name = "loop";
  loopBox.prepend(loop);
  const volumeBox = host.el("label", "flex items-center gap-2 text-muted", "Volume");
  const volume = host.el("input", "accent-accent");
  volume.type = "range";
  volume.name = "volume";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "0.8";
  volumeBox.append(volume);
  const time = host.el("span", "tabular-nums text-muted", `0.00 / ${buffer.duration.toFixed(2)} s`);
  bar.append(play, loopBox, volumeBox, time);
  panel.append(host.el("h2", "text-lg font-bold text-white", element.name), wave, bar);

  const gain = context.createGain();
  gain.connect(context.destination);
  gain.gain.value = Number(volume.value);
  volume.oninput = () => {
    gain.gain.value = Number(volume.value);
  };
  let source: AudioBufferSourceNode | undefined;
  let startedAt = 0;
  let offset = 0;
  const position = () =>
    source ? (offset + context.currentTime - startedAt) % buffer.duration : offset;
  const stop = () => {
    if (!source) return;
    offset = position();
    source.onended = null;
    source.stop();
    source = undefined;
    play.textContent = "Play";
  };
  const start = () => {
    source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop.checked;
    source.connect(gain);
    if (offset >= buffer.duration) offset = 0;
    source.start(0, offset);
    startedAt = context.currentTime;
    play.textContent = "Pause";
    source.onended = () => {
      source = undefined;
      offset = 0;
      play.textContent = "Play";
      host.invalidate();
    };
  };
  play.onclick = () => {
    void context.resume();
    if (source) stop();
    else start();
    host.invalidate();
  };
  loop.onchange = () => {
    if (source) source.loop = loop.checked;
  };
  wave.onclick = (event) => {
    const rect = wave.getBoundingClientRect();
    const playing = Boolean(source);
    stop();
    offset = ((event.clientX - rect.left) / rect.width) * buffer.duration;
    if (playing) start();
    draw();
  };

  const draw = () => {
    const width = wave.clientWidth * devicePixelRatio || 800;
    const height = wave.clientHeight * devicePixelRatio || 200;
    wave.width = width;
    wave.height = height;
    const ctx = wave.getContext("2d") as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, width, height);
    const channels = buffer.numberOfChannels;
    for (let ch = 0; ch < channels; ch += 1) {
      const lane = height / channels;
      const mid = lane * ch + lane / 2;
      const data = peaks(buffer.getChannelData(ch), width);
      ctx.fillStyle = "#37d5d3";
      for (let x = 0; x < width; x += 1)
        ctx.fillRect(
          x,
          mid + (data[x * 2] ?? 0) * lane * 0.45,
          1,
          Math.max(1, ((data[x * 2 + 1] ?? 0) - (data[x * 2] ?? 0)) * lane * 0.45),
        );
    }
    const at = (position() / buffer.duration) * width;
    ctx.fillStyle = "#e0fb50";
    ctx.fillRect(at, 0, 2 * devicePixelRatio, height);
    time.textContent = `${position().toFixed(2)} / ${buffer.duration.toFixed(2)} s`;
  };
  requestAnimationFrame(draw);

  host.rowsInto(host.stats, [
    ["Duration", `${buffer.duration.toFixed(3)} s`],
    ["Channels", buffer.numberOfChannels === 1 ? "mono" : `${buffer.numberOfChannels} (stereo)`],
    ["Sample rate", `${buffer.sampleRate.toLocaleString()} Hz`],
    ["Raw file", mb(info.raw.bytes)],
    [
      "Cooked file",
      info.cooked ? `${mb(info.cooked.bytes)} · ${info.cooked.output}` : "not cooked yet",
    ],
  ]);
  const name = file.replace(/^assets\//u, "");
  const snippet = `const clip = await ctx.assets.audio(${JSON.stringify(name)});`;
  host.docs.replaceChildren(
    host.el("h2", "text-xl font-extrabold text-white", element.name),
    host.el("p", "text-muted", file),
    host.el("pre", "rounded border border-line bg-sidebar p-3 font-mono text-xs", snippet),
    host.copyButton("Copy snippet", () => snippet),
  );
  host.say(`${element.name} · ${buffer.duration.toFixed(2)} s · ${buffer.sampleRate} Hz`);
  return {
    playing: () => Boolean(source),
    tick: draw,
    leave() {
      stop();
      void context.close();
    },
    async sheet() {
      draw();
      return wave;
    },
  };
}
