// The one shape forest-kit took from three: `IcosahedronGeometry(1, detail)`, as a plain
// non-indexed position array so the generators stay dependency-free.

const T = (1 + Math.sqrt(5)) / 2;

const VERTICES = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];

// The same 20 faces, wound outward, that three's IcosahedronGeometry uses.
const FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

const unit = ([x, y, z]) => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

const middle = (a, b) => unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);

/** Non-indexed, unit-radius icosphere positions (xyz triples: 20 triangles at detail 0, 320 at 2). */
export function icosphere(detail = 0) {
  let faces = FACES.map((face) => face.map((i) => unit(VERTICES[i])));
  for (let d = 0; d < detail; d++) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = middle(a, b);
      const bc = middle(b, c);
      const ca = middle(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const out = new Float32Array(faces.length * 9);
  let o = 0;
  for (const [a, b, c] of faces)
    for (const p of [a, b, c]) {
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
      o += 3;
    }
  return out;
}
