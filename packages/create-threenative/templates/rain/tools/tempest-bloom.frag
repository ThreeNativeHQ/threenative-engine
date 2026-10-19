// The source of truth for src/render/bloom-shader.ts, transcribed from the Tempest single-file
// demo's `BLOOM` constant (const BLOOM, just after the lightning bolt fragment shader).
//
// A 5x5 gaussian at twice the input texel size, masked by a soft-knee luminance threshold and
// normalised by the weight it actually accumulated — not by 25, so the corners of the frame, where
// the kernel hangs off the target, cannot dim. Rendered at quarter resolution; see
// src/render/postprocessing.ts.
precision highp float;
in vec2 vUv;out vec4 fragColor;uniform sampler2D uScene;uniform vec2 uRes;
void main(){vec3 c=vec3(0.);float w=0.;for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){float wt=exp(-float(x*x+y*y)*.32);vec3 s=texture(uScene,vUv+vec2(float(x),float(y))/uRes*2.).rgb;float l=max(s.r,max(s.g,s.b));c+=s*smoothstep(.70,1.6,l)*wt;w+=wt;}fragColor=vec4(c/w,1.);}
