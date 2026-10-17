WGSLDUMP 
diagnostic(off, derivative_uniformity);
@group(0) @binding(0) var t_scene: texture_2d<f32>;
@group(0) @binding(1) var smp_scene: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>) -> Out {
  var out: Out;
  let e4 = (textureSample(t_scene, smp_scene, i_uv) * 1f);
  out.color = (e4 / (max((e4).x, max((e4).y, (e4).z)) + 1f));
  return out;
}
