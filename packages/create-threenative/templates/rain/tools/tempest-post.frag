// The source of truth for src/render/post-shader.ts, transcribed from the Tempest single-file demo's
// `POST` constant (const POST, immediately after `BLOOM`).
//
// The whole filmic half of the demo in one pass: twelve animated refractive beads near the lens
// edges, a five-tap luma-edge antialias over the warped coordinate, the bloom added, weather
// exposure, the ACES fit, the cool-shadow/warm-highlight grade, the vignette, gamma 1/2.2 and the
// dither. Nothing here is a framework default — every constant is the demo's.
precision highp float;
in vec2 vUv;out vec4 fragColor;uniform sampler2D uScene,uBloom;uniform vec2 uRes;uniform float uTime,uExposure,uRain,uLens;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123);}
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
vec3 antialias(vec2 uv){
 vec2 px=1./uRes;vec3 m=texture(uScene,uv).rgb;
 vec3 nw=texture(uScene,uv+vec2(-1.,-1.)*px).rgb,ne=texture(uScene,uv+vec2(1.,-1.)*px).rgb;
 vec3 sw=texture(uScene,uv+vec2(-1.,1.)*px).rgb,se=texture(uScene,uv+vec2(1.,1.)*px).rgb;
 vec3 lum=vec3(.299,.587,.114);float l0=dot(m,lum),l1=dot(nw,lum),l2=dot(ne,lum),l3=dot(sw,lum),l4=dot(se,lum);
 vec2 dir=vec2(-((l1+l2)-(l3+l4)),(l1+l3)-(l2+l4));
 float reduce=max((l1+l2+l3+l4)*.03125,.0078125);float rcp=1./(min(abs(dir.x),abs(dir.y))+reduce);
 dir=clamp(dir*rcp,vec2(-6.),vec2(6.))*px;
 vec3 a=.5*(texture(uScene,uv+dir*(-.166667)).rgb+texture(uScene,uv+dir*.166667).rgb);
 vec3 b=a*.5+.25*(texture(uScene,uv-dir*.5).rgb+texture(uScene,uv+dir*.5).rgb);
 float lb=dot(b,lum),lo=min(l0,min(min(l1,l2),min(l3,l4))),hi=max(l0,max(max(l1,l2),max(l3,l4)));
 return lb<lo||lb>hi?a:b;
}
void main(){
 vec2 uv=vUv;vec2 warp=vec2(0.);float dropHighlight=0.;
 // Sparse refractive beads near the lens edges, not a full-screen blur.
 if(uLens>.5){for(int i=0;i<12;i++){
  float f=float(i);vec2 p=vec2(hash(vec2(f,3.)),hash(vec2(f,7.)));
  p.y=fract(p.y-uTime*(.008+hash(vec2(f,11.))*.01));
  if(p.x>.18&&p.x<.82)continue;
  vec2 d=(uv-p)*vec2(uRes.x/uRes.y,1.);float rad=.008+hash(vec2(f,9.))*.006;float dist=length(d*vec2(1.,.75));
  float mask=1.-smoothstep(rad*.7,rad,dist);
  warp+=d*mask*uRain*.5;dropHighlight+=pow(max(0.,1.-abs(dist-rad*.8)/(rad*.10)),4.)*.017*uRain;
 }}
 vec3 col=antialias(clamp(uv+warp,0.,1.));
 vec3 bloom=vec3(0.);float wt=0.;for(int i=-3;i<=3;i++){float w=exp(-float(i*i)*.26);bloom+=texture(uBloom,uv+vec2(0.,float(i)*3.)/uRes).rgb*w;wt+=w;}
 col+=bloom/wt*.22;
 col*=uExposure;
 col=aces(col);
 // Cool shadow / warm practical-light grade, retaining neutral highlights.
 col=pow(max(col,vec3(0.)),vec3(1.015,1.,.975));
 float vign=1.-.28*pow(length((uv-.5)*vec2(1.05,1.)),1.65);col*=vign;
 col=pow(col,vec3(1./2.2));
 col+=(hash(gl_FragCoord.xy+floor(uTime*24.))-.5)*.005+dropHighlight;
 fragColor=vec4(clamp(col,0.,1.),1.);
}
