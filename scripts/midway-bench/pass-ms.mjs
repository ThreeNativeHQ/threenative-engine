#!/usr/bin/env node
/**
 * Per-pass GPU ms of one Midway pose, measured at the WebGPU API so the Wasm engine and stock three.js
 * go through the SAME instrument. It wraps `beginRenderPass`/`beginComputePass` to write its own timestamp
 * pair around every pass (replacing the page's own pair), resolves each encoder's pairs before `finish`
 * and reads them after `submit`. Neither arm's frame meter is involved, so a meter difference cannot show up.
 *
 *   sh scripts/xvfb.sh node scripts/midway-bench/pass-ms.mjs --url http://127.0.0.1:5602/ --pose reargun
 *
 * Poses: cruise (airborne start), cockpit (C), reargun (C then Y). Prints JSON: per pass label the GPU ms
 * per presented frame, its passes per frame and the median pass time, and the total per presented frame.
 * A presented frame is one `GPUCanvasContext.getCurrentTexture` call, which both back ends make once per frame.
 */
import { chromium } from "@playwright/test";

// The playtest runner's WebGPU recipe and its uncapped-frame-rate performance flags (packages/playtest/src/runner/browser.ts).
const WEBGPU_BROWSER_ARGS = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
];
const PERFORMANCE_BROWSER_ARGS = ["--disable-frame-rate-limit", "--disable-gpu-vsync"];

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const url = arg("url");
if (!url)
  throw new Error(
    "usage: pass-ms.mjs --url <url> [--pose cruise|cockpit|reargun] [--seconds 6] [--settle 12]",
  );
const pose = arg("pose", "reargun");
const seconds = Number(arg("seconds", 6));
const settleMs = Number(arg("settle", 12)) * 1000;

const PLAIN = process.argv.includes("--plain");
// --pace <hz>: hand the page one animation frame per 1/hz slot, so both arms present at the same cadence and the
// GPU sees the same duty cycle; without it an uncapped page floods the queue and keeps the GPU at its top clock.
const PACE = Number(arg("pace", 0));
const PACER = `(() => {
  const hz = ${PACE};
  const raf = window.requestAnimationFrame.bind(window);
  const slot = () => Math.floor(performance.now() / (1000 / hz));
  window.requestAnimationFrame = (cb) => {
    const born = slot();
    const tick = (t) => (slot() > born ? cb(t) : raf(tick));
    return raf(tick);
  };
})();`;
// --plain: count presented frames only (no timestamps, no readbacks), to see the page's own frame rate.
const COUNTER = `(() => {
  const state = (globalThis.__tnPass = { on: false, frames: 0, inflight: 0, passes: new Map(), errors: [] });
  const o = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () { if (state.on) state.frames++; if (state.on) state.timeline.push([performance.now(), "gct"]); return o.call(this); };
  state.timeline = [];
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (c) { if (state.on) state.timeline.push([performance.now(), "submit"]); return submit.call(this, c); };
  const swd = GPUQueue.prototype.onSubmittedWorkDone;
  GPUQueue.prototype.onSubmittedWorkDone = function () { if (state.on) state.timeline.push([performance.now(), "swd"]); const p = swd.call(this); return p.then((v) => { if (state.on) state.timeline.push([performance.now(), "swd-done"]); return v; }); };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { if (state.on) state.timeline.push([performance.now(), "raf"]); cb(t); if (state.on) state.timeline.push([performance.now(), "raf-end"]); });
})();`;
const INSTRUMENT = `(() => {
  const state = (globalThis.__tnPass = { on: false, frames: 0, inflight: 0, passes: new Map(), errors: [] });
  const wrap = (proto, name, make) => {
    const original = proto[name];
    proto[name] = make(original);
  };
  const textures = new WeakMap();
  const views = new WeakMap();
  const encoders = new WeakMap();
  const buffers = new WeakMap();
  const sets = new WeakMap();
  let slot = 0;
  const SLOTS = 2048;
  wrap(GPUDevice.prototype, "createTexture", (o) => function (d) { const t = o.call(this, d); textures.set(t, d); return t; });
  wrap(GPUTexture.prototype, "createView", (o) => function (d) { const v = o.call(this, d); views.set(v, this); return v; });
  wrap(GPUDevice.prototype, "createCommandEncoder", (o) => function (d) { const e = o.call(this, d); encoders.set(e, { device: this, passes: [] }); return e; });
  wrap(GPUCanvasContext.prototype, "getCurrentTexture", (o) => function () { if (state.on) state.frames++; return o.call(this); });
  const querySet = (device) => {
    let q = sets.get(device);
    if (!q) { q = device.features.has("timestamp-query") ? device.createQuerySet({ type: "timestamp", count: SLOTS * 2 }) : null; sets.set(device, q); }
    return q;
  };
  const describe = (d, compute) => {
    if (compute) return "compute " + (d.label || "");
    const c = d.colorAttachments && d.colorAttachments[0];
    const tex = c && c.view ? views.get(c.view) : undefined;
    const dtex = d.depthStencilAttachment && d.depthStencilAttachment.view ? views.get(d.depthStencilAttachment.view) : undefined;
    const t = tex || dtex;
    const dims = t ? (t.width + "x" + t.height + " s" + t.sampleCount) : "?";
    const n = (d.colorAttachments || []).filter(Boolean).length;
    return (d.label ? d.label + " " : "") + dims + " c" + n + (dtex ? " d" : "") + (c && c.resolveTarget ? " resolve" : "");
  };
  const begin = (name, compute) => wrap(GPUCommandEncoder.prototype, name, (o) => function (d) {
    const info = encoders.get(this);
    const q = state.on && info ? querySet(info.device) : null;
    if (!q) return o.call(this, d);
    const s = slot++ % SLOTS;
    info.passes.push({ slot: s, label: describe(d || {}, compute) });
    return o.call(this, { ...(d || {}), timestampWrites: { querySet: q, beginningOfPassWriteIndex: s * 2, endOfPassWriteIndex: s * 2 + 1 } });
  });
  begin("beginRenderPass", false);
  begin("beginComputePass", true);
  wrap(GPUCommandEncoder.prototype, "finish", (o) => function (d) {
    const info = encoders.get(this);
    if (info && info.passes.length > 0) {
      const q = sets.get(info.device);
      const n = info.passes.length;
      const resolve = info.device.createBuffer({ size: 256 * n, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const read = info.device.createBuffer({ size: 16 * n, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      info.passes.forEach((p, i) => { this.resolveQuerySet(q, p.slot * 2, 2, resolve, 256 * i); this.copyBufferToBuffer(resolve, 256 * i, read, 16 * i, 16); });
      const cb = o.call(this, d);
      buffers.set(cb, { read, resolve, passes: info.passes });
      info.passes = [];
      return cb;
    }
    return o.call(this, d);
  });
  wrap(GPUQueue.prototype, "submit", (o) => function (cbs) {
    const r = o.call(this, cbs);
    for (const cb of cbs) {
      const b = buffers.get(cb);
      if (!b) continue;
      buffers.delete(cb);
      state.inflight++;
      b.read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(b.read.getMappedRange().slice(0));
        b.passes.forEach((p, i) => {
          const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
          if (!(ms >= 0 && ms < 500)) { state.errors.push(p.label + " " + ms); return; }
          const e = state.passes.get(p.label) || { total: 0, n: 0, all: [] };
          e.total += ms; e.n++; if (e.all.length < 20000) e.all.push(ms);
          state.passes.set(p.label, e);
        });
        b.read.unmap(); b.read.destroy(); b.resolve.destroy();
      }).catch((e) => state.errors.push(String(e))).finally(() => { state.inflight--; });
    }
    return r;
  });
})();`;

const browser = await chromium.launch({
  headless: false,
  args: [...WEBGPU_BROWSER_ARGS, ...PERFORMANCE_BROWSER_ARGS, "--enable-webgpu-developer-features"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  if (PACE > 0) await page.addInitScript(PACER);
  await page.addInitScript(PLAIN ? COUNTER : INSTRUMENT);
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text().slice(0, 300));
  });
  await page.goto(url);
  const adapter = await page.evaluate(async () => {
    const info = (await navigator.gpu.requestAdapter())?.info ?? {};
    return ["vendor", "architecture", "device", "description"].map((k) => info[k] ?? "").join(" ");
  });
  await page.click("#start-air", { timeout: 300_000 });
  await page.waitForTimeout(settleMs);
  if (pose !== "cruise") {
    await page.keyboard.press("c");
    await page.waitForTimeout(2000);
  }
  if (pose === "reargun") {
    await page.keyboard.press("y");
    await page.waitForTimeout(3000);
  }
  await page.evaluate(() => {
    globalThis.__tnPass.on = true;
  });
  await page.waitForTimeout(seconds * 1000);
  await page.evaluate(() => {
    globalThis.__tnPass.on = false;
  });
  await page.waitForTimeout(2500);
  const result = await page.evaluate(() => {
    const s = globalThis.__tnPass;
    const med = (a) => {
      const b = [...a].sort((x, y) => x - y);
      return b.length ? b[Math.floor(b.length / 2)] : 0;
    };
    const rows = [...s.passes].map(([label, e]) => ({
      label,
      msPerFrame: e.total / s.frames,
      passesPerFrame: e.n / s.frames,
      medianPassMs: med(e.all),
      meanPassMs: e.total / e.n,
    }));
    rows.sort((a, b) => b.msPerFrame - a.msPerFrame);
    return {
      timeline: (s.timeline || []).slice(-120).map(([t, k]) => `${k}@${t.toFixed(1)}`),
      frames: s.frames,
      inflight: s.inflight,
      errors: s.errors.slice(0, 5),
      onFlag: s.on,
      totalMsPerFrame: rows.reduce((t, r) => t + r.msPerFrame, 0),
      rows,
    };
  });
  console.log(
    JSON.stringify({ url, pose, adapter, pageErrors: pageErrors.slice(0, 5), ...result }, null, 1),
  );
} finally {
  await browser.close();
}
