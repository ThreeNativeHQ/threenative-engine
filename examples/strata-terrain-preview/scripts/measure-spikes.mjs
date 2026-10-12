const { forest, alpine, desert, tundra } = await import(`${process.cwd()}/scripts/bake.mjs`);
function count(s) {
  const n = s.resolution;
  let k = 0;
  let worst = 0;
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      const h = s.height[j * n + i];
      let m = -1e9;
      let sum = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const v = s.height[(j + dj) * n + i + di];
          m = Math.max(m, v);
          sum += v;
        }
      const prom = h - sum / 8;
      if (h > m && prom > 1) {
        k++;
        worst = Math.max(worst, prom);
      }
    }
  return `${k} spikes, worst ${worst.toFixed(1)} m`;
}
console.log("all:", count(forest.evaluate()));
for (const id of ["weathering", "eroded-hill", "hills"]) {
  forest.toggle(id, false);
  console.log(`-${id}:`, count(forest.evaluate()));
  forest.toggle(id, true);
}

for (const [name, terrain] of Object.entries({ alpine, desert, tundra }))
  console.log(`${name}:`, count(terrain.evaluate()));
