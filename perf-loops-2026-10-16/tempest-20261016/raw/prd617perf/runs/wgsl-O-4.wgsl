WGSLDUMP 
diagnostic(off, derivative_uniformity);
struct Uniforms {
  f_nodeUniform14: vec3<f32>,
  f_nodeUniform15: vec3<f32>,
  f_nodeUniform11: f32,
  f_nodeUniform12: f32,
  f_nodeUniform16: vec3<f32>,
  f_nodeUniform18: vec3<f32>,
  f_nodeUniform19: vec3<f32>,
  f_nodeUniform20: vec3<f32>,
  f_nodeUniform10: f32,
  f_nodeUniform13: vec3<f32>,
  f_nodeUniform21: i32,
  f_cameraNear: f32,
  f_cameraFar: f32,
  f_nodeUniform8: f32,
  f_nodeUniform7: f32,
  f_nodeUniform9: f32,
  f_nodeUniform17: vec3<f32>,
}
@group(1) @binding(0) var<uniform> u: Uniforms;
@group(1) @binding(1) var t_nodeMap6: texture_3d<f32>;
@group(1) @binding(2) var smp_nodeMap6: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>, @location(1) i_positionView: vec3<f32>, @builtin(position) b_position: vec4<f32>) -> Out {
  var out: Out;
  var v0: vec2<f32>;
  var v1: vec3<f32>;
  var v2: vec3<f32>;
  var v3: f32;
  var v4: vec3<f32>;
  var v5: f32;
  var v6: f32;
  var v7: vec4<f32>;
  var v8: f32;
  var v9: vec3<f32>;
  var v10: f32;
  var v11: vec3<f32>;
  var v12: f32;
  var v13: f32;
  var v15: f32;
  var v16: vec3<f32>;
  var v17: f32;
  var v18: vec3<f32>;
  var v19: vec3<f32>;
  var v20: vec4<f32>;
  var v21: f32;
  var v22: f32;
  var v23: f32;
  var v24: f32;
  var v25: f32;
  var v26: f32;
  var v27: vec3<f32>;
  var v28: f32;
  var v29: f32;
  var v31: f32;
  var v32: vec3<f32>;
  var v33: vec3<f32>;
  var v34: vec4<f32>;
  var v35: f32;
  var v36: f32;
  var v37: f32;
  var v38: f32;
  var v39: f32;
  var v40: f32;
  var v41: f32;
  var v42: vec3<f32>;
  var v43: vec3<f32>;
  var v44: f32;
  var v45: f32;
  var v46: vec3<f32>;
  var v47: f32;
  v0 = ((i_uv * 2f) - 1f);
  let l8 = v0;
  let l17 = v0;
  v1 = normalize(((u.f_nodeUniform14 + (((u.f_nodeUniform15 * (l8).x) * u.f_nodeUniform11) * u.f_nodeUniform12)) + ((u.f_nodeUniform16 * (l17).y) * u.f_nodeUniform12)));
  let l23 = v1;
  let l24 = v1;
  v1 = vec3<f32>((l23).x, abs((l24).y), (l23).z);
  let l30 = v1;
  v1 = normalize(l30);
  v2 = u.f_nodeUniform18;
  let l33 = v1;
  let l34 = v2;
  v3 = dot(l33, l34);
  let l38 = v1;
  v4 = mix(u.f_nodeUniform19, u.f_nodeUniform20, pow(clamp((l38).y, 0f, 1f), 0.62f));
  let l45 = v4;
  let l50 = v3;
  v4 = (l45 + (vec3<f32>(0.31f, 0.27f, 0.205f) * pow(max(l50, 0f), 14f)));
  let l56 = v4;
  let l61 = v3;
  v4 = (l56 + (vec3<f32>(0.7f, 0.57f, 0.37f) * pow(max(l61, 0f), 140f)));
  let l67 = v4;
  v4 = (l67 + (u.f_nodeUniform10 * vec3<f32>(0.14f, 0.22f, 0.36f)));
  let l79 = v1;
  let e77 = (u.f_nodeUniform13).y;
  v5 = max(0f, ((145f - e77) / max((l79).y, 0.008f)));
  let l88 = v1;
  v6 = min(10500f, ((815f - e77) / max((l88).y, 0.008f)));
  let l93 = v4;
  v7 = vec4<f32>(l93, 1f);
  let l95 = v5;
  let l96 = v6;
  if ((l95 < l96)) {
    let l98 = v6;
    let l99 = v5;
    v8 = ((l98 - l99) / f32(u.f_nodeUniform21));
    let e105 = (b_position).xy;
    let e111 = (i_positionView).z;
    v9 = fract((vec3<f32>(((vec3<f32>((e105).x, (1f - (e105).y), (((u.f_cameraNear + e111) * u.f_cameraFar) / ((u.f_cameraFar - u.f_cameraNear) * e111)))).xy).xyx) * 0.1031f));
    let l125 = v9;
    let l126 = v9;
    let l127 = v9;
    v9 = (l125 + dot(l126, ((l127).yzx + 33.33f)));
    let l133 = v9;
    let l135 = v9;
    let l138 = v9;
    v10 = ((fract((((l133).x + (l135).y) * (l138).z)) * 0.75f) + 0.12f);
    v11 = vec3<f32>(0f, 0f, 0f);
    v12 = 1f;
    let l149 = v3;
    v13 = (0.45f + (0.65f * pow(max(l149, 0f), 5f)));
    for (var v14: i32 = 0i; v14 < 96i; v14 = v14 + 1i) {
      let l156 = v14;
      let l158 = v12;
      if (((l156 >= u.f_nodeUniform21) || (l158 < 0.008f))) {
        break;
      }
      let l161 = v5;
      let l163 = v10;
      let l165 = v8;
      v15 = (l161 + ((f32(l156) + l163) * l165));
      let l168 = v1;
      let l169 = v15;
      v16 = (u.f_nodeUniform13 + (l168 * l169));
      v17 = 0f;
      let e174 = (u.f_nodeUniform8 >= 0.005f);
      if (e174) {
        let e183 = vec3<f32>((u.f_nodeUniform7 * (2f + (u.f_nodeUniform9 * 13f))), 0f, (u.f_nodeUniform7 * 1.2f));
        v18 = e183;
        let l184 = v16;
        let l185 = v18;
        v19 = ((l184 + l185) * 0.00105f);
        let l189 = v19;
        let l190 = v19;
        v19 = vec3<f32>((l189).x, ((l190).y * 1.4f), (l189).z);
        let l197 = v19;
        v20 = textureSample(t_nodeMap6, smp_nodeMap6, l197);
        let l199 = v20;
        let l203 = v19;
        let e208 = vec3<f32>(0.1f, 0.3f, 0.7f);
        v21 = (((l199).x * 0.76f) + ((textureSample(t_nodeMap6, smp_nodeMap6, ((l203 * 2.07f) + e208))).x * 0.24f));
        let l215 = v16;
        v22 = (((l215).y - 145f) / 670f);
        let l221 = v22;
        let l224 = v22;
        v23 = (smoothstep(0f, 0.09f, l221) * (1f - smoothstep(0.68f, 1f, l224)));
        let l228 = v21;
        let e229 = (u.f_nodeUniform8 * 0.3f);
        v24 = ((l228 + e229) - 0.72f);
        let l233 = v19;
        v25 = (((textureSample(t_nodeMap6, smp_nodeMap6, (l233 * 3.81f))).z - 0.5f) * 0.12f);
        let l241 = v24;
        let l242 = v25;
        let l247 = v23;
        v17 = (clamp(((l241 - l242) * 5.1f), 0f, 1f) * l247);
      }
      let l249 = v17;
      v26 = l249;
      let l250 = v26;
      if ((0.002f < l250)) {
        let l253 = v16;
        v27 = l253;
        v28 = 0f;
        v29 = 28f;
        for (var v30: i32 = 0i; v30 < 5i; v30 = v30 + 1i) {
          let l256 = v30;
          let l257 = v27;
          let l258 = v2;
          let l259 = v29;
          v27 = (l257 + (l258 * l259));
          let l262 = v28;
          v31 = 0f;
          if (e174) {
            let e183 = vec3<f32>((u.f_nodeUniform7 * (2f + (u.f_nodeUniform9 * 13f))), 0f, (u.f_nodeUniform7 * 1.2f));
            v32 = e183;
            let l263 = v27;
            let l264 = v32;
            v33 = ((l263 + l264) * 0.00105f);
            let l267 = v33;
            let l268 = v33;
            v33 = vec3<f32>((l267).x, ((l268).y * 1.4f), (l267).z);
            let l274 = v33;
            v34 = textureSample(t_nodeMap6, smp_nodeMap6, l274);
            let l276 = v34;
            let l279 = v33;
            let e208 = vec3<f32>(0.1f, 0.3f, 0.7f);
            v35 = (((l276).x * 0.76f) + ((textureSample(t_nodeMap6, smp_nodeMap6, ((l279 * 2.07f) + e208))).x * 0.24f));
            let l286 = v27;
            v36 = (((l286).y - 145f) / 670f);
            let l290 = v36;
            let l292 = v36;
            v37 = (smoothstep(0f, 0.09f, l290) * (1f - smoothstep(0.68f, 1f, l292)));
            let l296 = v35;
            let e229 = (u.f_nodeUniform8 * 0.3f);
            v38 = ((l296 + e229) - 0.72f);
            let l299 = v33;
            v39 = (((textureSample(t_nodeMap6, smp_nodeMap6, (l299 * 3.81f))).z - 0.5f) * 0.12f);
            let l305 = v38;
            let l306 = v39;
            let l310 = v37;
            v31 = (clamp(((l305 - l306) * 5.1f), 0f, 1f) * l310);
          }
          let l312 = v31;
          let l313 = v29;
          v28 = (l262 + (l312 * l313));
          let l316 = v29;
          v29 = (l316 * 1.7f);
        }
        let l319 = v28;
        v40 = exp(((-l319) * 0.015f));
        let l324 = v16;
        v41 = clamp((((l324).y - 145f) / 670f), 0f, 1f);
        let l337 = v41;
        v42 = mix(vec3<f32>(0.035f, 0.061f, 0.079f), vec3<f32>(0.19f, 0.25f, 0.28f), l337);
        let l339 = v42;
        let l340 = v26;
        let l353 = v40;
        let l355 = v13;
        v43 = ((l339 * (0.7f + (0.45f * (1f - exp(((-l340) * 3f)))))) + (((vec3<f32>(0.97f, 0.94f, 0.85f) * l353) * l355) * 0.7f));
        let l359 = v16;
        v44 = exp(((-length(((l359 - u.f_nodeUniform17) * vec3<f32>(1f, 0.5f, 1f)))) * 0.0022f));
        let l369 = v43;
        let l374 = v44;
        v43 = (l369 + (((vec3<f32>(0.85f, 1.18f, 1.9f) * u.f_nodeUniform10) * l374) * 1.2f));
        let l378 = v26;
        let l380 = v8;
        v45 = (1f - exp((((-l378) * l380) * 0.02f)));
        let l386 = v11;
        let l387 = v12;
        let l388 = v45;
        let l390 = v43;
        v11 = (l386 + ((l387 * l388) * l390));
        let l393 = v12;
        let l394 = v45;
        v12 = (l393 * (1f - l394));
      }
    }
    let l397 = v11;
    let l398 = v12;
    let l399 = v4;
    v46 = (l397 + (l398 * l399));
    let l402 = v5;
    v47 = (1f - exp(((-l402) * 7.5e-05f)));
    let l408 = v46;
    let l409 = v4;
    let l410 = v47;
    v46 = mix(l408, l409, (l410 * 0.66f));
    let l414 = v46;
    let l415 = v12;
    v7 = vec4<f32>(l414, (1f - l415));
  }
  let l418 = v7;
  out.color = l418;
  return out;
}
