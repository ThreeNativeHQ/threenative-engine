// One table of the numbers the owner's complaint is about: relief, slope, drainage, spikes, bake time.
const { mkdir, writeFile } = await import("node:fs/promises");
const t0 = Date.now();
const worlds = await import("./bake.mjs");
const loadMs = Date.now() - t0;

const { hypot } = Math;
const NAMES = ["forest", "coastal", "alpine", "desert", "tundra"];
const NEIGHBOURS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];
const round = (v) => Math.round(v * 10) / 10;
const pct = (a, b) => Math.round((a / b) * 1000) / 10;

function stats(state) {
  const n = state.resolution;
  const cell = state.size / (n - 1);
  const h = state.height;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of h) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  let steep30 = 0;
  let steep45 = 0;
  let spikes = 0;
  let worst = 0;
  let cells = 0;
  for (let z = 1; z < n - 1; z += 1)
    for (let x = 1; x < n - 1; x += 1) {
      const i = z * n + x;
      const hv = h[i];
      let maxNeighbour = Number.NEGATIVE_INFINITY;
      let sum = 0;
      for (const [dx, dz] of NEIGHBOURS) {
        const v = h[(z + dz) * n + x + dx];
        if (v > maxNeighbour) maxNeighbour = v;
        sum += v;
      }
      const prominence = hv - sum / 8;
      if (hv > maxNeighbour && prominence > 1) {
        spikes += 1;
        worst = Math.max(worst, prominence);
      }
      const grade = hypot(h[i + 1] - h[i - 1], h[i + n] - h[i - n]) / (2 * cell);
      const slope = (Math.atan(grade) * 180) / Math.PI;
      if (slope > 30) steep30 += 1;
      if (slope > 45) steep45 += 1;
      cells += 1;
    }
  // Upstream area: push each cell's area downslope, high cells first.
  const area = new Float64Array(h.length).fill(1);
  const order = Array.from({ length: h.length }, (_v, i) => i).sort((a, b) => h[b] - h[a]);
  for (const i of order) {
    const z = Math.floor(i / n);
    const x = i - z * n;
    if (x === 0 || z === 0 || x === n - 1 || z === n - 1) continue;
    let best = -1;
    let bestH = h[i];
    for (const [dx, dz] of NEIGHBOURS) {
      const j = (z + dz) * n + x + dx;
      if (h[j] < bestH) {
        bestH = h[j];
        best = j;
      }
    }
    if (best >= 0) area[best] += area[i];
  }
  const threshold = n / 8;
  let channels = 0;
  for (const a of area) if (a > threshold) channels += 1;
  return {
    min: round(min),
    max: round(max),
    relief: round(max - min),
    steep30: pct(steep30, cells),
    steep45: pct(steep45, cells),
    channels: pct(channels, cells),
    spikes,
    worst: round(worst),
  };
}

const rows = [];
for (const name of NAMES) {
  const t = worlds[name];
  // The evaluator memoises by document, and bake.mjs already evaluated every world on import, so a
  // second evaluate() is a cache hit. clearCache() drops it and measures the real bake.
  const t0 = Date.now();
  t.clearCache();
  const state = t.evaluate();
  rows.push({ world: name, bakeMs: Date.now() - t0, ...stats(state) });
}
console.table(rows);
await mkdir(new URL("../artifacts/terrain/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`../artifacts/terrain/metrics-${process.argv[2] ?? "run"}.json`, import.meta.url),
  JSON.stringify({ loadMs, rows }, null, 2),
);
