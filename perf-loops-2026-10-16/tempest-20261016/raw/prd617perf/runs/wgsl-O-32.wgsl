WGSLDUMP 
diagnostic(off, derivative_uniformity);
struct Uniforms {
  f_nodeUniform6: f32,
  f_nodeUniform3: f32,
  f_nodeUniform2: vec2<f32>,
  f_nodeUniform5: f32,
  f_nodeUniform4: f32,
  f_cameraNear: f32,
  f_cameraFar: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var t_scene: texture_2d<f32>;
@group(0) @binding(2) var smp_scene: sampler;
@group(0) @binding(3) var t_native_rtt_61: texture_2d<f32>;
@group(0) @binding(4) var smp_native_rtt_61: sampler;
@group(0) @binding(5) var t_nodeMap8: texture_2d<f32>;
@group(0) @binding(6) var smp_nodeMap8: sampler;
struct Out {
  @location(0) color: vec4<f32>,
}
@fragment
fn main(@location(0) i_uv: vec2<f32>, @location(1) i_positionView: vec3<f32>, @builtin(position) b_position: vec4<f32>) -> Out {
  var out: Out;
  var v0: vec2<f32>;
  var v1: vec2<f32>;
  var v2: f32;
  var v4: f32;
  var v5: vec2<f32>;
  var v6: vec2<f32>;
  var v7: f32;
  var v8: f32;
  var v9: f32;
  var v10: vec2<f32>;
  var v11: vec3<f32>;
  var v12: vec3<f32>;
  var v13: vec3<f32>;
  var v14: vec3<f32>;
  var v15: vec3<f32>;
  var v16: vec3<f32>;
  var v17: f32;
  var v18: f32;
  var v19: f32;
  var v20: f32;
  var v21: f32;
  var v22: vec2<f32>;
  var v23: f32;
  var v24: f32;
  var v25: vec3<f32>;
  var v26: vec3<f32>;
  var v27: f32;
  var v28: f32;
  var v29: f32;
  var v30: vec3<f32>;
  var v31: vec3<f32>;
  var v32: f32;
  var v34: f32;
  var v35: f32;
  v0 = i_uv;
  v1 = vec2<f32>(0f, 0f);
  v2 = 0f;
  if ((0.5f < u.f_nodeUniform6)) {
    for (var v3: i32 = 0i; v3 < 12i; v3 = v3 + 1i) {
      let l8 = v3;
      v4 = f32(l8);
      let l10 = v4;
      let l21 = v4;
      let e15 = vec2<f32>(127.1f, 311.7f);
      v5 = vec2<f32>(fract((sin(dot(vec2<f32>(l10, 3f), e15)) * 43758.547f)), fract((sin(dot(vec2<f32>(l21, 7f), e15)) * 43758.547f)));
      let l29 = v5;
      let l30 = v5;
      let l34 = v4;
      v5 = vec2<f32>((l29).x, fract(((l30).y - (u.f_nodeUniform3 * (0.008f + (fract((sin(dot(vec2<f32>(l34, 11f), e15)) * 43758.547f)) * 0.01f))))));
      let l49 = v5;
      let l53 = v5;
      if (((0.18f < (l49).x) && ((l53).x < 0.82f))) {
        continue;
      }
      let l58 = v0;
      let l59 = v5;
      v6 = ((l58 - l59) * vec2<f32>(((u.f_nodeUniform2).x / (u.f_nodeUniform2).y), 1f));
      let l68 = v4;
      v7 = (0.008f + (fract((sin(dot(vec2<f32>(l68, 9f), e15)) * 43758.547f)) * 0.006f));
      let l78 = v6;
      v8 = length((l78 * vec2<f32>(1f, 0.75f)));
      let l83 = v7;
      let l86 = v7;
      let l87 = v8;
      v9 = (1f - smoothstep((l83 * 0.7f), l86, l87));
      let l90 = v1;
      let l91 = v6;
      let l92 = v9;
      v1 = (l90 + (((l91 * l92) * u.f_nodeUniform5) * 0.5f));
      let l98 = v2;
      let l99 = v8;
      let l100 = v7;
      let l105 = v7;
      v2 = (l98 + ((pow(max(0f, (1f - (abs((l99 - (l100 * 0.8f))) / (l105 * 0.1f)))), 4f) * 0.017f) * u.f_nodeUniform5));
    }
  }
  v10 = (1f / u.f_nodeUniform2);
  let l118 = v0;
  let l119 = v1;
  v11 = (textureSample(t_native_rtt_61, smp_native_rtt_61, clamp((l118 + l119), vec2<f32>(0f), vec2<f32>(1f)))).xyz;
  let l124 = v0;
  let l125 = v1;
  let l130 = v10;
  v12 = (textureSample(t_native_rtt_61, smp_native_rtt_61, (clamp((l124 + l125), vec2<f32>(0f), vec2<f32>(1f)) + (vec2<f32>(-1f, -1f) * l130)))).xyz;
  let l135 = v0;
  let l136 = v1;
  let l140 = v10;
  v13 = (textureSample(t_native_rtt_61, smp_native_rtt_61, (clamp((l135 + l136), vec2<f32>(0f), vec2<f32>(1f)) + (vec2<f32>(1f, -1f) * l140)))).xyz;
  let l145 = v0;
  let l146 = v1;
  let l150 = v10;
  v14 = (textureSample(t_native_rtt_61, smp_native_rtt_61, (clamp((l145 + l146), vec2<f32>(0f), vec2<f32>(1f)) + (vec2<f32>(-1f, 1f) * l150)))).xyz;
  let l155 = v0;
  let l156 = v1;
  let l160 = v10;
  v15 = (textureSample(t_native_rtt_61, smp_native_rtt_61, (clamp((l155 + l156), vec2<f32>(0f), vec2<f32>(1f)) + (vec2<f32>(1f, 1f) * l160)))).xyz;
  v16 = vec3<f32>(0.299f, 0.587f, 0.114f);
  let l169 = v11;
  let l170 = v16;
  v17 = dot(l169, l170);
  let l172 = v12;
  let l173 = v16;
  v18 = dot(l172, l173);
  let l175 = v13;
  let l176 = v16;
  v19 = dot(l175, l176);
  let l178 = v14;
  let l179 = v16;
  v20 = dot(l178, l179);
  let l181 = v15;
  let l182 = v16;
  v21 = dot(l181, l182);
  let l184 = v18;
  let l185 = v19;
  let l187 = v20;
  let l188 = v21;
  let l192 = v18;
  let l193 = v20;
  let l195 = v19;
  let l196 = v21;
  v22 = vec2<f32>((-((l184 + l185) - (l187 + l188))), ((l192 + l193) - (l195 + l196)));
  let l200 = v18;
  let l201 = v19;
  let l203 = v20;
  let l205 = v21;
  v23 = max(((((l200 + l201) + l203) + l205) * 0.03125f), 0.0078125f);
  let l211 = v22;
  let l214 = v22;
  let l218 = v23;
  v24 = (1f / (min(abs((l211).x), abs((l214).y)) + l218));
  let l221 = v22;
  let l222 = v24;
  let l229 = v10;
  v22 = (clamp((l221 * l222), vec2<f32>(-6f, -6f), vec2<f32>(6f, 6f)) * l229);
  let l231 = v0;
  let l232 = v1;
  let l235 = v22;
  let l241 = v22;
  let e234 = clamp((l231 + l232), vec2<f32>(0f), vec2<f32>(1f));
  v25 = (0.5f * ((textureSample(t_native_rtt_61, smp_native_rtt_61, (e234 + (l235 * -0.166667f)))).xyz + (textureSample(t_native_rtt_61, smp_native_rtt_61, (e234 + (l241 * 0.166667f)))).xyz));
  let l249 = v25;
  let l252 = v0;
  let l253 = v1;
  let l256 = v22;
  let l261 = v22;
  let e255 = clamp((l252 + l253), vec2<f32>(0f), vec2<f32>(1f));
  v26 = ((l249 * 0.5f) + (0.25f * ((textureSample(t_native_rtt_61, smp_native_rtt_61, (e255 - (l256 * 0.5f)))).xyz + (textureSample(t_native_rtt_61, smp_native_rtt_61, (e255 + (l261 * 0.5f)))).xyz)));
  let l269 = v26;
  let l270 = v16;
  v27 = dot(l269, l270);
  let l272 = v17;
  let l273 = v18;
  let l274 = v19;
  let l276 = v20;
  let l277 = v21;
  v28 = min(l272, min(min(l273, l274), min(l276, l277)));
  let l281 = v17;
  let l282 = v18;
  let l283 = v19;
  let l285 = v20;
  let l286 = v21;
  v29 = max(l281, max(max(l282, l283), max(l285, l286)));
  let l290 = v27;
  let l291 = v28;
  let l293 = v27;
  let l294 = v29;
  let l297 = v25;
  let l298 = v26;
  v30 = select(l298, l297, ((l290 < l291) || (l294 < l293)));
  let e300 = vec3<f32>(0f, 0f, 0f);
  v31 = e300;
  v32 = 0f;
  for (var v33: i32 = 0i; v33 < ((3i + i32(1f)) - -3i); v33 = v33 + 1i) {
    let l306 = v33;
    let e309 = ((l306 * 1i) + -3i);
    v34 = exp(((-f32((e309 * e309))) * 0.26f));
    let l316 = v31;
    let l317 = v0;
    let l325 = v34;
    v31 = (l316 + ((textureSample(t_nodeMap8, smp_nodeMap8, (l317 + (vec2<f32>(0f, (f32(e309) * 3f)) / u.f_nodeUniform2)))).xyz * l325));
    let l328 = v32;
    let l329 = v34;
    v32 = (l328 + l329);
  }
  let l331 = v30;
  let l332 = v31;
  let l333 = v32;
  v30 = (l331 + ((l332 / l333) * 0.22f));
  let l338 = v30;
  v30 = (l338 * u.f_nodeUniform4);
  let l341 = v30;
  let l343 = v30;
  let l348 = v30;
  let l350 = v30;
  v30 = clamp(((l341 * ((2.51f * l343) + 0.03f)) / ((l348 * ((2.43f * l350) + 0.59f)) + 0.14f)), vec3<f32>(0f), vec3<f32>(1f));
  let l359 = v30;
  v30 = pow(max(l359, e300), vec3<f32>(1.015f, 1f, 0.975f));
  let l366 = v0;
  v35 = (1f - (0.28f * pow(length(((l366 - 0.5f) * vec2<f32>(1.05f, 1f))), 1.65f)));
  let l376 = v30;
  let l377 = v35;
  v30 = (l376 * l377);
  let l379 = v30;
  v30 = pow(l379, vec3<f32>(0.45454547f, 0.45454547f, 0.45454547f));
  let l383 = v30;
  let l411 = v2;
  let e385 = (b_position).xy;
  let e391 = (i_positionView).z;
  let e15 = vec2<f32>(127.1f, 311.7f);
  v30 = (l383 + (((fract((sin(dot(((vec3<f32>((e385).x, (1f - (e385).y), (((u.f_cameraNear + e391) * u.f_cameraFar) / ((u.f_cameraFar - u.f_cameraNear) * e391)))).xy + floor((u.f_nodeUniform3 * 24f))), e15)) * 43758.547f)) - 0.5f) * 0.005f) + l411));
  let l414 = v30;
  let e416 = vec4<f32>(clamp(l414, vec3<f32>(0f), vec3<f32>(1f)), 1f);
  let e418 = clamp((e416).w, 0f, 1f);
  out.color = vec4<f32>((select(((e416).xyz / e418), vec3<f32>(0f), (e418 == 0f)) * e418), e418);
  return out;
}
