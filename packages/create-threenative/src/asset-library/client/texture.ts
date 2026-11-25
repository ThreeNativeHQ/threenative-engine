// The texture and PBR map viewer: a 2D inspector drawn by the shell's own renderer, so a `.ktx2`
// and a `.png` take the same path. Channel, tiling and checkerboard are shader uniforms.
import * as three from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { SURFACE_CHANNELS } from "../../../../terrain/src/editor/images.js";
import type { IAssetElement } from "../types.js";
import {
  type IFileStats,
  type IViewerHost,
  type IViewerMode,
  fileUrl,
  getJson,
  mb,
} from "./viewers.js";

interface ITextureInfo {
  readonly path: string;
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly raw: IFileStats;
  readonly cooked?: IFileStats & { readonly output: string; readonly format?: string };
}

const CHANNELS = ["rgba", "r", "g", "b", "a", "normal"] as const;

/** The surface channel a file name says it is (`rock_normal.png` → normal), per Strata's semantics. */
export function surfaceChannel(file: string): keyof typeof SURFACE_CHANNELS | undefined {
  const name = file.toLowerCase();
  const words: [keyof typeof SURFACE_CHANNELS, RegExp][] = [
    ["normal", /(normal|_nrm|_nor\b|_n\.)/u],
    ["roughness", /(rough|_rgh)/u],
    ["metalness", /(metal|_mtl)/u],
    ["ao", /(_ao\b|_ao\.|occlusion)/u],
    ["height", /(height|disp|bump)/u],
    ["opacity", /(opacity|alpha|mask)/u],
    ["albedo", /(albedo|basecolor|base_color|diffuse|_col|color)/u],
  ];
  return words.find(([, pattern]) => pattern.test(name))?.[0];
}

/** Why a size would compress or mip badly: block compression wants multiples of 4, mips want powers of two. */
export function textureWarnings(width: number, height: number): string[] {
  const warnings: string[] = [];
  if (width % 4 !== 0 || height % 4 !== 0)
    warnings.push(`${width}×${height} is not a multiple of 4: BC/ASTC block compression pads it`);
  const pow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;
  if (!pow2(width) || !pow2(height)) warnings.push("not a power of two: mipmaps resample it");
  if (Math.max(width, height) > 4096) warnings.push("larger than 4096: many mobile GPUs refuse it");
  return warnings;
}

let ktx2: KTX2Loader | undefined;

async function load(host: IViewerHost, url: string, file: string): Promise<three.Texture> {
  if (file.toLowerCase().endsWith(".ktx2")) {
    ktx2 ??= new KTX2Loader()
      .setTranscoderPath(`${host.base}basis/`)
      .detectSupport(host.view.renderer);
    return ktx2.loadAsync(url);
  }
  return new three.TextureLoader().loadAsync(url);
}

export async function textureView(element: IAssetElement, host: IViewerHost): Promise<IViewerMode> {
  const file = element.path ?? element.id;
  const [info, texture] = await Promise.all([
    getJson<ITextureInfo>(`${host.api}project/info?path=${encodeURIComponent(file)}`),
    load(host, fileUrl(host, file), file),
  ]);
  const channel = surfaceChannel(file);
  texture.colorSpace =
    channel && SURFACE_CHANNELS[channel] === "linear" ? three.NoColorSpace : three.SRGBColorSpace;
  texture.wrapS = texture.wrapT = three.RepeatWrapping;
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = info.width ?? image?.width ?? 0;
  const height = info.height ?? image?.height ?? 0;
  const uniforms = {
    map: { value: texture },
    channel: { value: channel === "normal" ? 5 : 0 },
    repeat: { value: 1 },
    zoom: { value: 1 },
    pan: { value: new three.Vector2() },
    aspect: { value: new three.Vector2(1, 1) },
    linear: { value: texture.colorSpace === three.NoColorSpace ? 1 : 0 },
  };
  const material = new three.ShaderMaterial({
    uniforms,
    vertexShader:
      "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `
      uniform sampler2D map; uniform int channel; uniform float repeat; uniform float zoom;
      uniform vec2 pan; uniform vec2 aspect; uniform int linear; varying vec2 vUv;
      void main() {
        vec2 p = ((vUv - 0.5) * aspect / zoom + pan) * repeat + 0.5;
        vec2 cell = floor(gl_FragCoord.xy / 12.0);
        vec3 checker = mix(vec3(0.22), vec3(0.32), mod(cell.x + cell.y, 2.0));
        bool outside = repeat < 1.5 && (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0);
        vec4 t = texture2D(map, fract(p));
        vec3 rgb = t.rgb; float a = t.a;
        if (channel == 1) { rgb = vec3(t.r); a = 1.0; }
        else if (channel == 2) { rgb = vec3(t.g); a = 1.0; }
        else if (channel == 3) { rgb = vec3(t.b); a = 1.0; }
        else if (channel == 4) { rgb = vec3(t.a); a = 1.0; }
        else if (channel == 5) {
          vec3 n = normalize(t.rgb * 2.0 - 1.0);
          float lit = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0);
          rgb = vec3(0.12) + vec3(0.88) * lit; a = 1.0;
        }
        vec3 color = outside ? vec3(0.13) : mix(checker, rgb, a);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const quad = new three.Mesh(new three.PlaneGeometry(2, 2), material);
  const scene = new three.Scene();
  scene.add(quad);
  const camera = new three.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const canvas = host.view.renderer.domElement;

  const fit = () => {
    const view = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const tex = width / Math.max(1, height);
    uniforms.aspect.value.set(view > tex ? view / tex : 1, view > tex ? 1 : tex / view);
    host.invalidate();
  };
  fit();
  // Zoom on the wheel, pan by dragging; the 3D orbit is off while a texture is shown.
  const orbitWasEnabled = canvas.style.cursor;
  canvas.style.cursor = "grab";
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    uniforms.zoom.value = three.MathUtils.clamp(
      uniforms.zoom.value * (event.deltaY > 0 ? 0.9 : 1.1),
      0.1,
      64,
    );
    host.invalidate();
  };
  let drag: { x: number; y: number } | undefined;
  const onDown = (event: PointerEvent) => {
    event.stopImmediatePropagation();
    drag = { x: event.clientX, y: event.clientY };
  };
  const onMove = (event: PointerEvent) => {
    if (!drag) return;
    event.stopImmediatePropagation();
    const scale = 1 / (uniforms.zoom.value * canvas.clientHeight);
    uniforms.pan.value.x -= (event.clientX - drag.x) * scale * uniforms.aspect.value.y;
    uniforms.pan.value.y += (event.clientY - drag.y) * scale * uniforms.aspect.value.y;
    drag = { x: event.clientX, y: event.clientY };
    host.invalidate();
  };
  const onUp = () => {
    drag = undefined;
  };
  canvas.addEventListener("wheel", onWheel, { capture: true, passive: false });
  canvas.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointermove", onMove, { capture: true });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("resize", fit);

  const bar = host.overlay(
    "top-2 right-2 flex flex-wrap items-center gap-1 rounded border border-line bg-app/90 p-1.5",
  );
  const segment = (
    label: string,
    values: readonly string[],
    current: string,
    pick: (v: string) => void,
  ) => {
    const group = host.el("div", "flex gap-0.5");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const value of values) {
      const b = host.el(
        "button",
        "rounded px-2 py-0.5 text-xs uppercase text-muted aria-pressed:bg-raised aria-pressed:text-white",
        value,
      );
      b.setAttribute("aria-pressed", String(value === current));
      b.onclick = () => {
        for (const other of group.children) other.setAttribute("aria-pressed", String(other === b));
        pick(value);
        host.invalidate();
      };
      group.append(b);
    }
    return group;
  };
  bar.append(
    segment("Channel", CHANNELS, CHANNELS[uniforms.channel.value] ?? "rgba", (v) => {
      uniforms.channel.value = CHANNELS.indexOf(v as (typeof CHANNELS)[number]);
    }),
    segment("Tiling", ["1×", "3×3"], "1×", (v) => {
      uniforms.repeat.value = v === "1×" ? 1 : 3;
    }),
    host.copyButton("Reset view", () => {
      uniforms.zoom.value = 1;
      uniforms.pan.value.set(0, 0);
      host.invalidate();
      return file;
    }),
  );

  const warnings = width && height ? textureWarnings(width, height) : [];
  const rows: [string, string][] = [
    ["Dimensions", width && height ? `${width} × ${height}` : "unknown"],
    [
      "Surface channel",
      channel ? `${channel} (${SURFACE_CHANNELS[channel]})` : "unknown from the name",
    ],
    ["Format", info.format ?? file.split(".").pop() ?? ""],
    ["Raw file", `${mb(info.raw.bytes)}${info.raw.vram ? ` · ~${mb(info.raw.vram)} VRAM` : ""}`],
    [
      "Cooked file",
      info.cooked
        ? `${mb(info.cooked.bytes)} (${Math.round((100 * info.cooked.bytes) / Math.max(1, info.raw.bytes))}%) · ${info.cooked.output}${info.cooked.vram ? ` · ~${mb(info.cooked.vram)} VRAM` : ""}`
        : "not cooked yet (run pnpm dev)",
    ],
    ["Block-size", warnings.length ? warnings.join("; ") : "aligned (multiple of 4, power of two)"],
  ];
  host.rowsInto(host.stats, rows);
  const name = file.replace(/^assets\//u, "");
  const snippet = `const texture = await ctx.assets.texture(${JSON.stringify(name)});`;
  host.docs.replaceChildren(
    host.el("h2", "text-xl font-extrabold text-white", element.name),
    host.el("p", "text-muted", file),
    ...warnings.map((w) => host.el("p", "text-doc", `● ${w}`)),
    host.el("pre", "rounded border border-line bg-sidebar p-3 font-mono text-xs", snippet),
    host.copyButton("Copy snippet", () => snippet),
  );
  host.say(
    `${element.name} · ${width}×${height}${warnings.length ? ` · ${warnings.length} warning(s)` : ""}`,
  );

  return {
    render() {
      host.view.renderer.render(scene, camera);
      return true;
    },
    leave() {
      canvas.removeEventListener("wheel", onWheel, { capture: true });
      canvas.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("resize", fit);
      canvas.style.cursor = orbitWasEnabled;
      material.dispose();
      quad.geometry.dispose();
      texture.dispose();
    },
    async sheet() {
      // One labelled cell per channel view: RGBA, the surface's own channel, alpha and 3×3 tiling.
      const views: [string, number, number][] = [
        ["RGBA", 0, 1],
        [channel === "normal" ? "Normal (lit)" : "Red", channel === "normal" ? 5 : 1, 1],
        ["Alpha", 4, 1],
        ["Tiled 3×3", 0, 3],
      ];
      const { width: w, height: h } = canvas;
      const out = document.createElement("canvas");
      out.width = w * 2;
      out.height = h * 2;
      const ctx = out.getContext("2d") as CanvasRenderingContext2D;
      for (const [i, [label, ch, rep]] of views.entries()) {
        uniforms.channel.value = ch;
        uniforms.repeat.value = rep;
        host.view.renderer.render(scene, camera);
        ctx.drawImage(canvas, (i % 2) * w, Math.floor(i / 2) * h);
        ctx.fillStyle = "rgba(2,4,7,0.72)";
        ctx.fillRect((i % 2) * w + 8, Math.floor(i / 2) * h + 8, 170, 30);
        ctx.fillStyle = "#e0fb50";
        ctx.font = "bold 18px sans-serif";
        ctx.fillText(label, (i % 2) * w + 16, Math.floor(i / 2) * h + 30);
      }
      uniforms.channel.value = channel === "normal" ? 5 : 0;
      uniforms.repeat.value = 1;
      return out;
    },
  };
}
