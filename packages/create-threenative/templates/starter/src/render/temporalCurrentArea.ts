import { wgslFn } from "three/tsl";
import { CURRENT_SAMPLE_CELLS } from "./temporalCurrentFootprintMath.js";

// A clipped convex pentagon has at most nine vertices after four rectangle halfplanes; twelve
// slots leave explicit headroom. The same cells and halfplanes feed the independently tested CPU
// form. WGSL f32 rounding remains a GPU/native qualification obligation.
const cells = CURRENT_SAMPLE_CELLS.map(
  (cell) => `array<vec2<f32>,5>(${cell.map(([x, y]) => `vec2<f32>(${x},${y})`).join(",")})`,
).join(",");
export const currentSampleArea =
  wgslFn(`fn currentSampleArea(sample: u32, minimum: vec2<f32>, maximum: vec2<f32>) -> f32 {
  let cells = array<array<vec2<f32>,5>,4>(${cells});
  var polygon: array<vec2<f32>,12>; var next: array<vec2<f32>,12>; var count = 5u;
  for (var i = 0u; i < 5u; i++) { polygon[i] = cells[sample][i]; }
  for (var edge = 0u; edge < 4u; edge++) {
    let axis = edge / 2u;
    let bound = select(minimum[axis], maximum[axis], (edge % 2u) == 1u);
    let sign = select(-1.0, 1.0, (edge % 2u) == 1u);
    var length = 0u;
    for (var i = 0u; i < count; i++) {
      let a = polygon[i]; let b = polygon[(i+1u)%count];
      let da = sign*(a[axis]-bound); let db = sign*(b[axis]-bound);
      if (da <= 0.0) { next[length] = a; length++; }
      if ((da > 0.0) != (db > 0.0)) { next[length] = a + (da/(da-db))*(b-a); length++; }
    }
    count = length; polygon = next;
  }
  var area = 0.0;
  for (var i = 0u; i < count; i++) { let a = polygon[i]; let b = polygon[(i+1u)%count]; area += a.x*b.y-a.y*b.x; }
  return abs(area)*0.5;
}`);
