/**
 * Small append-only mesh builder used by every asset factory.
 * Vertex layout is the kit-wide foliage layout:
 *   position, normal, color (linear RGB), uv, aWind (metres of sway per unit wind)
 *
 * three's `build()` is cut: bakeVegetation reuses Arbor's GLB writer instead, so the arrays below
 * are the whole output.
 */
export class GeoBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.uv = []; this.wind = []; this.idx = [];
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.idx.length / 3; }

  /** Add a vertex, returns its index. */
  v(x, y, z, nx, ny, nz, r, g, b, u = 0, vv = 0, wind = 0) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.col.push(r, g, b);
    this.uv.push(u, vv); this.wind.push(wind);
    return this.pos.length / 3 - 1;
  }

  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /** Append another builder transformed by (yaw, scale, offset). */
  append(other, { x = 0, y = 0, z = 0, yaw = 0, scale = 1 } = {}) {
    const base = this.vertexCount, c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = 0; i < other.pos.length; i += 3) {
      const px = other.pos[i] * scale, py = other.pos[i + 1] * scale, pz = other.pos[i + 2] * scale;
      this.pos.push(px * c + pz * s + x, py + y, -px * s + pz * c + z);
      const nx = other.nor[i], ny = other.nor[i + 1], nz = other.nor[i + 2];
      this.nor.push(nx * c + nz * s, ny, -nx * s + nz * c);
    }
    for (const v of other.col) this.col.push(v);
    for (const v of other.uv) this.uv.push(v);
    for (const v of other.wind) this.wind.push(v * scale);
    for (const v of other.idx) this.idx.push(v + base);
    return this;
  }
}

/** sRGB 0..1 to linear: three's `Color.set('#hex')` conversion (its SRGBToLinear). */
const toLinear = (c) =>
  c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);

/** Linear-space colour triple from an sRGB hex, e.g. lin('#7fa53a'). */
export function lin(hex) {
  const v = Number.parseInt(hex.slice(1), 16);
  return [toLinear(((v >> 16) & 255) / 255), toLinear(((v >> 8) & 255) / 255), toLinear((v & 255) / 255)];
}
export function mixc(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function scalec(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
