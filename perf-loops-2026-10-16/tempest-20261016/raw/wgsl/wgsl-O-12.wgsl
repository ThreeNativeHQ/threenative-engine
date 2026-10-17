WGSLDUMP 
diagnostic(off, derivative_uniformity);
struct Uniforms {
  f_diffuse: vec4<f32>,
  f_alphaTest: f32,
  f_opaque: f32,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main() -> Out {
  var out: Out;
  let e3 = (u.f_diffuse).w;
  if (select(false, select(true, false, (u.f_alphaTest < e3)), (0f < u.f_alphaTest))) {
    discard;
  }
  out.color = max(vec4<f32>((u.f_diffuse).xyz, mix(e3, 1f, u.f_opaque)), vec4<f32>(0f));
  return out;
}
