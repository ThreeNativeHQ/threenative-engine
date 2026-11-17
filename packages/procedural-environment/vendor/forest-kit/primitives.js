// Shared low-level shapes: blades, stems, tubes, discs. Everything appends to a GeoBuilder.

const WHITE = [1, 1, 1];

/** Two unit vectors perpendicular to unit vector d (and to each other). */
function perp(dx, dy, dz) {
  // cross(d, helper) with helper = X when d is near-vertical, else Y
  let ax, ay, az;
  if (Math.abs(dy) > 0.9) { ax = 0; ay = dz; az = -dy; } else { ax = -dz; ay = 0; az = dx; }
  const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
  return [ax, ay, az, dy * az - dz * ay, dz * ax - dx * az, dx * ay - dy * ax];
}

/**
 * A grass-like blade: a tapered strip following an arc.
 *   lean  — horizontal reach of the tip, as a fraction of height
 *   curve — 1 = straight lean, 2+ = stays upright then arches over
 *   droop — tip sag (0…0.5)
 *   tip   — tip width as a fraction of base width (0 = pointed)
 */
export function addBlade(b, o) {
  const { x = 0, y = 0, z = 0, yaw = 0, height, width, lean = 0.3, curve = 2, droop = 0, segs = 3, twist = 0, tip = 0, flex = 1, bright = 1, pal, upBias = 0.5, dryTip = null } = o;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  let pl = -1, pr = -1;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, tc = Math.max(t, 1e-3);
    const reach = lean * height * Math.pow(t, curve);
    const py = y + height * (t - droop * t * t * t);
    const cx = x + dx * reach, cz = z + dz * reach;
    // tangent of the arc
    const dR = lean * height * curve * Math.pow(tc, curve - 1), dY = height * (1 - 3 * droop * t * t);
    let tx = dx * dR, ty = dY, tz = dz * dR;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const a = yaw + Math.PI / 2 + twist * t, sx = Math.cos(a), sz = Math.sin(a);
    // face normal = side × tangent, flipped upward, then biased toward the sky for soft shading
    let nx = -sz * ty, ny = sz * tx - sx * tz, nz = sx * ty;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    nx *= 0.5; ny = ny * 0.5 + upBias; nz *= 0.5;
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    const c = t < 0.5 ? mix3(pal.root, pal.mid, smooth(Math.max(0, t - 0.06) / 0.44)) : mix3(pal.mid, pal.tip, smooth((t - 0.5) / 0.5));
    if (dryTip && t > 0.7) { const k = (t - 0.7) / 0.3; c[0] += (dryTip[0] - c[0]) * k; c[1] += (dryTip[1] - c[1]) * k; c[2] += (dryTip[2] - c[2]) * k; }
    const r = c[0] * bright, g = c[1] * bright, bl = c[2] * bright;
    const wind = Math.pow(t, 1.5) * height * flex;
    const w = width * (1 - (1 - tip) * Math.pow(t, 1.8)) * 0.5;
    if (i === segs && tip === 0) {
      const v = b.v(cx, py, cz, nx, ny, nz, r, g, bl, 0.5, 1, wind);
      b.tri(pl, pr, v);
      return;
    }
    const l = b.v(cx - sx * w, py, cz - sz * w, nx, ny, nz, r, g, bl, 0, t, wind);
    const rr = b.v(cx + sx * w, py, cz + sz * w, nx, ny, nz, r, g, bl, 1, t, wind);
    if (i > 0) b.quad(pl, pr, rr, l);
    pl = l; pr = rr;
  }
}

const smooth = (t) => t * t * (3 - 2 * t);
function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/** Thin stem as two crossed strips from p0 to p1 (visible from every side). */
export function addStem(b, p0, p1, width, c0, c1 = c0, wind0 = 0, wind1 = 0) {
  const ex = p1[0] - p0[0], ey = p1[1] - p0[1], ez = p1[2] - p0[2];
  const il = 1 / (Math.hypot(ex, ey, ez) || 1);
  const [ax, ay, az, bx, by, bz] = perp(ex * il, ey * il, ez * il);
  const h = width / 2, n = [0, 1, 0];
  for (const [sx, sy, sz] of [[ax, ay, az], [bx, by, bz]]) {
    const a = b.v(p0[0] - sx * h, p0[1] - sy * h, p0[2] - sz * h, n[0], n[1], n[2], c0[0], c0[1], c0[2], 0, 0, wind0);
    const c = b.v(p0[0] + sx * h, p0[1] + sy * h, p0[2] + sz * h, n[0], n[1], n[2], c0[0], c0[1], c0[2], 1, 0, wind0);
    const d = b.v(p1[0] + sx * h, p1[1] + sy * h, p1[2] + sz * h, n[0], n[1], n[2], c1[0], c1[1], c1[2], 1, 1, wind1);
    const e = b.v(p1[0] - sx * h, p1[1] - sy * h, p1[2] - sz * h, n[0], n[1], n[2], c1[0], c1[1], c1[2], 0, 1, wind1);
    b.quad(a, c, d, e);
  }
}

/** Spindle (two crossed diamonds) — seed heads, buds, plumes, florets. */
export function addSpindle(b, base, dir, length, width, c0, c1 = c0, wind = 0) {
  const [dx, dy, dz] = dir;
  const [ax, ay, az, bx, by, bz] = perp(dx, dy, dz);
  const mx = base[0] + dx * length * 0.42, my = base[1] + dy * length * 0.42, mz = base[2] + dz * length * 0.42;
  const tipp = [base[0] + dx * length, base[1] + dy * length, base[2] + dz * length], h = width / 2;
  for (const [sx, sy, sz] of [[ax, ay, az], [bx, by, bz]]) {
    const v0 = b.v(base[0], base[1], base[2], 0, 1, 0, c0[0], c0[1], c0[2], 0.5, 0, wind);
    const v1 = b.v(mx - sx * h, my - sy * h, mz - sz * h, -sx * 0.4, 0.9, -sz * 0.4, c1[0], c1[1], c1[2], 0, 0.5, wind);
    const v2 = b.v(mx + sx * h, my + sy * h, mz + sz * h, sx * 0.4, 0.9, sz * 0.4, c1[0], c1[1], c1[2], 1, 0.5, wind);
    const v3 = b.v(tipp[0], tipp[1], tipp[2], 0, 1, 0, c1[0], c1[1], c1[2], 0.5, 1, wind);
    b.tri(v0, v1, v2); b.tri(v1, v3, v2);
  }
}

/**
 * Generalised cylinder through `pts` ([{x,y,z,r}]). Front faces point outward.
 *   colorAt(i, pt, k/radial) → [r,g,b];  windAt(i, pt) → number
 */
export function addTube(b, pts, radial, o = {}) {
  const { color = WHITE, colorAt = null, windAt = null, vScale = 1, uRepeat = 1, v0 = 0, capStart = null, capEnd = null } = o;
  const n = pts.length;
  let rx = 0.13, ry = 0.21, rz = 0.97; // reference vector, parallel-transported
  let v = v0, prevRing = -1;
  for (let i = 0; i < n; i++) {
    const p = pts[i], pa = pts[Math.max(i - 1, 0)], pb = pts[Math.min(i + 1, n - 1)];
    let tx = pb.x - pa.x, ty = pb.y - pa.y, tz = pb.z - pa.z;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    let d = rx * tx + ry * ty + rz * tz;
    let nx = rx - tx * d, ny = ry - ty * d, nz = rz - tz * d;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) { nx = ty; ny = -tx; nz = 0.01; nl = Math.hypot(nx, ny, nz); }
    nx /= nl; ny /= nl; nz /= nl;
    rx = nx; ry = ny; rz = nz;
    const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
    if (i > 0) v += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z) * vScale;
    const wind = windAt ? windAt(i, p) : 0;
    const ring = b.vertexCount;
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const ox = nx * ca + bx * sa, oy = ny * ca + by * sa, oz = nz * ca + bz * sa;
      const c = colorAt ? colorAt(i, p, k / radial, oy) : color;
      b.v(p.x + ox * p.r, p.y + oy * p.r, p.z + oz * p.r, ox, oy, oz, c[0], c[1], c[2], (k / radial) * uRepeat, v, wind);
    }
    if (prevRing >= 0) {
      for (let k = 0; k < radial; k++) {
        const a = prevRing + k, bb = prevRing + k + 1, c = ring + k, dd = ring + k + 1;
        b.tri(a, bb, c); b.tri(bb, dd, c);
      }
    }
    if ((i === 0 && capStart) || (i === n - 1 && capEnd)) {
      const col = i === 0 ? capStart : capEnd, sgn = i === 0 ? -1 : 1;
      const cv = b.v(p.x, p.y, p.z, tx * sgn, ty * sgn, tz * sgn, col[0], col[1], col[2], 0.5, 0.5, wind);
      const first = b.vertexCount;
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        const ox = nx * ca + bx * sa, oy = ny * ca + by * sa, oz = nz * ca + bz * sa;
        b.v(p.x + ox * p.r, p.y + oy * p.r, p.z + oz * p.r, tx * sgn, ty * sgn, tz * sgn, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, 0.5 + ca * 0.5, 0.5 + sa * 0.5, wind);
      }
      for (let k = 0; k < radial; k++) sgn > 0 ? b.tri(cv, first + k, first + k + 1) : b.tri(cv, first + k + 1, first + k);
    }
    prevRing = ring;
  }
  return v;
}

/**
 * Flat radial flower head / rosette: `petals` rhombi around a centre.
 * facing = unit normal of the bloom; cup lifts petal tips.
 */
export function addBloom(b, c, facing, radius, petals, colPetal, colTip, colCentre, o = {}) {
  const { cup = 0.2, petalWidth = 0.8, centre = 0.3, wind = 0, phase = 0 } = o;
  const [fx, fy, fz] = facing;
  const [ax, ay, az, bx, by, bz] = perp(fx, fy, fz);
  const P = (a, r, lift) => [c[0] + (ax * Math.cos(a) + bx * Math.sin(a)) * r + fx * lift, c[1] + (ay * Math.cos(a) + by * Math.sin(a)) * r + fy * lift, c[2] + (az * Math.cos(a) + bz * Math.sin(a)) * r + fz * lift];
  const n = [fx * 0.6, fy * 0.6 + 0.6, fz * 0.6], nl = Math.hypot(n[0], n[1], n[2]);
  n[0] /= nl; n[1] /= nl; n[2] /= nl;
  const half = (Math.PI / petals) * petalWidth;
  for (let i = 0; i < petals; i++) {
    const a = phase + (i / petals) * Math.PI * 2;
    const p0 = P(a, radius * centre * 0.5, 0), p1 = P(a - half, radius * 0.62, radius * cup * 0.5), p2 = P(a, radius, radius * cup), p3 = P(a + half, radius * 0.62, radius * cup * 0.5);
    const v0 = b.v(p0[0], p0[1], p0[2], n[0], n[1], n[2], colPetal[0], colPetal[1], colPetal[2], 0.5, 0, wind);
    const v1 = b.v(p1[0], p1[1], p1[2], n[0], n[1], n[2], colPetal[0], colPetal[1], colPetal[2], 0, 0.6, wind);
    const v2 = b.v(p2[0], p2[1], p2[2], n[0], n[1], n[2], colTip[0], colTip[1], colTip[2], 0.5, 1, wind);
    const v3 = b.v(p3[0], p3[1], p3[2], n[0], n[1], n[2], colPetal[0], colPetal[1], colPetal[2], 1, 0.6, wind);
    b.tri(v0, v1, v2); b.tri(v0, v2, v3);
  }
  if (colCentre) {
    const lift = radius * (0.06 + cup * 0.2), cv = b.v(c[0] + fx * lift * 2, c[1] + fy * lift * 2, c[2] + fz * lift * 2, n[0], n[1], n[2], colCentre[0], colCentre[1], colCentre[2], 0.5, 0.5, wind);
    const first = b.vertexCount;
    for (let k = 0; k <= 6; k++) { const p = P((k / 6) * Math.PI * 2, radius * centre, lift); b.v(p[0], p[1], p[2], n[0], n[1], n[2], colCentre[0] * 0.8, colCentre[1] * 0.8, colCentre[2] * 0.8, 0.5, 0.5, wind); }
    for (let k = 0; k < 6; k++) b.tri(cv, first + k, first + k + 1);
  }
}

/**
 * A simple leaf, folded slightly along the midrib. base → tip along `dir`,
 * lying in the plane spanned by dir and `side`.
 * detail 0 = 4-triangle diamond (LODs), 1 = 8-triangle rounded oval.
 */
export function addLeaf(b, base, dir, side, length, width, c0, c1, o = {}) {
  const { fold = 0.25, wind = 0, wind1 = wind, normal = null, detail = 0 } = o;
  const [dx, dy, dz] = dir, [sx, sy, sz] = side;
  // leaf normal = side × dir, flipped to face up
  let nx = sy * dz - sz * dy, ny = sz * dx - sx * dz, nz = sx * dy - sy * dx;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const N = normal ?? [nx * 0.6, ny * 0.6 + 0.5, nz * 0.6];
  const nl = Math.hypot(N[0], N[1], N[2]) || 1, n0 = N[0] / nl, n1 = N[1] / nl, n2 = N[2] / nl;
  const f = fold * width;
  const put = (u, w, lift, c, vx) => b.v(
    base[0] + dx * length * u + sx * width * w + nx * lift, base[1] + dy * length * u + sy * width * w + ny * lift, base[2] + dz * length * u + sz * width * w + nz * lift,
    n0, n1, n2, c[0], c[1], c[2], vx, u, wind + (wind1 - wind) * u);
  // stations along the midrib: [u, half-width]
  const st = detail ? [[0.3, 0.46], [0.66, 0.4]] : [[0.42, 0.5]];
  let pm = put(0, 0, 0, c0, 0.5), pl = pm, pr = pm;
  for (const [u, w] of st) {
    const m = put(u, 0, 0, c0, 0.5), l = put(u, -w, f * w * 2, c1, 0), r = put(u, w, f * w * 2, c1, 1);
    if (pl === pm) { b.tri(pm, l, m); b.tri(pm, m, r); } else { b.quad(pl, l, m, pm); b.quad(pm, m, r, pr); }
    pm = m; pl = l; pr = r;
  }
  const t = put(1, 0, f * 0.3, c1, 0.5);
  b.tri(pl, t, pm); b.tri(pm, t, pr);
}
