WGSLDUMP 
diagnostic(off, derivative_uniformity);
struct Uniforms {
  f_nodeUniform1: vec2<f32>,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(1) var t_native_rtt_61: texture_2d<f32>;
@group(1) @binding(2) var smp_native_rtt_61: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>) -> Out {
  var out: Out;
  var v0: vec3<f32>;
  var v1: f32;
  var v4: f32;
  var v5: vec3<f32>;
  var v6: f32;
  v0 = vec3<f32>(0f, 0f, 0f);
  v1 = 0f;
  let e8 = ((2i + i32(1f)) - -2i);
  for (var v2: i32 = 0i; v2 < e8; v2 = v2 + 1i) {
    let l9 = v2;
    for (var v3: i32 = 0i; v3 < e8; v3 = v3 + 1i) {
      let l13 = v3;
      let e15 = ((l13 * 1i) + -2i);
      let e12 = ((l9 * 1i) + -2i);
      v4 = exp(((-f32(((e15 * e15) + (e12 * e12)))) * 0.32f));
      v5 = (textureSample(t_native_rtt_61, smp_native_rtt_61, (vec2<f32>((i_uv).x, (1f - (i_uv).y)) + ((vec2<f32>(f32(e15), f32(e12)) / u.f_nodeUniform1) * 2f)))).xyz;
      let l39 = v5;
      let l41 = v5;
      let l43 = v5;
      v6 = max((l39).x, max((l41).y, (l43).z));
      let l47 = v0;
      let l48 = v5;
      let l51 = v6;
      let l54 = v4;
      v0 = (l47 + ((l48 * smoothstep(0.7f, 1.6f, l51)) * l54));
      let l57 = v1;
      let l58 = v4;
      v1 = (l57 + l58);
    }
  }
  let l60 = v0;
  let l61 = v1;
  out.color = vec4<f32>((l60 / l61), 1f);
  return out;
}
