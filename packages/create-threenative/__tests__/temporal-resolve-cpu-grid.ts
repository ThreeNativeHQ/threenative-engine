// Test-only constant/grid TSL interpreter: executes the authored resolve's JavaScript graph.
// This supplies synthetic texture inputs, not a second implementation of clipping or blending.
export class Value {
  constructor(public values: number[]) {}
  op(other: Value | number, fn: (a: number, b: number) => number): Value {
    const b = other instanceof Value ? other.values : [other];
    return new Value(
      Array.from({ length: Math.max(this.values.length, b.length) }, (_, i) =>
        fn(this.values[i % this.values.length] ?? 0, b[i % b.length] ?? 0),
      ),
    );
  }
  add(b: Value | number) {
    return this.op(b, (x, y) => x + y);
  }
  sub(b: Value | number) {
    return this.op(b, (x, y) => x - y);
  }
  mul(b: Value | number) {
    return this.op(b, (x, y) => x * y);
  }
  div(b: Value | number) {
    return this.op(b, (x, y) => x / y);
  }
  max(b: Value | number) {
    return this.op(b, Math.max);
  }
  pow2() {
    return this.mul(this);
  }
  length() {
    return this.dot(this).sqrt();
  }
  map(fn: (x: number) => number) {
    return new Value(this.values.map(fn));
  }
  abs() {
    return this.map(Math.abs);
  }
  sqrt() {
    return this.map(Math.sqrt);
  }
  round() {
    return this.map(Math.round);
  }
  floor() {
    return this.map(Math.floor);
  }
  ceil() {
    return this.map(Math.ceil);
  }
  fract() {
    return this.map((x) => x - Math.floor(x));
  }
  exp() {
    return this.map(Math.exp);
  }
  oneMinus() {
    return this.map((x) => 1 - x);
  }
  saturate() {
    return this.clamp(0, 1);
  }
  clamp(a: Value | number, b: Value | number) {
    return this.max(a).op(b, Math.min);
  }
  greaterThan(b: Value | number) {
    return this.op(b, (x, y) => Number(x > y));
  }
  lessThan(b: Value | number) {
    return this.op(b, (x, y) => Number(x < y));
  }
  lessThanEqual(b: Value | number) {
    return this.op(b, (x, y) => Number(x <= y));
  }
  greaterThanEqual(b: Value | number) {
    return this.op(b, (x, y) => Number(x >= y));
  }
  and(b: Value) {
    return this.op(b, (x, y) => Number(Boolean(x && y)));
  }
  not() {
    return this.map((x) => Number(!x));
  }
  all() {
    return new Value([Number(this.values.every(Boolean))]);
  }
  any() {
    return new Value([Number(this.values.some(Boolean))]);
  }
  equal(b: Value | number) {
    return this.op(b, (x, y) => Number(x === y));
  }
  or(b: Value) {
    return this.op(b, (x, y) => Number(Boolean(x || y)));
  }
  select(a: Value, b: Value | number) {
    return (this.values[0] ?? 0) ? a : b instanceof Value ? b : new Value([b]);
  }
  dot(b: Value) {
    return new Value([this.mul(b).values.reduce((a, x) => a + x, 0)]);
  }
  toVar() {
    return new Value([...this.values]);
  }
  assign(b: Value | number) {
    this.values = b instanceof Value ? [...b.values] : Array(this.values.length).fill(b);
    return this;
  }
  addAssign(b: Value) {
    return this.assign(this.add(b));
  }
  mulAssign(b: Value) {
    return this.assign(this.mul(b));
  }
  get r() {
    return this.x;
  }
  get g() {
    return this.y;
  }
  get b() {
    return this.z;
  }
  get x() {
    return new Value([this.values[0] ?? 0]);
  }
  get y() {
    return new Value([this.values[1] ?? 0]);
  }
  get z() {
    return new Value([this.values[2] ?? 0]);
  }
  get a() {
    return new Value([this.values[3] ?? 1]);
  }
  get rgb() {
    return new Value(this.values.slice(0, 3));
  }
  get xyz() {
    return this.rgb;
  }
  get xy() {
    return new Value(this.values.slice(0, 2));
  }
}
const vector = (size: number, args: (Value | number)[]) => {
  const values = args.flatMap((a) => (a instanceof Value ? a.values : [a]));
  return new Value(values.length === 1 ? Array(size).fill(values[0]) : values.slice(0, size));
};
export class GridTexture {
  constructor(
    public width: number,
    public height: number,
    public pixel: (x: number, y: number) => number[],
  ) {}
  size() {
    return new Value([this.width, this.height]);
  }
  load(p: Value) {
    const x = Math.trunc(p.values[0] ?? 0);
    const y = Math.trunc(p.values[1] ?? 0);
    // WebGPU robust textureLoad returns zero outside the physical texture, unlike a sampler.
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return new Value([0, 0, 0, 0]);
    return new Value(this.pixel(x, y));
  }
  sample(uv: Value) {
    const p = uv.mul(this.size()).sub(0.5);
    const base = p.floor();
    const phase = p.fract();
    let result = new Value([0, 0, 0, 0]);
    for (let y = 0; y <= 1; y++)
      for (let x = 0; x <= 1; x++) {
        const phaseX = phase.values[0] ?? 0;
        const phaseY = phase.values[1] ?? 0;
        const weight = (x ? phaseX : 1 - phaseX) * (y ? phaseY : 1 - phaseY);
        result = result.add(
          this.load(base.add(new Value([x, y])).clamp(0, this.size().sub(1))).mul(weight),
        );
      }
    return result;
  }
}
export const cpuTSL = {
  Fn: (fn: (args: Value[]) => Value) => {
    const call = (...args: Value[]) => fn(args);
    return Object.assign(call, { setLayout: () => call });
  },
  float: (a: number | Value) => (a instanceof Value ? a.toVar() : new Value([a])),
  int: (a: number) => new Value([a]),
  vec2: (...a: (Value | number)[]) => vector(2, a),
  ivec2: (...a: (Value | number)[]) => vector(2, a).map(Math.trunc),
  vec4: (...a: (Value | number)[]) => vector(4, a),
  add: (a: Value, b: Value) => a.add(b),
  max: (a: Value, ...b: (Value | number)[]) => b.reduce<Value>((v, x) => v.max(x), a),
  mix: (a: Value | number, b: Value | number, w: Value) => {
    const x = a instanceof Value ? a : new Value([a]);
    const y = b instanceof Value ? b : new Value([b]);
    return x.mul(w.oneMinus()).add(y.mul(w));
  },
  smoothstep: (a: number, b: number, v: Value) => {
    const t = v
      .sub(a)
      .div(b - a)
      .saturate();
    return t.pow2().mul(t.mul(-2).add(3));
  },
  luminance: (v: Value) => v.dot(new Value([0.2126, 0.7152, 0.0722])),
  texture: (t: GridTexture) => t,
  uv: () => new Value([0.5, 0.5]),
  struct:
    (fields: Record<string, string>) =>
    (...values: Value[]) => ({
      get: (name: string) => values[Object.keys(fields).indexOf(name)],
    }),
};
