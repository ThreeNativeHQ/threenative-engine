// The GLSL this template's coastal world shader is generated from, copied verbatim out of the
// Tempest single-file demo (its COMMON + WORLD fragment shaders) so the generator is
// reproducible without the original file. Edits here change the generated
// templates/rain/src/render/world-shader.ts; edit the generator, not its output.
precision highp float;
precision highp sampler3D;
uniform float uTime, uRain, uCloud, uWind, uFog, uWet, uFlash, uAspect, uTan;
uniform vec3 uCam, uForward, uRight, uUp, uStrike;
// The look, owned by src/render/{sky,lighting,materials}.ts and set from there every run.
uniform vec3 uHazeLow, uHazeHigh, uSunDir, uSunColor, uFill, uFlashLight, uLampLight, uLampGlow, uWater;
uniform vec2 uRes;
in vec2 vUv;
out vec4 fragColor;
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float hash13(vec3 p){p=fract(p*.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float noise2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+1.),f.x),f.y);}
float fbm2(vec2 p){float v=.5*noise2(p);p=mat2(.8,-.6,.6,.8)*p*2.03+19.1;v+=.25*noise2(p);p=p*2.02+9.3;v+=.125*noise2(p);return v+.0625*noise2(p*2.01+17.);}
vec3 ray(vec2 uv){vec2 q=uv*2.-1.;return normalize(uForward+uRight*q.x*uAspect*uTan+uUp*q.y*uTan);}
vec4 project(vec3 p){vec3 v=p-uCam;float d=dot(v,uForward);return vec4(dot(v,uRight)/(uAspect*uTan),dot(v,uUp)/uTan,1.00012*d-.300018,d);}
vec3 hazeColor(vec3 rd){return mix(uHazeLow,uHazeHigh,smoothstep(0.,.7,abs(rd.y)))+uFlash*vec3(.11,.16,.24);}
uniform sampler2D uSky;
uniform int uReflect;
float roadCenter(float z){return -1.6+2.1*sin(z*.012)+15.*(1.-smoothstep(-420.,-150.,z));}
float coast(float z){return roadCenter(z)+9.2+sin(z*.023)*1.8;}
float terrain(vec2 p){
 float n=fbm2(p*.009+vec2(4.,9.));
 float r=1.-abs(noise2(p*.018)*2.-1.);
 float left=smoothstep(13.,155.,-p.x)*(28.+n*135.+r*20.);
 float back=smoothstep(280.,670.,-p.y)*(46.+n*155.+r*22.);
 float farRight=smoothstep(190.,430.,p.x)*(30.+n*95.);
 float h=max(max(left,back),farRight);
 float island=exp(-dot((p-vec2(94.,-205.))/vec2(39.,48.),(p-vec2(94.,-205.))/vec2(39.,48.)))*(18.+n*10.);
 h=max(h,island);
 if(h<1.5){h=p.x>coast(p.y)?-1.2:.10+n*.20;}
 if(p.y> -175.&&abs(p.x-roadCenter(p.y))<7.3)h=0.;
 return h;
}
float sdBox(vec3 p,vec3 b){vec3 q=abs(p)-b;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.);}
float capsule(vec3 p,vec3 a,vec3 b,float r){vec3 pa=p-a,ba=b-a;return length(pa-ba*clamp(dot(pa,ba)/dot(ba,ba),0.,1.))-r;}
vec2 choose(vec2 a,vec2 b){return a.x<b.x?a:b;}
// One bounded procedural tree per spatial cell; crowns fit inside their cells.
vec2 treeCell(vec2 p){return floor((p+vec2(2.,1.))/10.5);}
vec2 treeCentre(vec2 cell){return (cell+.5)*10.5-vec2(2.,1.)+vec2(hash12(cell+3.),hash12(cell+7.))*.9-.45;}
// The ground under a cell's tree, or 1e4 when the cell grows none. terrain() is the costliest call
// in the march, so it runs only for a cell the cheap tests admit, and trace() asks once per cell.
float treeBase(vec2 cell){
 float seed=hash12(cell+17.);vec2 tc=treeCentre(cell);
 float rel=tc.x-roadCenter(tc.y),th=1e4;
 if((rel< -9.||tc.y< -175.)&&seed>.15&&(tc.y< -12.||tc.x< -45.)){float g=terrain(tc);if(g>-.2&&g<115.)th=g;}
 return th;
}
// The march reads a hill only where it rises above 1 m, else the -3.5 floor. Each hill's weight times
// its largest height (the noises stay below 1) bounds it, so a point no hill can lift past 1 m skips
// terrain()'s five noises and gets the same floor it would have.
// terrain() is static, so src/render/world.ts caches it every frame in two small passes: `uHeight` holds
// it on a camera-centred grid, and `uBase` holds every nearby tree cell's base. A cached height is
// only an estimate between its texels, so it stands in for terrain() only as an upper bound,
// `uHeightMargin` above the sample: a point that bound puts under 1 m gets the floor, a point more
// than 2 m above it steps as if the hill reached the bound (a shorter step, never through the
// ground), and any point nearer the ground calls terrain() itself, so every hit and every normal
// still lands on the exact surface. Only the 148-step coast trace reads the bound (`bounded`): the
// 36-step reflection march would run out of steps on the shorter ones and reflect sky for hillside.
uniform sampler2D uHeight;
uniform vec4 uHeightGrid;
uniform float uHeightMargin;
uniform sampler2D uBase;
uniform vec3 uBaseGrid;
float heightBound(vec2 p){
 vec2 g=(p-uHeightGrid.xy)/uHeightGrid.zw;
 float bound=1e4;
 if(g.x>.002&&g.y>.002&&g.x<.998&&g.y<.998)bound=texture(uHeight,g).r+uHeightMargin;
 return bound;
}
float hillHeight(vec2 p,float y,float bounded){
 vec2 di=(p-vec2(94.,-205.))/vec2(39.,48.);
 float h=-3.5;
 if(smoothstep(13.,155.,-p.x)*183.>1.||smoothstep(280.,670.,-p.y)*223.>1.||smoothstep(190.,430.,p.x)*125.>1.||exp(-dot(di,di))*28.>1.){
  float bound=bounded>.5?heightBound(p):1e4;
  if(bound>1.){
   if(y-bound>2.)h=bound;
   else{float g=terrain(p);if(g>1.)h=g;}
  }
 }
 return h;
}
// One texel per tree cell, centred on the camera's cell: r + g is the base (split so a half-float
// target keeps it to a tenth of a millimetre) and b is 1 where the cell grows a tree.
vec4 baseTable(vec2 vUv){
 float th=treeBase(uBaseGrid.xy+floor(vUv*uBaseGrid.z));
 float hi=floor(th*4.)/4.;
 vec4 res=vec4(0.,0.,0.,1.);
 if(th<1e3)res=vec4(hi,th-hi,1.,1.);
 return res;
}
vec4 heightTable(vec2 vUv){return vec4(terrain(uHeightGrid.xy+vUv*uHeightGrid.zw),0.,0.,1.);}
float cellBase(vec2 cell){
 vec2 k=cell-uBaseGrid.xy;
 float th=1e4;
 if(k.x>=0.&&k.y>=0.&&k.x<uBaseGrid.z&&k.y<uBaseGrid.z){vec2 bu=(k+.5)/uBaseGrid.z;vec4 v=texture(uBase,bu);if(v.b>.5)th=v.r+v.g;}
 else th=treeBase(cell);
 return th;
}
vec2 sceneAt(vec3 p,float th,float bounded){
 vec2 res=vec2((p.y-hillHeight(p.xz,p.y,bounded))*.58,1.);
 if(th<1e3){
  vec2 cell=treeCell(p.xz);float seed=hash12(cell+17.);vec2 tc=treeCentre(cell);
  vec3 q=p-vec3(tc.x,th,tc.y);float ht=6.+seed*13.;
  float cy=clamp(q.y/ht,0.,1.);float angle=atan(q.z,q.x);
  float tier=.77+.23*sin(q.y*3.5+seed*13.);
  float r=(1.-cy)*(2.+seed*1.45)*tier;
  r*=.88+.12*sin(angle*9.+q.y*2.7)+.07*sin(angle*19.-q.y*6.);
  float needle=(noise2(q.xz*6.+q.y*2.)-.5)*.18*(1.-cy);
  float d=max(length(q.xz)-r+needle,max(.8-q.y,q.y-ht))*.67;
  res=choose(res,vec2(d,2.));
  res=choose(res,vec2(max(length(q.xz)-.13*(1.-cy*.65),max(-q.y,q.y-ht)),3.));
 }
 // Repeating steel luminaires, including their angled neck and illuminated undersides.
 float k=clamp(floor((-p.z-10.)/38.+.5),0.,5.);float z=-10.-k*38.;
 float x=roadCenter(z)-6.35;vec3 q=p-vec3(x,0.,z);
 float pole=capsule(q,vec3(0.,0.,0.),vec3(0.,7.65,0.),.075);
 pole=min(pole,capsule(q,vec3(0.,7.6,0.),vec3(1.6,8.05,0.),.065));
 pole=min(pole,capsule(q,vec3(1.6,8.05,0.),vec3(2.5,8.05,0.),.055));
 pole=min(pole,sdBox(q-vec3(2.43,8.,0.),vec3(.40,.10,.23)));
 res=choose(res,vec2(pole,4.));
 res=choose(res,vec2(sdBox(q-vec3(2.45,7.885,0.),vec3(.32,.021,.175)),6.));
 // Guardrail on the water side, stopping before the distant curve.
 if(p.z<28.&&p.z> -176.){
  float rx=roadCenter(p.z)+6.3;
  float rail=sdBox(vec3(p.x-rx,p.y-.84,0.),vec3(.065,.13,1000.));
  float postZ=floor(p.z/5.+.5)*5.;
  rail=min(rail,sdBox(p-vec3(roadCenter(postZ)+6.3,.45,postZ),vec3(.055,.45,.055)));
  res=choose(res,vec2(rail,4.));
 }
 // Small roadside field station, with a lit window and antenna.
 vec3 b=p-vec3(-17.,1.85,-73.);
 float cabin=sdBox(b,vec3(3.3,1.85,2.65));
 res=choose(res,vec2(cabin,9.));
 res=choose(res,vec2(sdBox(p-vec3(-17.,3.85,-73.),vec3(3.6,.14,2.9)),4.));
 res=choose(res,vec2(sdBox(p-vec3(-17.8,2.1,-70.325),vec3(.84,.48,.028)),6.));
 res=choose(res,vec2(capsule(p,vec3(-19.,3.9,-74.),vec3(-19.,13.,-74.),.045),4.));
 return res;
}
vec2 sceneMap(vec3 p){return sceneAt(p,cellBase(treeCell(p.xz)),0.);}
vec2 trace(vec3 ro,vec3 rd,float limit){
 float t=.25,mat=-1.;
 vec2 lastCell=vec2(1e9);float th=1e4;
 for(int i=0;i<148;i++){
  if(t>limit||t>1850.)break;
  vec3 p=ro+rd*t;
  vec2 cell=treeCell(p.xz);
  if(cell.x!=lastCell.x||cell.y!=lastCell.y){th=cellBase(cell);lastCell=cell;}
  vec2 d=sceneAt(p,th,1.);
  float eps=max(.007,t*.00048);
  if(d.x<eps){mat=d.y;break;}
  float stepD=max(.05,d.x*.87);
  if(p.y<34.&&t<270.)stepD=min(stepD,4.8);
  t+=stepD;
 }
 return vec2(t,mat);
}
// The scene at a normal tap: its cell's tree base is the hit's own unless the tap crossed a cell edge.
float tapScene(vec3 q,vec2 hitCell,float hitBase){vec2 c=treeCell(q.xz);float th=hitBase;if(c.x!=hitCell.x||c.y!=hitCell.y)th=cellBase(c);return sceneAt(q,th,0.).x;}
vec3 getNormal(vec3 p,float t){float e=max(.008,t*.00032);vec2 k=vec2(1.,-1.)*.5773;vec2 hc=treeCell(p.xz);float hb=cellBase(hc);return normalize(k.xyy*tapScene(p+k.xyy*e,hc,hb)+k.yyx*tapScene(p+k.yyx*e,hc,hb)+k.yxy*tapScene(p+k.yxy*e,hc,hb)+k.xxx*tapScene(p+k.xxx*e,hc,hb));}
vec3 baseColor(vec3 p,float mat,vec3 n){
 float grit=noise2(p.xz*4.3+p.y)*.2+noise2(p.xz*31.)*.09;
 // One value, one return. The transpiler turns a GLSL early return into a JavaScript return that
 // only leaves the `If` callback the node graph is being built inside, so the branch is never
 // assigned and every material would take the colour of the last line. `else if` keeps the
 // first-match order the five separate `if`s had, and `res` is seeded with the fall-through value.
 vec3 res=vec3(.1);
 if(mat<1.5){float moss=smoothstep(.46,.66,fbm2(p.xz*.3+p.y*.4))*smoothstep(.4,.9,n.y);res=mix(vec3(.075,.091,.090),vec3(.038,.068,.042),moss)*( .7+grit);}
 else if(mat<2.5){res=mix(vec3(.017,.034,.027),vec3(.045,.071,.047),noise2(p.xz*5.+p.y))*(.8+max(n.y,0.)*.35);}
 else if(mat<3.5)res=vec3(.060,.047,.036);
 else if(mat<4.5)res=vec3(.12,.155,.17)*( .8+grit);
 else if(mat>8.5){float seam=.75+.25*smoothstep(.01,.1,abs(fract(p.x*3.)-.5));res=vec3(.09,.13,.14)*seam;}
 return res;
}
vec3 surfaceLight(vec3 p,vec3 n,vec3 v,vec3 albedo,float rough){
 float hemi=.45+.55*max(n.y,0.);vec3 c=albedo*(uFill*hemi+uSunColor*max(dot(n,uSunDir),0.));
 c+=albedo*uFlash*(.6+max(dot(n,normalize(uStrike-p)),0.)*2.5)*uFlashLight;
 for(int i=0;i<6;i++){
  float z=-10.-float(i)*38.;vec3 lp=vec3(roadCenter(z)-3.90,7.87,z);vec3 l=lp-p;float dist2=dot(l,l);l=normalize(l);
  float ndl=max(dot(n,l),0.);float cone=smoothstep(.1,.62,-l.y)*smoothstep(-.1,.1,l.y);
  float atten=48./(1.+dist2);vec3 warm=uLampLight;
  c+=albedo*warm*atten*ndl*2.;
  vec3 hv=normalize(l+v);float shin=mix(20.,900.,1.-rough);float spec=pow(max(dot(n,hv),0.),shin)*(shin+2.)*.018;
  c+=warm*spec*atten*ndl*(rough>.55?.022:1.);
 }
 return c;
}
vec2 rippleSlope(vec2 p){
 vec2 cell=floor(p/2.2);vec2 sum=vec2(0.);
 for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){
  vec2 c=cell+vec2(float(i),float(j));float h=hash12(c+3.9);
  vec2 ctr=(c+vec2(h,hash12(c+19.)))*2.2;vec2 v=p-ctr;float d=length(v)+.001;
  float age=fract(uTime*(.60+uRain*.2)+h*7.3);float ring=d-age*1.7;
  float env=exp(-abs(ring)*20.)*(1.-age)*smoothstep(.025,.10,age);
  sum+=v/d*cos(ring*95.)*env*.055;
 }return sum*uRain;
}
vec3 reflected(vec3 p,vec3 rd,vec3 sky){
 // Same reason as baseColor: no early return. The `uReflect` guard becomes the condition around the
 // march, which is still a skip, and a hit becomes a `res` plus a `Break`, which is what the trace
 // already does. A ray that reaches the end of the march leaves `res` as the sky, as it did.
 vec3 res=sky;
 if(uReflect!=0){
  float t=.5;
  vec2 lastCell=vec2(1e9);float th=1e4;
  for(int i=0;i<36;i++){
   if(t>280.)break;
   vec3 q=p+rd*t;
   vec2 cell=treeCell(q.xz);
   if(cell.x!=lastCell.x||cell.y!=lastCell.y){th=cellBase(cell);lastCell=cell;}
   vec2 d=sceneAt(q,th,0.);
   if(d.x<max(.03,t*.0016)){
    if(d.y>5.5&&d.y<6.5)res=uLampGlow*.75;
    else res=mix(baseColor(q,d.y,vec3(0,1,0))*.7,hazeColor(rd),1.-exp(-t*(.0015+uFog*.004)));
    break;
   }t+=max(.15,d.x*.9);
  }
 }
 return res;
}
void main(){
 vec3 rd=ray(vUv);vec3 sky=texture(uSky,vUv).rgb;
 float planeT=rd.y<-.0001?-uCam.y/rd.y:2200.;
 vec3 pp=uCam+rd*planeT;
 bool water=pp.x>coast(pp.z)&&terrain(pp.xz)<0.;
 if(water&&rd.y<-.0001)planeT=(-.60-uCam.y)/rd.y;
 vec2 hit=trace(uCam,rd,min(planeT,2200.));
 float t=hit.x,mat=hit.y;vec3 p=uCam+rd*t;vec3 n;vec3 color=sky;
 bool ground=mat<0.&&planeT>0.&&planeT<1800.;
 if(ground){
  t=planeT;p=uCam+rd*t;
  float rx=abs(p.x-roadCenter(p.z));
  water=p.x>coast(p.z)&&terrain(p.xz)<0.;
  bool road=rx<5.35&&p.z> -190.;
  vec2 ripple=rippleSlope(p.xz);
  float coarse=noise2(p.xz*2.6),micro=noise2(p.xz*72.);
  float puddle=smoothstep(.37,.64,fbm2(p.xz*.25+7.))*uWet;
  if(water)puddle=1.;
  vec2 wave=vec2(cos(p.x*1.3+p.z*.8+uTime*1.7),sin(p.z*1.7-p.x*.4-uTime*1.2))*(water?.018:.0015);
  vec2 bump=(vec2(noise2(p.xz*35.),noise2(p.xz*35.+9.))-.5)*mix(.22,.013,puddle);
  n=normalize(vec3(bump.x+wave.x+ripple.x,1.,bump.y+wave.y+ripple.y));
  vec3 alb=road?vec3(.031,.037,.042)*( .58+coarse*.40+micro*.30):vec3(.075,.086,.070)*( .7+coarse*.45);
  float rough=mix(.70,.08,puddle);
  if(road){
   float center=p.x-roadCenter(p.z);
   float stripe=(1.-smoothstep(.042,.062,abs(abs(center)-.14)));
   float edge=(1.-smoothstep(.06,.085,abs(rx-5.04)));
   float wear=smoothstep(.1,.35,noise2(p.xz*26.));
   alb=mix(alb,vec3(.50,.36,.11),stripe*wear*.85);
   alb=mix(alb,vec3(.49,.54,.50),edge*wear*.60);
  }
  if(water){alb=uWater;rough=.045;}
  color=surfaceLight(p,n,-rd,alb,rough);
  float fres=.025+.975*pow(1.-max(dot(-rd,n),0.),5.);
  vec2 suv=clamp(vUv+vec2(n.x,n.z)*vec2(.07,.05),.002,.998);
  vec3 refl=reflected(p+n*.10,reflect(rd,n),texture(uSky,suv).rgb);
  float reflection=water?(.25+fres*.7):(uWet*.05+puddle*.23+fres*.50);
  color=mix(color,refl,clamp(reflection,0.,.94));
  // Tiny high-frequency impact coronas, strongest against dark wet tarmac.
  color+=length(ripple)*vec3(.055,.077,.09)*uRain;
  mat=water?8.:(road?7.:1.);
 }else if(mat>0.){
  n=getNormal(p,t);
  if(mat>5.5&&mat<6.5)color=uLampGlow;
  else color=surfaceLight(p,n,-rd,baseColor(p,mat,n),mat>3.5?.28:.88);
  float ao=clamp((p.y-terrain(p.xz))*.09+.50,.4,1.);if(mat!=6.)color*=ao;
 }
 if(mat>0.||ground){
  // Height-dependent aerial perspective with advected rain curtains.
  float curtain=.80+.40*fbm2(p.xz*.012+vec2(uTime*.014,0.));
  float fog=1.-exp(-t*(.0011+uFog*.0048)*curtain*exp(-max(p.y,0.)*.008));
  color=mix(color,hazeColor(rd),clamp(fog,0.,.98));
  float d=max(.15,t*dot(rd,uForward));gl_FragDepth=clamp(1.00006-.150009/d,0.,.999999);
 }else gl_FragDepth=1.;
 fragColor=vec4(max(color,vec3(0.)),1.);
