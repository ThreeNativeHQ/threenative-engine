// The GLSL this template's cloud volume shader is generated from, copied out of the Tempest
// single-file demo (its COMMON + CLOUDS fragment shaders) so the generator is reproducible without
// the original file. Edits here change the generated
// templates/rain/src/render/clouds-shader.ts; edit the generator, not its output.
//
// Two things below are rewritten, both to keep the port mechanical rather than hand-written. The
// `density` early return becomes one value assigned under a guard, and `main`'s degenerate-slab
// return becomes the value it starts with — the reason is on `density`. The five-tap sunlight loop
// counts with `i` rather than `j` so the transpiler emits a loop whose counter it already names the
// way `LoopNode` expects; the counter's name is not part of what the loop computes.
precision highp float;
precision highp sampler3D;
uniform float uTime, uRain, uCloud, uWind, uFog, uWet, uFlash, uAspect, uTan;
uniform vec3 uCam, uForward, uRight, uUp, uStrike;
// The look, owned by src/render/{sky,lighting}.ts and set from there every run.
uniform vec3 uSunDir, uSkyLow, uSkyHigh;
uniform vec2 uRes;
in vec2 vUv;
out vec4 fragColor;
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float noise2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+1.),f.x),f.y);}
float fbm2(vec2 p){float v=.5*noise2(p);p=mat2(.8,-.6,.6,.8)*p*2.03+19.1;v+=.25*noise2(p);p=p*2.02+9.3;v+=.125*noise2(p);return v+.0625*noise2(p*2.01+17.);}
vec3 ray(vec2 uv){vec2 q=uv*2.-1.;return normalize(uForward+uRight*q.x*uAspect*uTan+uUp*q.y*uTan);}
vec4 project(vec3 p){vec3 v=p-uCam;float d=dot(v,uForward);return vec4(dot(v,uRight)/(uAspect*uTan),dot(v,uUp)/uTan,1.00012*d-.300018,d);}
uniform sampler3D uNoise;
uniform int uSteps;
float density(vec3 p){
 // One value, one return, for the reason given in the coast's `baseColor`: the transpiler turns a
 // GLSL early return into a JavaScript return that only leaves the `If` callback the node graph is
 // being built inside, so the branch would never be assigned. The guard is kept as a guard, so a
 // clear sky still costs one comparison and no noise fetches.
 float res=0.;
 if(uCloud>=.005){
  vec3 drift=vec3(uTime*(2.+uWind*13.),0.,uTime*1.2);
  vec3 q=(p+drift)*.00105; q.y*=1.4;
  vec4 n=texture(uNoise,q);
  float broad=n.r*.76+texture(uNoise,q*2.07+vec3(.1,.3,.7)).r*.24;
  // Flattened condensation base with turbulent billows above it.
  float h=(p.y-145.)/670.;
  float base=smoothstep(0.,.09,h)*(1.-smoothstep(.68,1.,h));
  float shape=broad+uCloud*.30-.72;
  float edge=(texture(uNoise,q*3.81).b-.5)*.12;
  res=clamp((shape-edge)*5.1,0.,1.)*base;
 }
 return res;
}
float lightAt(vec3 p,vec3 l){float sum=0.,stepLen=28.;for(int i=0;i<5;i++){p+=l*stepLen;sum+=density(p)*stepLen;stepLen*=1.7;}return exp(-sum*.015);}
void main(){
 vec3 rd=ray(vUv);rd.y=abs(rd.y);rd=normalize(rd);
 vec3 sunDir=uSunDir;float mu=dot(rd,sunDir);
 vec3 sky=mix(uSkyLow,uSkyHigh,pow(clamp(rd.y,0.,1.),.62));
 sky+=vec3(.31,.27,.205)*pow(max(mu,0.),14.);
 sky+=vec3(.7,.57,.37)*pow(max(mu,0.),140.);
 sky+=uFlash*vec3(.14,.22,.36);
 float t0=max(0.,(145.-uCam.y)/max(rd.y,.008));
 float t1=min(10500.,(815.-uCam.y)/max(rd.y,.008));
 vec4 col=vec4(sky,1.);
 if(t0<t1){
  float dt=(t1-t0)/float(uSteps);
  float jitter=hash12(gl_FragCoord.xy)*.75+.12;
  vec3 light=vec3(0.);float trans=1.;
  float phase=.45+.65*pow(max(mu,0.),5.);
  for(int i=0;i<96;i++){
   if(i>=uSteps||trans<.008)break;
   float t=t0+(float(i)+jitter)*dt;vec3 p=uCam+rd*t;
   float d=density(p);
   if(d>.002){
    float sun=lightAt(p,sunDir);
    float height=clamp((p.y-145.)/670.,0.,1.);
    vec3 ambient=mix(vec3(.035,.061,.079),vec3(.19,.25,.28),height);
    // A small multiple-scattering/powder approximation prevents crushed cloud cores.
    vec3 c=ambient*(.7+.45*(1.-exp(-d*3.)))+vec3(.97,.94,.85)*sun*phase*.70;
    float glow=exp(-length((p-uStrike)*vec3(1.,.5,1.))*.0022);
    c+=vec3(.85,1.18,1.9)*uFlash*glow*1.2;
    float absorb=1.-exp(-d*dt*.020);
    light+=trans*absorb*c;trans*=1.-absorb;
   }
  }
  vec3 marched=light+trans*sky;
  float atmospheric=1.-exp(-t0*.000075);
  marched=mix(marched,sky,atmospheric*.66);
  col=vec4(marched,1.-trans);
 }
 return col;
}
