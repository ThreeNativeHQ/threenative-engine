WGSLDUMP fragment
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>,
	@builtin( frag_depth ) depth : f32
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 2 ) var nodeUniform7_sampler : sampler;
@binding( 1 ) @group( 2 ) var nodeUniform7 : texture_2d<f32>;

struct renderStruct {
	cameraNear : f32,
	cameraFar : f32
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

struct frameStruct {
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform24 : f32,
	nodeUniform11 : f32,
	nodeUniform16 : f32,
	nodeUniform4 : f32,
	nodeUniform5 : f32,
	nodeUniform8 : vec3<f32>,
	nodeUniform2 : vec3<f32>,
	nodeUniform3 : vec3<f32>,
	nodeUniform6 : vec3<f32>,
	nodeUniform17 : vec3<f32>,
	nodeUniform22 : vec3<f32>,
	nodeUniform23 : vec3<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform14 : vec3<f32>,
	nodeUniform13 : vec3<f32>,
	nodeUniform18 : vec3<f32>,
	nodeUniform19 : vec3<f32>,
	nodeUniform21 : vec3<f32>,
	nodeUniform12 : vec3<f32>,
	nodeUniform20 : i32
};
@binding( 0 ) @group( 1 )
var<uniform> frame : frameStruct;

// vars
var<private> nodeVar0 : f32;
var<private> nodeVar1 : vec2<f32>;
var<private> nodeVar2 : vec3<f32>;
var<private> nodeVar3 : vec4<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : vec3<f32>;
var<private> nodeVar8 : vec2<f32>;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : vec2<f32>;
var<private> nodeVar17 : vec2<f32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec3<f32>;
var<private> nodeVar20 : vec3<f32>;
var<private> nodeVar21 : vec3<f32>;
var<private> nodeVar22 : vec2<f32>;
var<private> nodeVar23 : vec2<f32>;
var<private> nodeVar24 : vec3<f32>;
var<private> nodeVar25 : vec3<f32>;
var<private> nodeVar26 : vec3<f32>;
var<private> nodeVar27 : vec3<f32>;
var<private> nodeVar28 : vec2<f32>;
var<private> nodeVar29 : vec2<f32>;
var<private> nodeVar30 : vec2<f32>;
var<private> nodeVar31 : vec3<f32>;
var<private> nodeVar32 : vec3<f32>;
var<private> nodeVar33 : vec3<f32>;
var<private> nodeVar34 : vec3<f32>;
var<private> nodeVar35 : f32;
var<private> nodeVar36 : vec2<f32>;
var<private> nodeVar37 : vec2<f32>;
var<private> nodeVar38 : vec2<f32>;
var<private> nodeVar39 : vec3<f32>;
var<private> nodeVar40 : vec3<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> nodeVar42 : vec3<f32>;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : f32;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : f32;
var<private> nodeVar47 : f32;
var<private> nodeVar48 : f32;
var<private> nodeVar49 : f32;
var<private> nodeVar50 : bool;
var<private> nodeVar51 : f32;
var<private> nodeVar52 : f32;
var<private> nodeVar53 : vec3<f32>;
var<private> nodeVar54 : vec2<f32>;
var<private> nodeVar55 : vec2<f32>;
var<private> nodeVar56 : vec2<f32>;
var<private> nodeVar57 : vec3<f32>;
var<private> nodeVar58 : vec3<f32>;
var<private> nodeVar59 : vec3<f32>;
var<private> nodeVar60 : vec3<f32>;
var<private> nodeVar61 : f32;
var<private> nodeVar62 : vec2<f32>;
var<private> nodeVar63 : vec2<f32>;
var<private> nodeVar64 : vec3<f32>;
var<private> nodeVar65 : vec3<f32>;
var<private> nodeVar66 : vec3<f32>;
var<private> nodeVar67 : vec3<f32>;
var<private> nodeVar68 : vec2<f32>;
var<private> nodeVar69 : vec2<f32>;
var<private> nodeVar70 : vec3<f32>;
var<private> nodeVar71 : vec3<f32>;
var<private> nodeVar72 : vec3<f32>;
var<private> nodeVar73 : vec3<f32>;
var<private> nodeVar74 : vec2<f32>;
var<private> nodeVar75 : vec2<f32>;
var<private> nodeVar76 : vec2<f32>;
var<private> nodeVar77 : vec3<f32>;
var<private> nodeVar78 : vec3<f32>;
var<private> nodeVar79 : vec3<f32>;
var<private> nodeVar80 : vec3<f32>;
var<private> nodeVar81 : f32;
var<private> nodeVar82 : vec2<f32>;
var<private> nodeVar83 : vec2<f32>;
var<private> nodeVar84 : vec2<f32>;
var<private> nodeVar85 : vec3<f32>;
var<private> nodeVar86 : vec3<f32>;
var<private> nodeVar87 : vec3<f32>;
var<private> nodeVar88 : vec3<f32>;
var<private> nodeVar89 : f32;
var<private> nodeVar90 : f32;
var<private> nodeVar91 : f32;
var<private> nodeVar92 : f32;
var<private> nodeVar93 : f32;
var<private> nodeVar94 : f32;
var<private> nodeVar95 : f32;
var<private> nodeVar96 : f32;
var<private> nodeVar97 : f32;
var<private> nodeVar98 : vec2<f32>;
var<private> nodeVar99 : vec2<f32>;
var<private> nodeVar100 : vec3<f32>;
var<private> nodeVar101 : f32;
var<private> nodeVar102 : vec3<f32>;
var<private> nodeVar103 : vec3<f32>;
var<private> nodeVar104 : vec2<f32>;
var<private> nodeVar105 : vec2<f32>;
var<private> nodeVar106 : vec2<f32>;
var<private> nodeVar107 : vec2<f32>;
var<private> nodeVar108 : vec3<f32>;
var<private> nodeVar109 : vec3<f32>;
var<private> nodeVar110 : vec3<f32>;
var<private> nodeVar111 : vec3<f32>;
var<private> nodeVar112 : f32;
var<private> nodeVar113 : vec2<f32>;
var<private> nodeVar114 : vec2<f32>;
var<private> nodeVar115 : vec3<f32>;
var<private> nodeVar116 : vec3<f32>;
var<private> nodeVar117 : vec3<f32>;
var<private> nodeVar118 : vec3<f32>;
var<private> nodeVar119 : vec2<f32>;
var<private> nodeVar120 : vec2<f32>;
var<private> nodeVar121 : vec3<f32>;
var<private> nodeVar122 : vec3<f32>;
var<private> nodeVar123 : vec3<f32>;
var<private> nodeVar124 : vec3<f32>;
var<private> nodeVar125 : vec2<f32>;
var<private> nodeVar126 : vec2<f32>;
var<private> nodeVar127 : vec2<f32>;
var<private> nodeVar128 : vec3<f32>;
var<private> nodeVar129 : vec3<f32>;
var<private> nodeVar130 : vec3<f32>;
var<private> nodeVar131 : vec3<f32>;
var<private> nodeVar132 : f32;
var<private> nodeVar133 : vec2<f32>;
var<private> nodeVar134 : vec2<f32>;
var<private> nodeVar135 : vec2<f32>;
var<private> nodeVar136 : vec3<f32>;
var<private> nodeVar137 : vec3<f32>;
var<private> nodeVar138 : vec3<f32>;
var<private> nodeVar139 : vec3<f32>;
var<private> nodeVar140 : f32;
var<private> nodeVar141 : f32;
var<private> nodeVar142 : f32;
var<private> nodeVar143 : f32;
var<private> nodeVar144 : f32;
var<private> nodeVar145 : f32;
var<private> nodeVar146 : f32;
var<private> nodeVar147 : f32;
var<private> nodeVar148 : f32;
var<private> nodeVar149 : bool;
var<private> nodeVar150 : vec3<f32>;
var<private> nodeVar151 : f32;
var<private> nodeVar152 : f32;
var<private> nodeVar153 : f32;
var<private> nodeVar154 : f32;
var<private> nodeVar155 : f32;
var<private> nodeVar156 : vec2<f32>;
var<private> nodeVar157 : vec2<f32>;
var<private> nodeVar158 : vec2<f32>;
var<private> nodeVar159 : vec3<f32>;
var<private> nodeVar160 : vec3<f32>;
var<private> nodeVar161 : vec3<f32>;
var<private> nodeVar162 : vec3<f32>;
var<private> nodeVar163 : f32;
var<private> nodeVar164 : f32;
var<private> nodeVar165 : vec2<f32>;
var<private> nodeVar166 : vec2<f32>;
var<private> nodeVar167 : vec2<f32>;
var<private> nodeVar168 : vec2<f32>;
var<private> nodeVar169 : f32;
var<private> nodeVar170 : f32;
var<private> nodeVar171 : f32;
var<private> nodeVar172 : vec3<f32>;
var<private> nodeVar173 : vec3<f32>;
var<private> nodeVar174 : vec3<f32>;
var<private> nodeVar175 : f32;
var<private> nodeVar176 : vec3<f32>;
var<private> nodeVar177 : vec3<f32>;
var<private> nodeVar178 : vec3<f32>;
var<private> nodeVar179 : vec3<f32>;
var<private> nodeVar180 : vec3<f32>;
var<private> nodeVar181 : vec2<f32>;
var<private> nodeVar182 : vec2<f32>;
var<private> nodeVar183 : vec2<f32>;
var<private> nodeVar184 : vec3<f32>;
var<private> nodeVar185 : vec2<f32>;
var<private> nodeVar186 : f32;
var<private> nodeVar187 : vec3<f32>;
var<private> nodeVar188 : f32;
var<private> nodeVar189 : f32;
var<private> nodeVar190 : vec3<f32>;
var<private> nodeVar191 : vec2<f32>;
var<private> nodeVar192 : vec2<f32>;
var<private> nodeVar193 : vec3<f32>;
var<private> nodeVar194 : vec3<f32>;
var<private> nodeVar195 : f32;
var<private> nodeVar196 : vec2<f32>;
var<private> nodeVar197 : vec2<f32>;
var<private> nodeVar198 : vec2<f32>;
var<private> nodeVar199 : vec3<f32>;
var<private> nodeVar200 : vec2<f32>;
var<private> nodeVar201 : vec2<f32>;
var<private> nodeVar202 : vec3<f32>;
var<private> nodeVar203 : vec2<f32>;
var<private> nodeVar204 : vec2<f32>;
var<private> nodeVar205 : vec3<f32>;
var<private> nodeVar206 : vec3<f32>;
var<private> nodeVar207 : vec2<f32>;
var<private> nodeVar208 : vec2<f32>;
var<private> nodeVar209 : f32;
var<private> nodeVar210 : f32;
var<private> nodeVar211 : vec2<f32>;
var<private> nodeVar212 : f32;
var<private> nodeVar213 : f32;
var<private> nodeVar214 : vec3<f32>;
var<private> nodeVar215 : vec3<f32>;
var<private> nodeVar216 : vec3<f32>;
var<private> nodeVar217 : vec3<f32>;
var<private> nodeVar218 : bool;
var<private> nodeVar219 : f32;
var<private> nodeVar220 : vec2<f32>;
var<private> nodeVar221 : vec2<f32>;
var<private> nodeVar222 : vec2<f32>;
var<private> nodeVar223 : vec3<f32>;
var<private> nodeVar224 : vec3<f32>;
var<private> nodeVar225 : vec3<f32>;
var<private> nodeVar226 : vec3<f32>;
var<private> nodeVar227 : f32;
var<private> nodeVar228 : vec2<f32>;
var<private> nodeVar229 : vec2<f32>;
var<private> nodeVar230 : vec3<f32>;
var<private> nodeVar231 : vec3<f32>;
var<private> nodeVar232 : vec3<f32>;
var<private> nodeVar233 : vec3<f32>;
var<private> nodeVar234 : vec2<f32>;
var<private> nodeVar235 : vec2<f32>;
var<private> nodeVar236 : vec3<f32>;
var<private> nodeVar237 : vec3<f32>;
var<private> nodeVar238 : vec3<f32>;
var<private> nodeVar239 : vec3<f32>;
var<private> nodeVar240 : vec2<f32>;
var<private> nodeVar241 : vec2<f32>;
var<private> nodeVar242 : vec2<f32>;
var<private> nodeVar243 : vec3<f32>;
var<private> nodeVar244 : vec3<f32>;
var<private> nodeVar245 : vec3<f32>;
var<private> nodeVar246 : vec3<f32>;
var<private> nodeVar247 : f32;
var<private> nodeVar248 : vec2<f32>;
var<private> nodeVar249 : vec2<f32>;
var<private> nodeVar250 : vec2<f32>;
var<private> nodeVar251 : vec3<f32>;
var<private> nodeVar252 : vec3<f32>;
var<private> nodeVar253 : vec3<f32>;
var<private> nodeVar254 : vec3<f32>;
var<private> nodeVar255 : f32;
var<private> nodeVar256 : f32;
var<private> nodeVar257 : f32;
var<private> nodeVar258 : f32;
var<private> nodeVar259 : f32;
var<private> nodeVar260 : f32;
var<private> nodeVar261 : f32;
var<private> nodeVar262 : bool;
var<private> nodeVar263 : vec2<f32>;
var<private> nodeVar264 : vec2<f32>;
var<private> nodeVar265 : vec2<f32>;
var<private> nodeVar266 : vec3<f32>;
var<private> nodeVar267 : f32;
var<private> nodeVar268 : vec3<f32>;
var<private> nodeVar269 : vec2<f32>;
var<private> nodeVar270 : vec2<f32>;
var<private> nodeVar271 : f32;
var<private> nodeVar272 : f32;
var<private> nodeVar273 : f32;
var<private> nodeVar274 : f32;
var<private> nodeVar275 : vec2<f32>;
var<private> nodeVar276 : vec2<f32>;
var<private> nodeVar277 : vec2<f32>;
var<private> nodeVar278 : vec2<f32>;
var<private> nodeVar279 : vec3<f32>;
var<private> nodeVar280 : vec3<f32>;
var<private> nodeVar281 : vec3<f32>;
var<private> nodeVar282 : vec3<f32>;
var<private> nodeVar283 : f32;
var<private> nodeVar284 : vec2<f32>;
var<private> nodeVar285 : vec2<f32>;
var<private> nodeVar286 : vec2<f32>;
var<private> nodeVar287 : vec3<f32>;
var<private> nodeVar288 : vec3<f32>;
var<private> nodeVar289 : vec3<f32>;
var<private> nodeVar290 : vec3<f32>;
var<private> nodeVar291 : f32;
var<private> nodeVar292 : vec2<f32>;
var<private> nodeVar293 : vec2<f32>;
var<private> nodeVar294 : vec2<f32>;
var<private> nodeVar295 : vec3<f32>;
var<private> nodeVar296 : vec3<f32>;
var<private> nodeVar297 : vec3<f32>;
var<private> nodeVar298 : vec3<f32>;
var<private> nodeVar299 : f32;
var<private> nodeVar300 : vec2<f32>;
var<private> nodeVar301 : vec2<f32>;
var<private> nodeVar302 : vec3<f32>;
var<private> nodeVar303 : vec3<f32>;
var<private> nodeVar304 : vec3<f32>;
var<private> nodeVar305 : vec3<f32>;
var<private> nodeVar306 : vec2<f32>;
var<private> nodeVar307 : vec2<f32>;
var<private> nodeVar308 : vec3<f32>;
var<private> nodeVar309 : vec3<f32>;
var<private> nodeVar310 : vec3<f32>;
var<private> nodeVar311 : vec3<f32>;
var<private> nodeVar312 : vec2<f32>;
var<private> nodeVar313 : vec2<f32>;
var<private> nodeVar314 : vec2<f32>;
var<private> nodeVar315 : vec3<f32>;
var<private> nodeVar316 : vec3<f32>;
var<private> nodeVar317 : vec3<f32>;
var<private> nodeVar318 : vec3<f32>;
var<private> nodeVar319 : f32;
var<private> nodeVar320 : f32;
var<private> nodeVar321 : vec2<f32>;
var<private> nodeVar322 : vec2<f32>;
var<private> nodeVar323 : vec2<f32>;
var<private> nodeVar324 : vec2<f32>;
var<private> nodeVar325 : vec3<f32>;
var<private> nodeVar326 : vec3<f32>;
var<private> nodeVar327 : vec3<f32>;
var<private> nodeVar328 : vec3<f32>;
var<private> nodeVar329 : vec2<f32>;
var<private> nodeVar330 : vec2<f32>;
var<private> nodeVar331 : vec2<f32>;
var<private> nodeVar332 : vec3<f32>;
var<private> nodeVar333 : vec3<f32>;
var<private> nodeVar334 : vec3<f32>;
var<private> nodeVar335 : vec3<f32>;
var<private> nodeVar336 : vec2<f32>;
var<private> nodeVar337 : vec3<f32>;
var<private> nodeVar338 : vec3<f32>;
var<private> nodeVar339 : f32;
var<private> nodeVar340 : f32;
var<private> nodeVar341 : f32;
var<private> nodeVar342 : f32;
var<private> nodeVar343 : vec2<f32>;
var<private> nodeVar344 : vec2<f32>;
var<private> nodeVar345 : vec2<f32>;
var<private> nodeVar346 : vec3<f32>;
var<private> nodeVar347 : vec3<f32>;
var<private> nodeVar348 : vec3<f32>;
var<private> nodeVar349 : vec3<f32>;
var<private> nodeVar350 : f32;
var<private> nodeVar351 : f32;
var<private> nodeVar352 : vec3<f32>;
var<private> nodeVar353 : f32;
var<private> nodeVar354 : vec3<f32>;
var<private> nodeVar355 : vec3<f32>;
var<private> nodeVar356 : f32;
var<private> nodeVar357 : f32;
var<private> nodeVar358 : f32;
var<private> nodeVar359 : f32;
var<private> nodeVar360 : vec3<f32>;
var<private> nodeVar361 : vec3<f32>;
var<private> nodeVar362 : f32;
var<private> nodeVar363 : f32;
var<private> nodeVar364 : f32;
var<private> nodeVar365 : f32;
var<private> nodeVar366 : vec2<f32>;
var<private> nodeVar367 : vec4<f32>;
var<private> nodeVar368 : vec3<f32>;
var<private> nodeVar369 : f32;
var<private> nodeVar370 : vec3<f32>;
var<private> nodeVar371 : vec3<f32>;
var<private> nodeVar372 : vec2<f32>;
var<private> nodeVar373 : vec2<f32>;
var<private> nodeVar374 : vec2<f32>;
var<private> nodeVar375 : vec3<f32>;
var<private> nodeVar376 : vec3<f32>;
var<private> nodeVar377 : vec3<f32>;
var<private> nodeVar378 : vec3<f32>;
var<private> nodeVar379 : f32;
var<private> nodeVar380 : vec2<f32>;
var<private> nodeVar381 : vec2<f32>;
var<private> nodeVar382 : vec3<f32>;
var<private> nodeVar383 : vec3<f32>;
var<private> nodeVar384 : vec3<f32>;
var<private> nodeVar385 : vec3<f32>;
var<private> nodeVar386 : vec2<f32>;
var<private> nodeVar387 : vec2<f32>;
var<private> nodeVar388 : vec3<f32>;
var<private> nodeVar389 : vec3<f32>;
var<private> nodeVar390 : vec3<f32>;
var<private> nodeVar391 : vec3<f32>;
var<private> nodeVar392 : vec2<f32>;
var<private> nodeVar393 : vec2<f32>;
var<private> nodeVar394 : vec2<f32>;
var<private> nodeVar395 : vec3<f32>;
var<private> nodeVar396 : vec3<f32>;
var<private> nodeVar397 : vec3<f32>;
var<private> nodeVar398 : vec3<f32>;
var<private> nodeVar399 : f32;
var<private> nodeVar400 : vec2<f32>;
var<private> nodeVar401 : vec2<f32>;
var<private> nodeVar402 : vec2<f32>;
var<private> nodeVar403 : vec3<f32>;
var<private> nodeVar404 : vec3<f32>;
var<private> nodeVar405 : vec3<f32>;
var<private> nodeVar406 : vec3<f32>;
var<private> nodeVar407 : f32;
var<private> nodeVar408 : f32;
var<private> nodeVar409 : f32;
var<private> nodeVar410 : f32;
var<private> nodeVar411 : f32;
var<private> nodeVar412 : f32;
var<private> nodeVar413 : f32;
var<private> nodeVar414 : f32;
var<private> nodeVar415 : f32;
var<private> nodeVar416 : vec2<f32>;
var<private> nodeVar417 : vec2<f32>;
var<private> nodeVar418 : vec3<f32>;
var<private> nodeVar419 : f32;
var<private> nodeVar420 : vec3<f32>;
var<private> nodeVar421 : vec3<f32>;
var<private> nodeVar422 : vec2<f32>;
var<private> nodeVar423 : vec2<f32>;
var<private> nodeVar424 : vec2<f32>;
var<private> nodeVar425 : vec2<f32>;
var<private> nodeVar426 : vec3<f32>;
var<private> nodeVar427 : vec3<f32>;
var<private> nodeVar428 : vec3<f32>;
var<private> nodeVar429 : vec3<f32>;
var<private> nodeVar430 : f32;
var<private> nodeVar431 : vec2<f32>;
var<private> nodeVar432 : vec2<f32>;
var<private> nodeVar433 : vec3<f32>;
var<private> nodeVar434 : vec3<f32>;
var<private> nodeVar435 : vec3<f32>;
var<private> nodeVar436 : vec3<f32>;
var<private> nodeVar437 : vec2<f32>;
var<private> nodeVar438 : vec2<f32>;
var<private> nodeVar439 : vec3<f32>;
var<private> nodeVar440 : vec3<f32>;
var<private> nodeVar441 : vec3<f32>;
var<private> nodeVar442 : vec3<f32>;
var<private> nodeVar443 : vec2<f32>;
var<private> nodeVar444 : vec2<f32>;
var<private> nodeVar445 : vec2<f32>;
var<private> nodeVar446 : vec3<f32>;
var<private> nodeVar447 : vec3<f32>;
var<private> nodeVar448 : vec3<f32>;
var<private> nodeVar449 : vec3<f32>;
var<private> nodeVar450 : f32;
var<private> nodeVar451 : vec2<f32>;
var<private> nodeVar452 : vec2<f32>;
var<private> nodeVar453 : vec2<f32>;
var<private> nodeVar454 : vec3<f32>;
var<private> nodeVar455 : vec3<f32>;
var<private> nodeVar456 : vec3<f32>;
var<private> nodeVar457 : vec3<f32>;
var<private> nodeVar458 : f32;
var<private> nodeVar459 : f32;
var<private> nodeVar460 : f32;
var<private> nodeVar461 : f32;
var<private> nodeVar462 : f32;
var<private> nodeVar463 : f32;
var<private> nodeVar464 : f32;
var<private> nodeVar465 : f32;
var<private> nodeVar466 : f32;
var<private> nodeVar467 : bool;
var<private> nodeVar468 : vec3<f32>;
var<private> nodeVar469 : f32;
var<private> nodeVar470 : f32;
var<private> nodeVar471 : f32;
var<private> nodeVar472 : f32;
var<private> nodeVar473 : f32;
var<private> nodeVar474 : vec2<f32>;
var<private> nodeVar475 : vec2<f32>;
var<private> nodeVar476 : vec2<f32>;
var<private> nodeVar477 : vec3<f32>;
var<private> nodeVar478 : vec3<f32>;
var<private> nodeVar479 : vec3<f32>;
var<private> nodeVar480 : vec3<f32>;
var<private> nodeVar481 : f32;
var<private> nodeVar482 : f32;
var<private> nodeVar483 : vec2<f32>;
var<private> nodeVar484 : vec2<f32>;
var<private> nodeVar485 : vec2<f32>;
var<private> nodeVar486 : vec2<f32>;
var<private> nodeVar487 : f32;
var<private> nodeVar488 : f32;
var<private> nodeVar489 : f32;
var<private> nodeVar490 : vec3<f32>;
var<private> nodeVar491 : vec3<f32>;
var<private> nodeVar492 : vec3<f32>;
var<private> nodeVar493 : f32;
var<private> nodeVar494 : vec3<f32>;
var<private> nodeVar495 : vec3<f32>;
var<private> nodeVar496 : vec3<f32>;
var<private> nodeVar497 : vec3<f32>;
var<private> nodeVar498 : vec3<f32>;
var<private> nodeVar499 : vec2<f32>;
var<private> nodeVar500 : vec2<f32>;
var<private> nodeVar501 : vec2<f32>;
var<private> nodeVar502 : vec3<f32>;
var<private> nodeVar503 : vec2<f32>;
var<private> nodeVar504 : f32;
var<private> nodeVar505 : vec3<f32>;
var<private> nodeVar506 : f32;
var<private> nodeVar507 : f32;
var<private> nodeVar508 : vec3<f32>;
var<private> nodeVar509 : vec2<f32>;
var<private> nodeVar510 : vec2<f32>;
var<private> nodeVar511 : vec3<f32>;
var<private> nodeVar512 : vec3<f32>;
var<private> nodeVar513 : f32;
var<private> nodeVar514 : vec2<f32>;
var<private> nodeVar515 : vec2<f32>;
var<private> nodeVar516 : vec2<f32>;
var<private> nodeVar517 : vec3<f32>;
var<private> nodeVar518 : vec2<f32>;
var<private> nodeVar519 : vec2<f32>;
var<private> nodeVar520 : vec3<f32>;
var<private> nodeVar521 : vec2<f32>;
var<private> nodeVar522 : vec2<f32>;
var<private> nodeVar523 : vec3<f32>;
var<private> nodeVar524 : vec3<f32>;
var<private> nodeVar525 : vec2<f32>;
var<private> nodeVar526 : vec2<f32>;
var<private> nodeVar527 : vec2<f32>;
var<private> nodeVar528 : vec2<f32>;
var<private> nodeVar529 : vec2<f32>;
var<private> nodeVar530 : vec3<f32>;
var<private> nodeVar531 : vec3<f32>;
var<private> nodeVar532 : vec3<f32>;
var<private> nodeVar533 : vec3<f32>;
var<private> nodeVar534 : vec2<f32>;
var<private> nodeVar535 : vec2<f32>;
var<private> nodeVar536 : vec2<f32>;
var<private> nodeVar537 : vec3<f32>;
var<private> nodeVar538 : vec3<f32>;
var<private> nodeVar539 : vec3<f32>;
var<private> nodeVar540 : vec3<f32>;
var<private> nodeVar541 : f32;
var<private> nodeVar542 : vec3<f32>;
var<private> nodeVar543 : vec2<f32>;
var<private> nodeVar544 : vec2<f32>;
var<private> nodeVar545 : vec2<f32>;
var<private> nodeVar546 : vec3<f32>;
var<private> nodeVar547 : vec3<f32>;
var<private> nodeVar548 : vec3<f32>;
var<private> nodeVar549 : vec3<f32>;
var<private> nodeVar550 : f32;
var<private> nodeVar551 : vec2<f32>;
var<private> nodeVar552 : vec2<f32>;
var<private> nodeVar553 : vec3<f32>;
var<private> nodeVar554 : vec3<f32>;
var<private> nodeVar555 : vec3<f32>;
var<private> nodeVar556 : vec3<f32>;
var<private> nodeVar557 : vec2<f32>;
var<private> nodeVar558 : vec2<f32>;
var<private> nodeVar559 : vec3<f32>;
var<private> nodeVar560 : vec3<f32>;
var<private> nodeVar561 : vec3<f32>;
var<private> nodeVar562 : vec3<f32>;
var<private> nodeVar563 : vec2<f32>;
var<private> nodeVar564 : vec2<f32>;
var<private> nodeVar565 : vec2<f32>;
var<private> nodeVar566 : vec3<f32>;
var<private> nodeVar567 : vec3<f32>;
var<private> nodeVar568 : vec3<f32>;
var<private> nodeVar569 : vec3<f32>;
var<private> nodeVar570 : f32;
var<private> nodeVar571 : vec2<f32>;
var<private> nodeVar572 : vec2<f32>;
var<private> nodeVar573 : vec2<f32>;
var<private> nodeVar574 : vec3<f32>;
var<private> nodeVar575 : vec3<f32>;
var<private> nodeVar576 : vec3<f32>;
var<private> nodeVar577 : vec3<f32>;
var<private> nodeVar578 : f32;
var<private> nodeVar579 : vec3<f32>;
var<private> nodeVar580 : f32;
var<private> nodeVar581 : f32;
var<private> nodeVar582 : f32;
var<private> nodeVar583 : f32;
var<private> nodeVar584 : f32;
var<private> nodeVar585 : vec2<f32>;
var<private> nodeVar586 : vec3<f32>;
var<private> nodeVar587 : vec2<f32>;
var<private> nodeVar588 : vec2<f32>;
var<private> nodeVar589 : vec2<f32>;
var<private> nodeVar590 : vec3<f32>;
var<private> nodeVar591 : vec3<f32>;
var<private> nodeVar592 : vec3<f32>;
var<private> nodeVar593 : vec3<f32>;
var<private> nodeVar594 : f32;
var<private> nodeVar595 : vec2<f32>;
var<private> nodeVar596 : vec2<f32>;
var<private> nodeVar597 : vec3<f32>;
var<private> nodeVar598 : vec3<f32>;
var<private> nodeVar599 : vec3<f32>;
var<private> nodeVar600 : vec3<f32>;
var<private> nodeVar601 : vec2<f32>;
var<private> nodeVar602 : vec2<f32>;
var<private> nodeVar603 : vec3<f32>;
var<private> nodeVar604 : vec3<f32>;
var<private> nodeVar605 : vec3<f32>;
var<private> nodeVar606 : vec3<f32>;
var<private> nodeVar607 : vec2<f32>;
var<private> nodeVar608 : vec2<f32>;
var<private> nodeVar609 : vec2<f32>;
var<private> nodeVar610 : vec3<f32>;
var<private> nodeVar611 : vec3<f32>;
var<private> nodeVar612 : vec3<f32>;
var<private> nodeVar613 : vec3<f32>;
var<private> nodeVar614 : f32;
var<private> nodeVar615 : vec2<f32>;
var<private> nodeVar616 : vec2<f32>;
var<private> nodeVar617 : vec2<f32>;
var<private> nodeVar618 : vec3<f32>;
var<private> nodeVar619 : vec3<f32>;
var<private> nodeVar620 : vec3<f32>;
var<private> nodeVar621 : vec3<f32>;
var<private> nodeVar622 : f32;
var<private> nodeVar623 : f32;
var<private> nodeVar624 : f32;
var<private> nodeVar625 : f32;
var<private> nodeVar626 : f32;
var<private> nodeVar627 : f32;
var<private> nodeVar628 : f32;
var<private> nodeVar629 : f32;
var<private> nodeVar630 : f32;
var<private> nodeVar631 : vec2<f32>;
var<private> nodeVar632 : vec2<f32>;
var<private> nodeVar633 : vec3<f32>;
var<private> nodeVar634 : f32;
var<private> nodeVar635 : vec3<f32>;
var<private> nodeVar636 : vec3<f32>;
var<private> nodeVar637 : vec2<f32>;
var<private> nodeVar638 : vec2<f32>;
var<private> nodeVar639 : vec2<f32>;
var<private> nodeVar640 : vec2<f32>;
var<private> nodeVar641 : vec3<f32>;
var<private> nodeVar642 : vec3<f32>;
var<private> nodeVar643 : vec3<f32>;
var<private> nodeVar644 : vec3<f32>;
var<private> nodeVar645 : f32;
var<private> nodeVar646 : vec2<f32>;
var<private> nodeVar647 : vec2<f32>;
var<private> nodeVar648 : vec3<f32>;
var<private> nodeVar649 : vec3<f32>;
var<private> nodeVar650 : vec3<f32>;
var<private> nodeVar651 : vec3<f32>;
var<private> nodeVar652 : vec2<f32>;
var<private> nodeVar653 : vec2<f32>;
var<private> nodeVar654 : vec3<f32>;
var<private> nodeVar655 : vec3<f32>;
var<private> nodeVar656 : vec3<f32>;
var<private> nodeVar657 : vec3<f32>;
var<private> nodeVar658 : vec2<f32>;
var<private> nodeVar659 : vec2<f32>;
var<private> nodeVar660 : vec2<f32>;
var<private> nodeVar661 : vec3<f32>;
var<private> nodeVar662 : vec3<f32>;
var<private> nodeVar663 : vec3<f32>;
var<private> nodeVar664 : vec3<f32>;
var<private> nodeVar665 : f32;
var<private> nodeVar666 : vec2<f32>;
var<private> nodeVar667 : vec2<f32>;
var<private> nodeVar668 : vec2<f32>;
var<private> nodeVar669 : vec3<f32>;
var<private> nodeVar670 : vec3<f32>;
var<private> nodeVar671 : vec3<f32>;
var<private> nodeVar672 : vec3<f32>;
var<private> nodeVar673 : f32;
var<private> nodeVar674 : f32;
var<private> nodeVar675 : f32;
var<private> nodeVar676 : f32;
var<private> nodeVar677 : f32;
var<private> nodeVar678 : f32;
var<private> nodeVar679 : f32;
var<private> nodeVar680 : f32;
var<private> nodeVar681 : f32;
var<private> nodeVar682 : bool;
var<private> nodeVar683 : vec3<f32>;
var<private> nodeVar684 : f32;
var<private> nodeVar685 : f32;
var<private> nodeVar686 : f32;
var<private> nodeVar687 : f32;
var<private> nodeVar688 : f32;
var<private> nodeVar689 : vec2<f32>;
var<private> nodeVar690 : vec2<f32>;
var<private> nodeVar691 : vec2<f32>;
var<private> nodeVar692 : vec3<f32>;
var<private> nodeVar693 : vec3<f32>;
var<private> nodeVar694 : vec3<f32>;
var<private> nodeVar695 : vec3<f32>;
var<private> nodeVar696 : f32;
var<private> nodeVar697 : f32;
var<private> nodeVar698 : vec2<f32>;
var<private> nodeVar699 : vec2<f32>;
var<private> nodeVar700 : vec2<f32>;
var<private> nodeVar701 : vec2<f32>;
var<private> nodeVar702 : f32;
var<private> nodeVar703 : f32;
var<private> nodeVar704 : f32;
var<private> nodeVar705 : vec3<f32>;
var<private> nodeVar706 : vec3<f32>;
var<private> nodeVar707 : vec3<f32>;
var<private> nodeVar708 : f32;
var<private> nodeVar709 : vec3<f32>;
var<private> nodeVar710 : vec3<f32>;
var<private> nodeVar711 : vec3<f32>;
var<private> nodeVar712 : vec3<f32>;
var<private> nodeVar713 : vec3<f32>;
var<private> nodeVar714 : vec2<f32>;
var<private> nodeVar715 : vec2<f32>;
var<private> nodeVar716 : vec2<f32>;
var<private> nodeVar717 : vec3<f32>;
var<private> nodeVar718 : vec2<f32>;
var<private> nodeVar719 : f32;
var<private> nodeVar720 : vec3<f32>;
var<private> nodeVar721 : f32;
var<private> nodeVar722 : f32;
var<private> nodeVar723 : vec3<f32>;
var<private> nodeVar724 : vec2<f32>;
var<private> nodeVar725 : vec2<f32>;
var<private> nodeVar726 : vec3<f32>;
var<private> nodeVar727 : vec3<f32>;
var<private> nodeVar728 : f32;
var<private> nodeVar729 : vec2<f32>;
var<private> nodeVar730 : vec2<f32>;
var<private> nodeVar731 : vec2<f32>;
var<private> nodeVar732 : vec3<f32>;
var<private> nodeVar733 : vec2<f32>;
var<private> nodeVar734 : vec2<f32>;
var<private> nodeVar735 : vec3<f32>;
var<private> nodeVar736 : vec2<f32>;
var<private> nodeVar737 : vec2<f32>;
var<private> nodeVar738 : vec3<f32>;
var<private> nodeVar739 : vec3<f32>;
var<private> nodeVar740 : vec2<f32>;
var<private> nodeVar741 : vec3<f32>;
var<private> nodeVar742 : vec2<f32>;
var<private> nodeVar743 : vec2<f32>;
var<private> nodeVar744 : vec2<f32>;
var<private> nodeVar745 : vec3<f32>;
var<private> nodeVar746 : vec3<f32>;
var<private> nodeVar747 : vec3<f32>;
var<private> nodeVar748 : vec3<f32>;
var<private> nodeVar749 : f32;
var<private> nodeVar750 : vec2<f32>;
var<private> nodeVar751 : vec2<f32>;
var<private> nodeVar752 : vec3<f32>;
var<private> nodeVar753 : vec3<f32>;
var<private> nodeVar754 : vec3<f32>;
var<private> nodeVar755 : vec3<f32>;
var<private> nodeVar756 : vec2<f32>;
var<private> nodeVar757 : vec2<f32>;
var<private> nodeVar758 : vec3<f32>;
var<private> nodeVar759 : vec3<f32>;
var<private> nodeVar760 : vec3<f32>;
var<private> nodeVar761 : vec3<f32>;
var<private> nodeVar762 : vec2<f32>;
var<private> nodeVar763 : vec2<f32>;
var<private> nodeVar764 : vec2<f32>;
var<private> nodeVar765 : vec3<f32>;
var<private> nodeVar766 : vec3<f32>;
var<private> nodeVar767 : vec3<f32>;
var<private> nodeVar768 : vec3<f32>;
var<private> nodeVar769 : f32;
var<private> nodeVar770 : vec2<f32>;
var<private> nodeVar771 : vec2<f32>;
var<private> nodeVar772 : vec2<f32>;
var<private> nodeVar773 : vec3<f32>;
var<private> nodeVar774 : vec3<f32>;
var<private> nodeVar775 : vec3<f32>;
var<private> nodeVar776 : vec3<f32>;
var<private> nodeVar777 : f32;
var<private> nodeVar778 : f32;
var<private> nodeVar779 : f32;
var<private> nodeVar780 : f32;
var<private> nodeVar781 : f32;
var<private> nodeVar782 : f32;
var<private> nodeVar783 : f32;
var<private> nodeVar784 : f32;
var<private> nodeVar785 : f32;
var<private> nodeVar786 : vec2<f32>;
var<private> nodeVar787 : vec2<f32>;
var<private> nodeVar788 : vec3<f32>;
var<private> nodeVar789 : f32;
var<private> nodeVar790 : vec3<f32>;
var<private> nodeVar791 : vec3<f32>;
var<private> nodeVar792 : vec2<f32>;
var<private> nodeVar793 : vec2<f32>;
var<private> nodeVar794 : vec2<f32>;
var<private> nodeVar795 : vec2<f32>;
var<private> nodeVar796 : vec3<f32>;
var<private> nodeVar797 : vec3<f32>;
var<private> nodeVar798 : vec3<f32>;
var<private> nodeVar799 : vec3<f32>;
var<private> nodeVar800 : f32;
var<private> nodeVar801 : vec2<f32>;
var<private> nodeVar802 : vec2<f32>;
var<private> nodeVar803 : vec3<f32>;
var<private> nodeVar804 : vec3<f32>;
var<private> nodeVar805 : vec3<f32>;
var<private> nodeVar806 : vec3<f32>;
var<private> nodeVar807 : vec2<f32>;
var<private> nodeVar808 : vec2<f32>;
var<private> nodeVar809 : vec3<f32>;
var<private> nodeVar810 : vec3<f32>;
var<private> nodeVar811 : vec3<f32>;
var<private> nodeVar812 : vec3<f32>;
var<private> nodeVar813 : vec2<f32>;
var<private> nodeVar814 : vec2<f32>;
var<private> nodeVar815 : vec2<f32>;
var<private> nodeVar816 : vec3<f32>;
var<private> nodeVar817 : vec3<f32>;
var<private> nodeVar818 : vec3<f32>;
var<private> nodeVar819 : vec3<f32>;
var<private> nodeVar820 : f32;
var<private> nodeVar821 : vec2<f32>;
var<private> nodeVar822 : vec2<f32>;
var<private> nodeVar823 : vec2<f32>;
var<private> nodeVar824 : vec3<f32>;
var<private> nodeVar825 : vec3<f32>;
var<private> nodeVar826 : vec3<f32>;
var<private> nodeVar827 : vec3<f32>;
var<private> nodeVar828 : f32;
var<private> nodeVar829 : f32;
var<private> nodeVar830 : f32;
var<private> nodeVar831 : f32;
var<private> nodeVar832 : f32;
var<private> nodeVar833 : f32;
var<private> nodeVar834 : f32;
var<private> nodeVar835 : f32;
var<private> nodeVar836 : f32;
var<private> nodeVar837 : bool;
var<private> nodeVar838 : vec3<f32>;
var<private> nodeVar839 : f32;
var<private> nodeVar840 : f32;
var<private> nodeVar841 : f32;
var<private> nodeVar842 : f32;
var<private> nodeVar843 : f32;
var<private> nodeVar844 : vec2<f32>;
var<private> nodeVar845 : vec2<f32>;
var<private> nodeVar846 : vec2<f32>;
var<private> nodeVar847 : vec3<f32>;
var<private> nodeVar848 : vec3<f32>;
var<private> nodeVar849 : vec3<f32>;
var<private> nodeVar850 : vec3<f32>;
var<private> nodeVar851 : f32;
var<private> nodeVar852 : f32;
var<private> nodeVar853 : vec2<f32>;
var<private> nodeVar854 : vec2<f32>;
var<private> nodeVar855 : vec2<f32>;
var<private> nodeVar856 : vec2<f32>;
var<private> nodeVar857 : f32;
var<private> nodeVar858 : f32;
var<private> nodeVar859 : f32;
var<private> nodeVar860 : vec3<f32>;
var<private> nodeVar861 : vec3<f32>;
var<private> nodeVar862 : vec3<f32>;
var<private> nodeVar863 : f32;
var<private> nodeVar864 : vec3<f32>;
var<private> nodeVar865 : vec3<f32>;
var<private> nodeVar866 : vec3<f32>;
var<private> nodeVar867 : vec3<f32>;
var<private> nodeVar868 : vec3<f32>;
var<private> nodeVar869 : vec2<f32>;
var<private> nodeVar870 : vec2<f32>;
var<private> nodeVar871 : vec2<f32>;
var<private> nodeVar872 : vec3<f32>;
var<private> nodeVar873 : vec2<f32>;
var<private> nodeVar874 : f32;
var<private> nodeVar875 : vec3<f32>;
var<private> nodeVar876 : f32;
var<private> nodeVar877 : f32;
var<private> nodeVar878 : vec3<f32>;
var<private> nodeVar879 : vec2<f32>;
var<private> nodeVar880 : vec2<f32>;
var<private> nodeVar881 : vec3<f32>;
var<private> nodeVar882 : vec3<f32>;
var<private> nodeVar883 : f32;
var<private> nodeVar884 : vec2<f32>;
var<private> nodeVar885 : vec2<f32>;
var<private> nodeVar886 : vec2<f32>;
var<private> nodeVar887 : vec3<f32>;
var<private> nodeVar888 : vec2<f32>;
var<private> nodeVar889 : vec2<f32>;
var<private> nodeVar890 : vec3<f32>;
var<private> nodeVar891 : vec2<f32>;
var<private> nodeVar892 : vec2<f32>;
var<private> nodeVar893 : vec3<f32>;
var<private> nodeVar894 : vec3<f32>;
var<private> nodeVar895 : vec2<f32>;
var<private> nodeVar896 : vec3<f32>;
var<private> nodeVar897 : vec2<f32>;
var<private> nodeVar898 : vec2<f32>;
var<private> nodeVar899 : vec2<f32>;
var<private> nodeVar900 : vec3<f32>;
var<private> nodeVar901 : vec3<f32>;
var<private> nodeVar902 : vec3<f32>;
var<private> nodeVar903 : vec3<f32>;
var<private> nodeVar904 : f32;
var<private> nodeVar905 : vec2<f32>;
var<private> nodeVar906 : vec2<f32>;
var<private> nodeVar907 : vec3<f32>;
var<private> nodeVar908 : vec3<f32>;
var<private> nodeVar909 : vec3<f32>;
var<private> nodeVar910 : vec3<f32>;
var<private> nodeVar911 : vec2<f32>;
var<private> nodeVar912 : vec2<f32>;
var<private> nodeVar913 : vec3<f32>;
var<private> nodeVar914 : vec3<f32>;
var<private> nodeVar915 : vec3<f32>;
var<private> nodeVar916 : vec3<f32>;
var<private> nodeVar917 : vec2<f32>;
var<private> nodeVar918 : vec2<f32>;
var<private> nodeVar919 : vec2<f32>;
var<private> nodeVar920 : vec3<f32>;
var<private> nodeVar921 : vec3<f32>;
var<private> nodeVar922 : vec3<f32>;
var<private> nodeVar923 : vec3<f32>;
var<private> nodeVar924 : f32;
var<private> nodeVar925 : vec2<f32>;
var<private> nodeVar926 : vec2<f32>;
var<private> nodeVar927 : vec2<f32>;
var<private> nodeVar928 : vec3<f32>;
var<private> nodeVar929 : vec3<f32>;
var<private> nodeVar930 : vec3<f32>;
var<private> nodeVar931 : vec3<f32>;
var<private> nodeVar932 : f32;
var<private> nodeVar933 : f32;
var<private> nodeVar934 : f32;
var<private> nodeVar935 : f32;
var<private> nodeVar936 : f32;
var<private> nodeVar937 : f32;
var<private> nodeVar938 : f32;
var<private> nodeVar939 : f32;
var<private> nodeVar940 : f32;
var<private> nodeVar941 : vec2<f32>;
var<private> nodeVar942 : vec2<f32>;
var<private> nodeVar943 : vec3<f32>;
var<private> nodeVar944 : f32;
var<private> nodeVar945 : vec3<f32>;
var<private> nodeVar946 : vec3<f32>;
var<private> nodeVar947 : vec2<f32>;
var<private> nodeVar948 : vec2<f32>;
var<private> nodeVar949 : vec2<f32>;
var<private> nodeVar950 : vec2<f32>;
var<private> nodeVar951 : vec3<f32>;
var<private> nodeVar952 : vec3<f32>;
var<private> nodeVar953 : vec3<f32>;
var<private> nodeVar954 : vec3<f32>;
var<private> nodeVar955 : f32;
var<private> nodeVar956 : vec2<f32>;
var<private> nodeVar957 : vec2<f32>;
var<private> nodeVar958 : vec3<f32>;
var<private> nodeVar959 : vec3<f32>;
var<private> nodeVar960 : vec3<f32>;
var<private> nodeVar961 : vec3<f32>;
var<private> nodeVar962 : vec2<f32>;
var<private> nodeVar963 : vec2<f32>;
var<private> nodeVar964 : vec3<f32>;
var<private> nodeVar965 : vec3<f32>;
var<private> nodeVar966 : vec3<f32>;
var<private> nodeVar967 : vec3<f32>;
var<private> nodeVar968 : vec2<f32>;
var<private> nodeVar969 : vec2<f32>;
var<private> nodeVar970 : vec2<f32>;
var<private> nodeVar971 : vec3<f32>;
var<private> nodeVar972 : vec3<f32>;
var<private> nodeVar973 : vec3<f32>;
var<private> nodeVar974 : vec3<f32>;
var<private> nodeVar975 : f32;
var<private> nodeVar976 : vec2<f32>;
var<private> nodeVar977 : vec2<f32>;
var<private> nodeVar978 : vec2<f32>;
var<private> nodeVar979 : vec3<f32>;
var<private> nodeVar980 : vec3<f32>;
var<private> nodeVar981 : vec3<f32>;
var<private> nodeVar982 : vec3<f32>;
var<private> nodeVar983 : f32;
var<private> nodeVar984 : f32;
var<private> nodeVar985 : f32;
var<private> nodeVar986 : f32;
var<private> nodeVar987 : f32;
var<private> nodeVar988 : f32;
var<private> nodeVar989 : f32;
var<private> nodeVar990 : f32;
var<private> nodeVar991 : f32;
var<private> nodeVar992 : bool;
var<private> nodeVar993 : vec3<f32>;
var<private> nodeVar994 : f32;
var<private> nodeVar995 : f32;
var<private> nodeVar996 : f32;
var<private> nodeVar997 : f32;
var<private> nodeVar998 : f32;
var<private> nodeVar999 : vec2<f32>;
var<private> nodeVar1000 : vec2<f32>;
var<private> nodeVar1001 : vec2<f32>;
var<private> nodeVar1002 : vec3<f32>;
var<private> nodeVar1003 : vec3<f32>;
var<private> nodeVar1004 : vec3<f32>;
var<private> nodeVar1005 : vec3<f32>;
var<private> nodeVar1006 : f32;
var<private> nodeVar1007 : f32;
var<private> nodeVar1008 : vec2<f32>;
var<private> nodeVar1009 : vec2<f32>;
var<private> nodeVar1010 : vec2<f32>;
var<private> nodeVar1011 : vec2<f32>;
var<private> nodeVar1012 : f32;
var<private> nodeVar1013 : f32;
var<private> nodeVar1014 : f32;
var<private> nodeVar1015 : vec3<f32>;
var<private> nodeVar1016 : vec3<f32>;
var<private> nodeVar1017 : vec3<f32>;
var<private> nodeVar1018 : f32;
var<private> nodeVar1019 : vec3<f32>;
var<private> nodeVar1020 : vec3<f32>;
var<private> nodeVar1021 : vec3<f32>;
var<private> nodeVar1022 : vec3<f32>;
var<private> nodeVar1023 : vec3<f32>;
var<private> nodeVar1024 : vec2<f32>;
var<private> nodeVar1025 : vec2<f32>;
var<private> nodeVar1026 : vec2<f32>;
var<private> nodeVar1027 : vec3<f32>;
var<private> nodeVar1028 : vec2<f32>;
var<private> nodeVar1029 : f32;
var<private> nodeVar1030 : vec3<f32>;
var<private> nodeVar1031 : f32;
var<private> nodeVar1032 : f32;
var<private> nodeVar1033 : vec3<f32>;
var<private> nodeVar1034 : vec2<f32>;
var<private> nodeVar1035 : vec2<f32>;
var<private> nodeVar1036 : vec3<f32>;
var<private> nodeVar1037 : vec3<f32>;
var<private> nodeVar1038 : f32;
var<private> nodeVar1039 : vec2<f32>;
var<private> nodeVar1040 : vec2<f32>;
var<private> nodeVar1041 : vec2<f32>;
var<private> nodeVar1042 : vec3<f32>;
var<private> nodeVar1043 : vec2<f32>;
var<private> nodeVar1044 : vec2<f32>;
var<private> nodeVar1045 : vec3<f32>;
var<private> nodeVar1046 : vec2<f32>;
var<private> nodeVar1047 : vec2<f32>;
var<private> nodeVar1048 : vec3<f32>;
var<private> nodeVar1049 : vec3<f32>;
var<private> nodeVar1050 : vec2<f32>;
var<private> nodeVar1051 : vec3<f32>;
var<private> nodeVar1052 : vec2<f32>;
var<private> nodeVar1053 : vec2<f32>;
var<private> nodeVar1054 : vec2<f32>;
var<private> nodeVar1055 : vec3<f32>;
var<private> nodeVar1056 : vec3<f32>;
var<private> nodeVar1057 : vec3<f32>;
var<private> nodeVar1058 : vec3<f32>;
var<private> nodeVar1059 : f32;
var<private> nodeVar1060 : vec2<f32>;
var<private> nodeVar1061 : vec2<f32>;
var<private> nodeVar1062 : vec3<f32>;
var<private> nodeVar1063 : vec3<f32>;
var<private> nodeVar1064 : vec3<f32>;
var<private> nodeVar1065 : vec3<f32>;
var<private> nodeVar1066 : vec2<f32>;
var<private> nodeVar1067 : vec2<f32>;
var<private> nodeVar1068 : vec3<f32>;
var<private> nodeVar1069 : vec3<f32>;
var<private> nodeVar1070 : vec3<f32>;
var<private> nodeVar1071 : vec3<f32>;
var<private> nodeVar1072 : vec2<f32>;
var<private> nodeVar1073 : vec2<f32>;
var<private> nodeVar1074 : vec2<f32>;
var<private> nodeVar1075 : vec3<f32>;
var<private> nodeVar1076 : vec3<f32>;
var<private> nodeVar1077 : vec3<f32>;
var<private> nodeVar1078 : vec3<f32>;
var<private> nodeVar1079 : f32;
var<private> nodeVar1080 : vec2<f32>;
var<private> nodeVar1081 : vec2<f32>;
var<private> nodeVar1082 : vec2<f32>;
var<private> nodeVar1083 : vec3<f32>;
var<private> nodeVar1084 : vec3<f32>;
var<private> nodeVar1085 : vec3<f32>;
var<private> nodeVar1086 : vec3<f32>;
var<private> nodeVar1087 : f32;
var<private> nodeVar1088 : f32;
var<private> nodeVar1089 : f32;
var<private> nodeVar1090 : f32;
var<private> nodeVar1091 : f32;
var<private> nodeVar1092 : f32;
var<private> nodeVar1093 : f32;
var<private> nodeVar1094 : f32;
var<private> nodeVar1095 : f32;
var<private> nodeVar1096 : vec2<f32>;
var<private> nodeVar1097 : vec2<f32>;
var<private> nodeVar1098 : vec3<f32>;
var<private> nodeVar1099 : f32;
var<private> nodeVar1100 : vec3<f32>;
var<private> nodeVar1101 : vec3<f32>;
var<private> nodeVar1102 : vec2<f32>;
var<private> nodeVar1103 : vec2<f32>;
var<private> nodeVar1104 : vec2<f32>;
var<private> nodeVar1105 : vec2<f32>;
var<private> nodeVar1106 : vec3<f32>;
var<private> nodeVar1107 : vec3<f32>;
var<private> nodeVar1108 : vec3<f32>;
var<private> nodeVar1109 : vec3<f32>;
var<private> nodeVar1110 : f32;
var<private> nodeVar1111 : vec2<f32>;
var<private> nodeVar1112 : vec2<f32>;
var<private> nodeVar1113 : vec3<f32>;
var<private> nodeVar1114 : vec3<f32>;
var<private> nodeVar1115 : vec3<f32>;
var<private> nodeVar1116 : vec3<f32>;
var<private> nodeVar1117 : vec2<f32>;
var<private> nodeVar1118 : vec2<f32>;
var<private> nodeVar1119 : vec3<f32>;
var<private> nodeVar1120 : vec3<f32>;
var<private> nodeVar1121 : vec3<f32>;
var<private> nodeVar1122 : vec3<f32>;
var<private> nodeVar1123 : vec2<f32>;
var<private> nodeVar1124 : vec2<f32>;
var<private> nodeVar1125 : vec2<f32>;
var<private> nodeVar1126 : vec3<f32>;
var<private> nodeVar1127 : vec3<f32>;
var<private> nodeVar1128 : vec3<f32>;
var<private> nodeVar1129 : vec3<f32>;
var<private> nodeVar1130 : f32;
var<private> nodeVar1131 : vec2<f32>;
var<private> nodeVar1132 : vec2<f32>;
var<private> nodeVar1133 : vec2<f32>;
var<private> nodeVar1134 : vec3<f32>;
var<private> nodeVar1135 : vec3<f32>;
var<private> nodeVar1136 : vec3<f32>;
var<private> nodeVar1137 : vec3<f32>;
var<private> nodeVar1138 : f32;
var<private> nodeVar1139 : f32;
var<private> nodeVar1140 : f32;
var<private> nodeVar1141 : f32;
var<private> nodeVar1142 : f32;
var<private> nodeVar1143 : f32;
var<private> nodeVar1144 : f32;
var<private> nodeVar1145 : f32;
var<private> nodeVar1146 : f32;
var<private> nodeVar1147 : bool;
var<private> nodeVar1148 : vec3<f32>;
var<private> nodeVar1149 : f32;
var<private> nodeVar1150 : f32;
var<private> nodeVar1151 : f32;
var<private> nodeVar1152 : f32;
var<private> nodeVar1153 : f32;
var<private> nodeVar1154 : vec2<f32>;
var<private> nodeVar1155 : vec2<f32>;
var<private> nodeVar1156 : vec2<f32>;
var<private> nodeVar1157 : vec3<f32>;
var<private> nodeVar1158 : vec3<f32>;
var<private> nodeVar1159 : vec3<f32>;
var<private> nodeVar1160 : vec3<f32>;
var<private> nodeVar1161 : f32;
var<private> nodeVar1162 : f32;
var<private> nodeVar1163 : vec2<f32>;
var<private> nodeVar1164 : vec2<f32>;
var<private> nodeVar1165 : vec2<f32>;
var<private> nodeVar1166 : vec2<f32>;
var<private> nodeVar1167 : f32;
var<private> nodeVar1168 : f32;
var<private> nodeVar1169 : f32;
var<private> nodeVar1170 : vec3<f32>;
var<private> nodeVar1171 : vec3<f32>;
var<private> nodeVar1172 : vec3<f32>;
var<private> nodeVar1173 : f32;
var<private> nodeVar1174 : vec3<f32>;
var<private> nodeVar1175 : vec3<f32>;
var<private> nodeVar1176 : vec3<f32>;
var<private> nodeVar1177 : vec3<f32>;
var<private> nodeVar1178 : vec3<f32>;
var<private> nodeVar1179 : vec2<f32>;
var<private> nodeVar1180 : vec2<f32>;
var<private> nodeVar1181 : vec2<f32>;
var<private> nodeVar1182 : vec3<f32>;
var<private> nodeVar1183 : vec2<f32>;
var<private> nodeVar1184 : f32;
var<private> nodeVar1185 : vec3<f32>;
var<private> nodeVar1186 : f32;
var<private> nodeVar1187 : f32;
var<private> nodeVar1188 : vec3<f32>;
var<private> nodeVar1189 : vec2<f32>;
var<private> nodeVar1190 : vec2<f32>;
var<private> nodeVar1191 : vec3<f32>;
var<private> nodeVar1192 : vec3<f32>;
var<private> nodeVar1193 : f32;
var<private> nodeVar1194 : vec2<f32>;
var<private> nodeVar1195 : vec2<f32>;
var<private> nodeVar1196 : vec2<f32>;
var<private> nodeVar1197 : vec3<f32>;
var<private> nodeVar1198 : vec2<f32>;
var<private> nodeVar1199 : vec2<f32>;
var<private> nodeVar1200 : vec3<f32>;
var<private> nodeVar1201 : vec2<f32>;
var<private> nodeVar1202 : vec2<f32>;
var<private> nodeVar1203 : vec3<f32>;
var<private> nodeVar1204 : vec3<f32>;
var<private> nodeVar1205 : vec2<f32>;
var<private> nodeVar1206 : f32;
var<private> nodeVar1207 : vec2<f32>;
var<private> nodeVar1208 : vec2<f32>;
var<private> nodeVar1209 : vec2<f32>;
var<private> nodeVar1210 : vec3<f32>;
var<private> nodeVar1211 : vec3<f32>;
var<private> nodeVar1212 : vec3<f32>;
var<private> nodeVar1213 : vec3<f32>;
var<private> nodeVar1214 : vec2<f32>;
var<private> nodeVar1215 : vec2<f32>;
var<private> nodeVar1216 : vec2<f32>;
var<private> nodeVar1217 : vec3<f32>;
var<private> nodeVar1218 : vec3<f32>;
var<private> nodeVar1219 : vec3<f32>;
var<private> nodeVar1220 : vec3<f32>;
var<private> nodeVar1221 : f32;
var<private> nodeVar1222 : vec3<f32>;
var<private> nodeVar1223 : vec2<f32>;
var<private> nodeVar1224 : vec2<f32>;
var<private> nodeVar1225 : vec2<f32>;
var<private> nodeVar1226 : vec3<f32>;
var<private> nodeVar1227 : vec3<f32>;
var<private> nodeVar1228 : vec3<f32>;
var<private> nodeVar1229 : vec3<f32>;
var<private> nodeVar1230 : f32;
var<private> nodeVar1231 : vec2<f32>;
var<private> nodeVar1232 : vec2<f32>;
var<private> nodeVar1233 : vec3<f32>;
var<private> nodeVar1234 : vec3<f32>;
var<private> nodeVar1235 : vec3<f32>;
var<private> nodeVar1236 : vec3<f32>;
var<private> nodeVar1237 : vec2<f32>;
var<private> nodeVar1238 : vec2<f32>;
var<private> nodeVar1239 : vec3<f32>;
var<private> nodeVar1240 : vec3<f32>;
var<private> nodeVar1241 : vec3<f32>;
var<private> nodeVar1242 : vec3<f32>;
var<private> nodeVar1243 : vec2<f32>;
var<private> nodeVar1244 : vec2<f32>;
var<private> nodeVar1245 : vec2<f32>;
var<private> nodeVar1246 : vec3<f32>;
var<private> nodeVar1247 : vec3<f32>;
var<private> nodeVar1248 : vec3<f32>;
var<private> nodeVar1249 : vec3<f32>;
var<private> nodeVar1250 : f32;
var<private> nodeVar1251 : vec2<f32>;
var<private> nodeVar1252 : vec2<f32>;
var<private> nodeVar1253 : vec2<f32>;
var<private> nodeVar1254 : vec3<f32>;
var<private> nodeVar1255 : vec3<f32>;
var<private> nodeVar1256 : vec3<f32>;
var<private> nodeVar1257 : vec3<f32>;
var<private> nodeVar1258 : f32;
var<private> nodeVar1259 : vec3<f32>;
var<private> nodeVar1260 : f32;
var<private> nodeVar1261 : vec3<f32>;
var<private> nodeVar1262 : vec3<f32>;
var<private> nodeVar1263 : f32;
var<private> nodeVar1264 : f32;
var<private> nodeVar1265 : f32;
var<private> nodeVar1266 : f32;
var<private> nodeVar1267 : vec3<f32>;
var<private> nodeVar1268 : vec3<f32>;
var<private> nodeVar1269 : f32;
var<private> nodeVar1270 : f32;
var<private> nodeVar1271 : f32;
var<private> nodeVar1272 : f32;
var<private> nodeVar1273 : vec2<f32>;
var<private> nodeVar1274 : vec2<f32>;
var<private> nodeVar1275 : vec2<f32>;
var<private> nodeVar1276 : vec3<f32>;
var<private> nodeVar1277 : vec3<f32>;
var<private> nodeVar1278 : vec3<f32>;
var<private> nodeVar1279 : vec3<f32>;
var<private> nodeVar1280 : f32;
var<private> nodeVar1281 : vec2<f32>;
var<private> nodeVar1282 : vec2<f32>;
var<private> nodeVar1283 : vec3<f32>;
var<private> nodeVar1284 : vec3<f32>;
var<private> nodeVar1285 : vec3<f32>;
var<private> nodeVar1286 : vec3<f32>;
var<private> nodeVar1287 : vec2<f32>;
var<private> nodeVar1288 : vec2<f32>;
var<private> nodeVar1289 : vec3<f32>;
var<private> nodeVar1290 : vec3<f32>;
var<private> nodeVar1291 : vec3<f32>;
var<private> nodeVar1292 : vec3<f32>;
var<private> nodeVar1293 : vec2<f32>;
var<private> nodeVar1294 : vec2<f32>;
var<private> nodeVar1295 : vec2<f32>;
var<private> nodeVar1296 : vec3<f32>;
var<private> nodeVar1297 : vec3<f32>;
var<private> nodeVar1298 : vec3<f32>;
var<private> nodeVar1299 : vec3<f32>;
var<private> nodeVar1300 : f32;
var<private> nodeVar1301 : vec2<f32>;
var<private> nodeVar1302 : vec2<f32>;
var<private> nodeVar1303 : vec2<f32>;
var<private> nodeVar1304 : vec3<f32>;
var<private> nodeVar1305 : vec3<f32>;
var<private> nodeVar1306 : vec3<f32>;
var<private> nodeVar1307 : vec3<f32>;
var<private> nodeVar1308 : f32;
var<private> nodeVar1309 : f32;
var<private> nodeVar1310 : f32;
var<private> nodeVar1311 : f32;
var<private> nodeVar1312 : f32;
var<private> nodeVar1313 : f32;
var<private> nodeVar1314 : f32;
var<private> nodeVar1315 : f32;
var<private> nodeVar1316 : vec2<f32>;
var<private> nodeVar1317 : vec2<f32>;
var<private> nodeVar1318 : vec2<f32>;
var<private> nodeVar1319 : vec3<f32>;
var<private> nodeVar1320 : vec3<f32>;
var<private> nodeVar1321 : vec3<f32>;
var<private> nodeVar1322 : vec3<f32>;
var<private> nodeVar1323 : f32;
var<private> nodeVar1324 : vec2<f32>;
var<private> nodeVar1325 : vec2<f32>;
var<private> nodeVar1326 : vec3<f32>;
var<private> nodeVar1327 : vec3<f32>;
var<private> nodeVar1328 : vec3<f32>;
var<private> nodeVar1329 : vec3<f32>;
var<private> nodeVar1330 : vec2<f32>;
var<private> nodeVar1331 : vec2<f32>;
var<private> nodeVar1332 : vec3<f32>;
var<private> nodeVar1333 : vec3<f32>;
var<private> nodeVar1334 : vec3<f32>;
var<private> nodeVar1335 : vec3<f32>;
var<private> nodeVar1336 : vec2<f32>;
var<private> nodeVar1337 : vec2<f32>;
var<private> nodeVar1338 : vec2<f32>;
var<private> nodeVar1339 : vec3<f32>;
var<private> nodeVar1340 : vec3<f32>;
var<private> nodeVar1341 : vec3<f32>;
var<private> nodeVar1342 : vec3<f32>;
var<private> nodeVar1343 : f32;
var<private> nodeVar1344 : f32;
var<private> nodeVar1345 : f32;
var<private> nodeVar1346 : vec4<f32>;

// codes


@fragment
fn main( @location( 0 ) nodeVarying0 : vec2<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = 1.0;
	nodeVar1 = ( ( nodeVarying0 * vec2<f32>( 2.0 ) ) - vec2<f32>( 1.0 ) );
	nodeVar2 = normalize( ( ( frame.nodeUniform2 + ( ( ( frame.nodeUniform3 * vec3<f32>( nodeVar1.x ) ) * vec3<f32>( frame.nodeUniform4 ) ) * vec3<f32>( frame.nodeUniform5 ) ) ) + ( ( frame.nodeUniform6 * vec3<f32>( nodeVar1.y ) ) * vec3<f32>( frame.nodeUniform5 ) ) ) );
	nodeVar3 = textureSample( nodeUniform7, nodeUniform7_sampler, vec2<f32>( nodeVarying0.x, ( 1.0 - nodeVarying0.y ) ) );
	nodeVar4 = nodeVar3.xyz;

	if ( ( nodeVar2.y < -0.0001 ) ) {

		nodeVar5 = ( ( - frame.nodeUniform8.y ) / nodeVar2.y );

	} else {

		nodeVar5 = 2200.0;

	}

	nodeVar6 = nodeVar5;
	nodeVar7 = ( frame.nodeUniform8 + ( nodeVar2 * vec3<f32>( nodeVar6 ) ) );
	nodeVar8 = ( ( nodeVar7.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
	nodeVar9 = floor( nodeVar8 );
	nodeVar10 = fract( nodeVar8 );
	nodeVar10 = ( ( nodeVar10 * nodeVar10 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar10 ) ) );
	nodeVar11 = fract( ( vec3<f32>( nodeVar9, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar11 = ( nodeVar11 + vec3<f32>( dot( nodeVar11, ( nodeVar11.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar12 = fract( ( vec3<f32>( ( nodeVar9 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar12 = ( nodeVar12 + vec3<f32>( dot( nodeVar12, ( nodeVar12.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar13 = fract( ( vec3<f32>( ( nodeVar9 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar13 = ( nodeVar13 + vec3<f32>( dot( nodeVar13, ( nodeVar13.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar14 = fract( ( vec3<f32>( ( nodeVar9 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar14 = ( nodeVar14 + vec3<f32>( dot( nodeVar14, ( nodeVar14.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar15 = ( 0.5 * mix( mix( fract( ( ( nodeVar11.x + nodeVar11.y ) * nodeVar11.z ) ), fract( ( ( nodeVar12.x + nodeVar12.y ) * nodeVar12.z ) ), nodeVar10.x ), mix( fract( ( ( nodeVar13.x + nodeVar13.y ) * nodeVar13.z ) ), fract( ( ( nodeVar14.x + nodeVar14.y ) * nodeVar14.z ) ), nodeVar10.x ), nodeVar10.y ) );
	nodeVar8 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar8 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
	nodeVar16 = floor( nodeVar8 );
	nodeVar17 = fract( nodeVar8 );
	nodeVar17 = ( ( nodeVar17 * nodeVar17 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar17 ) ) );
	nodeVar18 = fract( ( vec3<f32>( nodeVar16, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar18 = ( nodeVar18 + vec3<f32>( dot( nodeVar18, ( nodeVar18.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar19 = fract( ( vec3<f32>( ( nodeVar16 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar19 = ( nodeVar19 + vec3<f32>( dot( nodeVar19, ( nodeVar19.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar20 = fract( ( vec3<f32>( ( nodeVar16 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar20 = ( nodeVar20 + vec3<f32>( dot( nodeVar20, ( nodeVar20.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar21 = fract( ( vec3<f32>( ( nodeVar16 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar21 = ( nodeVar21 + vec3<f32>( dot( nodeVar21, ( nodeVar21.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar15 = ( nodeVar15 + ( 0.25 * mix( mix( fract( ( ( nodeVar18.x + nodeVar18.y ) * nodeVar18.z ) ), fract( ( ( nodeVar19.x + nodeVar19.y ) * nodeVar19.z ) ), nodeVar17.x ), mix( fract( ( ( nodeVar20.x + nodeVar20.y ) * nodeVar20.z ) ), fract( ( ( nodeVar21.x + nodeVar21.y ) * nodeVar21.z ) ), nodeVar17.x ), nodeVar17.y ) ) );
	nodeVar8 = ( ( nodeVar8 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
	nodeVar22 = floor( nodeVar8 );
	nodeVar23 = fract( nodeVar8 );
	nodeVar23 = ( ( nodeVar23 * nodeVar23 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar23 ) ) );
	nodeVar24 = fract( ( vec3<f32>( nodeVar22, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar24 = ( nodeVar24 + vec3<f32>( dot( nodeVar24, ( nodeVar24.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar25 = fract( ( vec3<f32>( ( nodeVar22 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar25 = ( nodeVar25 + vec3<f32>( dot( nodeVar25, ( nodeVar25.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar26 = fract( ( vec3<f32>( ( nodeVar22 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar26 = ( nodeVar26 + vec3<f32>( dot( nodeVar26, ( nodeVar26.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar27 = fract( ( vec3<f32>( ( nodeVar22 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar27 = ( nodeVar27 + vec3<f32>( dot( nodeVar27, ( nodeVar27.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar15 = ( nodeVar15 + ( 0.125 * mix( mix( fract( ( ( nodeVar24.x + nodeVar24.y ) * nodeVar24.z ) ), fract( ( ( nodeVar25.x + nodeVar25.y ) * nodeVar25.z ) ), nodeVar23.x ), mix( fract( ( ( nodeVar26.x + nodeVar26.y ) * nodeVar26.z ) ), fract( ( ( nodeVar27.x + nodeVar27.y ) * nodeVar27.z ) ), nodeVar23.x ), nodeVar23.y ) ) );
	nodeVar28 = ( ( nodeVar8 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
	nodeVar29 = floor( nodeVar28 );
	nodeVar30 = fract( nodeVar28 );
	nodeVar30 = ( ( nodeVar30 * nodeVar30 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar30 ) ) );
	nodeVar31 = fract( ( vec3<f32>( nodeVar29, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar31 = ( nodeVar31 + vec3<f32>( dot( nodeVar31, ( nodeVar31.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar32 = fract( ( vec3<f32>( ( nodeVar29 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar32 = ( nodeVar32 + vec3<f32>( dot( nodeVar32, ( nodeVar32.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar33 = fract( ( vec3<f32>( ( nodeVar29 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar33 = ( nodeVar33 + vec3<f32>( dot( nodeVar33, ( nodeVar33.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar34 = fract( ( vec3<f32>( ( nodeVar29 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar34 = ( nodeVar34 + vec3<f32>( dot( nodeVar34, ( nodeVar34.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar35 = ( nodeVar15 + ( 0.0625 * mix( mix( fract( ( ( nodeVar31.x + nodeVar31.y ) * nodeVar31.z ) ), fract( ( ( nodeVar32.x + nodeVar32.y ) * nodeVar32.z ) ), nodeVar30.x ), mix( fract( ( ( nodeVar33.x + nodeVar33.y ) * nodeVar33.z ) ), fract( ( ( nodeVar34.x + nodeVar34.y ) * nodeVar34.z ) ), nodeVar30.x ), nodeVar30.y ) ) );
	nodeVar36 = ( nodeVar7.xz * vec2<f32>( 0.018 ) );
	nodeVar37 = floor( nodeVar36 );
	nodeVar38 = fract( nodeVar36 );
	nodeVar38 = ( ( nodeVar38 * nodeVar38 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar38 ) ) );
	nodeVar39 = fract( ( vec3<f32>( nodeVar37, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar39 = ( nodeVar39 + vec3<f32>( dot( nodeVar39, ( nodeVar39.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar40 = fract( ( vec3<f32>( ( nodeVar37 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar40 = ( nodeVar40 + vec3<f32>( dot( nodeVar40, ( nodeVar40.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar41 = fract( ( vec3<f32>( ( nodeVar37 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar41 = ( nodeVar41 + vec3<f32>( dot( nodeVar41, ( nodeVar41.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar42 = fract( ( vec3<f32>( ( nodeVar37 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
	nodeVar42 = ( nodeVar42 + vec3<f32>( dot( nodeVar42, ( nodeVar42.yzx + vec3<f32>( 33.33 ) ) ) ) );
	nodeVar43 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar39.x + nodeVar39.y ) * nodeVar39.z ) ), fract( ( ( nodeVar40.x + nodeVar40.y ) * nodeVar40.z ) ), nodeVar38.x ), mix( fract( ( ( nodeVar41.x + nodeVar41.y ) * nodeVar41.z ) ), fract( ( ( nodeVar42.x + nodeVar42.y ) * nodeVar42.z ) ), nodeVar38.x ), nodeVar38.y ) * 2.0 ) - 1.0 ) ) );
	nodeVar44 = ( smoothstep( 13.0, 155.0, ( - nodeVar7.xz.x ) ) * ( ( 28.0 + ( nodeVar35 * 135.0 ) ) + ( nodeVar43 * 20.0 ) ) );
	nodeVar45 = ( smoothstep( 280.0, 670.0, ( - nodeVar7.xz.y ) ) * ( ( 46.0 + ( nodeVar35 * 155.0 ) ) + ( nodeVar43 * 22.0 ) ) );
	nodeVar46 = ( smoothstep( 190.0, 430.0, nodeVar7.xz.x ) * ( 30.0 + ( nodeVar35 * 95.0 ) ) );
	nodeVar47 = max( max( nodeVar44, nodeVar45 ), nodeVar46 );
	nodeVar48 = ( exp( ( - dot( ( ( nodeVar7.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar7.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar35 * 10.0 ) ) );
	nodeVar47 = max( nodeVar47, nodeVar48 );

	if ( ( nodeVar47 < 1.5 ) ) {


		if ( ( nodeVar7.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar7.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar7.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar7.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

			nodeVar49 = -1.2;

		} else {

			nodeVar49 = ( 0.1 + ( nodeVar35 * 0.2 ) );

		}

		nodeVar47 = nodeVar49;
		

	}


	if ( ( ( nodeVar7.xz.y > -175.0 ) && ( abs( ( nodeVar7.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar7.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar7.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

		nodeVar47 = 0.0;
		

	}

	nodeVar50 = ( ( nodeVar7.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar7.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar7.z ) ) ) ) + 9.2 ) + ( sin( ( nodeVar7.z * 0.023 ) ) * 1.8 ) ) ) && ( nodeVar47 < 0.0 ) );

	if ( ( nodeVar50 && ( nodeVar2.y < -0.0001 ) ) ) {

		nodeVar6 = ( ( -0.6 - frame.nodeUniform8.y ) / nodeVar2.y );
		

	}

	nodeVar51 = 0.25;
	nodeVar52 = -1.0;

	for ( var i : i32 = 0; i < 148; i ++ ) {


		if ( ( ( nodeVar51 > min( nodeVar6, 2200.0 ) ) || ( nodeVar51 > 1850.0 ) ) ) {

			break;
			

		}

		nodeVar53 = ( frame.nodeUniform8 + ( nodeVar2 * vec3<f32>( nodeVar51 ) ) );
		nodeVar54 = ( ( nodeVar53.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
		nodeVar55 = floor( nodeVar54 );
		nodeVar56 = fract( nodeVar54 );
		nodeVar56 = ( ( nodeVar56 * nodeVar56 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar56 ) ) );
		nodeVar57 = fract( ( vec3<f32>( nodeVar55, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar57 = ( nodeVar57 + vec3<f32>( dot( nodeVar57, ( nodeVar57.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar58 = fract( ( vec3<f32>( ( nodeVar55 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar58 = ( nodeVar58 + vec3<f32>( dot( nodeVar58, ( nodeVar58.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar59 = fract( ( vec3<f32>( ( nodeVar55 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar59 = ( nodeVar59 + vec3<f32>( dot( nodeVar59, ( nodeVar59.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar60 = fract( ( vec3<f32>( ( nodeVar55 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar60 = ( nodeVar60 + vec3<f32>( dot( nodeVar60, ( nodeVar60.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar61 = ( 0.5 * mix( mix( fract( ( ( nodeVar57.x + nodeVar57.y ) * nodeVar57.z ) ), fract( ( ( nodeVar58.x + nodeVar58.y ) * nodeVar58.z ) ), nodeVar56.x ), mix( fract( ( ( nodeVar59.x + nodeVar59.y ) * nodeVar59.z ) ), fract( ( ( nodeVar60.x + nodeVar60.y ) * nodeVar60.z ) ), nodeVar56.x ), nodeVar56.y ) );
		nodeVar54 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar54 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
		nodeVar62 = floor( nodeVar54 );
		nodeVar63 = fract( nodeVar54 );
		nodeVar63 = ( ( nodeVar63 * nodeVar63 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar63 ) ) );
		nodeVar64 = fract( ( vec3<f32>( nodeVar62, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar64 = ( nodeVar64 + vec3<f32>( dot( nodeVar64, ( nodeVar64.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar65 = fract( ( vec3<f32>( ( nodeVar62 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar65 = ( nodeVar65 + vec3<f32>( dot( nodeVar65, ( nodeVar65.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar66 = fract( ( vec3<f32>( ( nodeVar62 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar66 = ( nodeVar66 + vec3<f32>( dot( nodeVar66, ( nodeVar66.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar67 = fract( ( vec3<f32>( ( nodeVar62 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar67 = ( nodeVar67 + vec3<f32>( dot( nodeVar67, ( nodeVar67.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar61 = ( nodeVar61 + ( 0.25 * mix( mix( fract( ( ( nodeVar64.x + nodeVar64.y ) * nodeVar64.z ) ), fract( ( ( nodeVar65.x + nodeVar65.y ) * nodeVar65.z ) ), nodeVar63.x ), mix( fract( ( ( nodeVar66.x + nodeVar66.y ) * nodeVar66.z ) ), fract( ( ( nodeVar67.x + nodeVar67.y ) * nodeVar67.z ) ), nodeVar63.x ), nodeVar63.y ) ) );
		nodeVar54 = ( ( nodeVar54 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
		nodeVar68 = floor( nodeVar54 );
		nodeVar69 = fract( nodeVar54 );
		nodeVar69 = ( ( nodeVar69 * nodeVar69 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar69 ) ) );
		nodeVar70 = fract( ( vec3<f32>( nodeVar68, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar70 = ( nodeVar70 + vec3<f32>( dot( nodeVar70, ( nodeVar70.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar71 = fract( ( vec3<f32>( ( nodeVar68 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar71 = ( nodeVar71 + vec3<f32>( dot( nodeVar71, ( nodeVar71.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar72 = fract( ( vec3<f32>( ( nodeVar68 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar72 = ( nodeVar72 + vec3<f32>( dot( nodeVar72, ( nodeVar72.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar73 = fract( ( vec3<f32>( ( nodeVar68 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar73 = ( nodeVar73 + vec3<f32>( dot( nodeVar73, ( nodeVar73.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar61 = ( nodeVar61 + ( 0.125 * mix( mix( fract( ( ( nodeVar70.x + nodeVar70.y ) * nodeVar70.z ) ), fract( ( ( nodeVar71.x + nodeVar71.y ) * nodeVar71.z ) ), nodeVar69.x ), mix( fract( ( ( nodeVar72.x + nodeVar72.y ) * nodeVar72.z ) ), fract( ( ( nodeVar73.x + nodeVar73.y ) * nodeVar73.z ) ), nodeVar69.x ), nodeVar69.y ) ) );
		nodeVar74 = ( ( nodeVar54 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
		nodeVar75 = floor( nodeVar74 );
		nodeVar76 = fract( nodeVar74 );
		nodeVar76 = ( ( nodeVar76 * nodeVar76 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar76 ) ) );
		nodeVar77 = fract( ( vec3<f32>( nodeVar75, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar77 = ( nodeVar77 + vec3<f32>( dot( nodeVar77, ( nodeVar77.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar78 = fract( ( vec3<f32>( ( nodeVar75 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar78 = ( nodeVar78 + vec3<f32>( dot( nodeVar78, ( nodeVar78.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar79 = fract( ( vec3<f32>( ( nodeVar75 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar79 = ( nodeVar79 + vec3<f32>( dot( nodeVar79, ( nodeVar79.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar80 = fract( ( vec3<f32>( ( nodeVar75 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar80 = ( nodeVar80 + vec3<f32>( dot( nodeVar80, ( nodeVar80.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar81 = ( nodeVar61 + ( 0.0625 * mix( mix( fract( ( ( nodeVar77.x + nodeVar77.y ) * nodeVar77.z ) ), fract( ( ( nodeVar78.x + nodeVar78.y ) * nodeVar78.z ) ), nodeVar76.x ), mix( fract( ( ( nodeVar79.x + nodeVar79.y ) * nodeVar79.z ) ), fract( ( ( nodeVar80.x + nodeVar80.y ) * nodeVar80.z ) ), nodeVar76.x ), nodeVar76.y ) ) );
		nodeVar82 = ( nodeVar53.xz * vec2<f32>( 0.018 ) );
		nodeVar83 = floor( nodeVar82 );
		nodeVar84 = fract( nodeVar82 );
		nodeVar84 = ( ( nodeVar84 * nodeVar84 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar84 ) ) );
		nodeVar85 = fract( ( vec3<f32>( nodeVar83, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar85 = ( nodeVar85 + vec3<f32>( dot( nodeVar85, ( nodeVar85.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar86 = fract( ( vec3<f32>( ( nodeVar83 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar86 = ( nodeVar86 + vec3<f32>( dot( nodeVar86, ( nodeVar86.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar87 = fract( ( vec3<f32>( ( nodeVar83 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar87 = ( nodeVar87 + vec3<f32>( dot( nodeVar87, ( nodeVar87.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar88 = fract( ( vec3<f32>( ( nodeVar83 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar88 = ( nodeVar88 + vec3<f32>( dot( nodeVar88, ( nodeVar88.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar89 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar85.x + nodeVar85.y ) * nodeVar85.z ) ), fract( ( ( nodeVar86.x + nodeVar86.y ) * nodeVar86.z ) ), nodeVar84.x ), mix( fract( ( ( nodeVar87.x + nodeVar87.y ) * nodeVar87.z ) ), fract( ( ( nodeVar88.x + nodeVar88.y ) * nodeVar88.z ) ), nodeVar84.x ), nodeVar84.y ) * 2.0 ) - 1.0 ) ) );
		nodeVar90 = ( smoothstep( 13.0, 155.0, ( - nodeVar53.xz.x ) ) * ( ( 28.0 + ( nodeVar81 * 135.0 ) ) + ( nodeVar89 * 20.0 ) ) );
		nodeVar91 = ( smoothstep( 280.0, 670.0, ( - nodeVar53.xz.y ) ) * ( ( 46.0 + ( nodeVar81 * 155.0 ) ) + ( nodeVar89 * 22.0 ) ) );
		nodeVar92 = ( smoothstep( 190.0, 430.0, nodeVar53.xz.x ) * ( 30.0 + ( nodeVar81 * 95.0 ) ) );
		nodeVar93 = max( max( nodeVar90, nodeVar91 ), nodeVar92 );
		nodeVar94 = ( exp( ( - dot( ( ( nodeVar53.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar53.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar81 * 10.0 ) ) );
		nodeVar93 = max( nodeVar93, nodeVar94 );

		if ( ( nodeVar93 < 1.5 ) ) {


			if ( ( nodeVar53.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar53.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar53.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar53.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

				nodeVar95 = -1.2;

			} else {

				nodeVar95 = ( 0.1 + ( nodeVar81 * 0.2 ) );

			}

			nodeVar93 = nodeVar95;
			

		}


		if ( ( ( nodeVar53.xz.y > -175.0 ) && ( abs( ( nodeVar53.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar53.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar53.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

			nodeVar93 = 0.0;
			

		}

		nodeVar96 = nodeVar93;

		if ( ( nodeVar96 > 1.0 ) ) {

			nodeVar97 = nodeVar96;

		} else {

			nodeVar97 = -3.5;

		}

		nodeVar98 = vec2<f32>( ( ( nodeVar53.y - nodeVar97 ) * 0.58 ), 1.0 );
		nodeVar99 = floor( ( ( nodeVar53.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
		nodeVar100 = fract( ( vec3<f32>( ( nodeVar99 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar100 = ( nodeVar100 + vec3<f32>( dot( nodeVar100, ( nodeVar100.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar101 = fract( ( ( nodeVar100.x + nodeVar100.y ) * nodeVar100.z ) );
		nodeVar102 = fract( ( vec3<f32>( ( nodeVar99 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar102 = ( nodeVar102 + vec3<f32>( dot( nodeVar102, ( nodeVar102.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar103 = fract( ( vec3<f32>( ( nodeVar99 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar103 = ( nodeVar103 + vec3<f32>( dot( nodeVar103, ( nodeVar103.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar104 = ( ( ( ( ( nodeVar99 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar102.x + nodeVar102.y ) * nodeVar102.z ) ), fract( ( ( nodeVar103.x + nodeVar103.y ) * nodeVar103.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
		nodeVar105 = ( ( nodeVar104 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
		nodeVar106 = floor( nodeVar105 );
		nodeVar107 = fract( nodeVar105 );
		nodeVar107 = ( ( nodeVar107 * nodeVar107 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar107 ) ) );
		nodeVar108 = fract( ( vec3<f32>( nodeVar106, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar108 = ( nodeVar108 + vec3<f32>( dot( nodeVar108, ( nodeVar108.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar109 = fract( ( vec3<f32>( ( nodeVar106 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar109 = ( nodeVar109 + vec3<f32>( dot( nodeVar109, ( nodeVar109.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar110 = fract( ( vec3<f32>( ( nodeVar106 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar110 = ( nodeVar110 + vec3<f32>( dot( nodeVar110, ( nodeVar110.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar111 = fract( ( vec3<f32>( ( nodeVar106 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar111 = ( nodeVar111 + vec3<f32>( dot( nodeVar111, ( nodeVar111.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar112 = ( 0.5 * mix( mix( fract( ( ( nodeVar108.x + nodeVar108.y ) * nodeVar108.z ) ), fract( ( ( nodeVar109.x + nodeVar109.y ) * nodeVar109.z ) ), nodeVar107.x ), mix( fract( ( ( nodeVar110.x + nodeVar110.y ) * nodeVar110.z ) ), fract( ( ( nodeVar111.x + nodeVar111.y ) * nodeVar111.z ) ), nodeVar107.x ), nodeVar107.y ) );
		nodeVar105 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar105 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
		nodeVar113 = floor( nodeVar105 );
		nodeVar114 = fract( nodeVar105 );
		nodeVar114 = ( ( nodeVar114 * nodeVar114 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar114 ) ) );
		nodeVar115 = fract( ( vec3<f32>( nodeVar113, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar115 = ( nodeVar115 + vec3<f32>( dot( nodeVar115, ( nodeVar115.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar116 = fract( ( vec3<f32>( ( nodeVar113 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar116 = ( nodeVar116 + vec3<f32>( dot( nodeVar116, ( nodeVar116.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar117 = fract( ( vec3<f32>( ( nodeVar113 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar117 = ( nodeVar117 + vec3<f32>( dot( nodeVar117, ( nodeVar117.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar118 = fract( ( vec3<f32>( ( nodeVar113 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar118 = ( nodeVar118 + vec3<f32>( dot( nodeVar118, ( nodeVar118.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar112 = ( nodeVar112 + ( 0.25 * mix( mix( fract( ( ( nodeVar115.x + nodeVar115.y ) * nodeVar115.z ) ), fract( ( ( nodeVar116.x + nodeVar116.y ) * nodeVar116.z ) ), nodeVar114.x ), mix( fract( ( ( nodeVar117.x + nodeVar117.y ) * nodeVar117.z ) ), fract( ( ( nodeVar118.x + nodeVar118.y ) * nodeVar118.z ) ), nodeVar114.x ), nodeVar114.y ) ) );
		nodeVar105 = ( ( nodeVar105 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
		nodeVar119 = floor( nodeVar105 );
		nodeVar120 = fract( nodeVar105 );
		nodeVar120 = ( ( nodeVar120 * nodeVar120 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar120 ) ) );
		nodeVar121 = fract( ( vec3<f32>( nodeVar119, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar121 = ( nodeVar121 + vec3<f32>( dot( nodeVar121, ( nodeVar121.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar122 = fract( ( vec3<f32>( ( nodeVar119 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar122 = ( nodeVar122 + vec3<f32>( dot( nodeVar122, ( nodeVar122.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar123 = fract( ( vec3<f32>( ( nodeVar119 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar123 = ( nodeVar123 + vec3<f32>( dot( nodeVar123, ( nodeVar123.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar124 = fract( ( vec3<f32>( ( nodeVar119 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar124 = ( nodeVar124 + vec3<f32>( dot( nodeVar124, ( nodeVar124.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar112 = ( nodeVar112 + ( 0.125 * mix( mix( fract( ( ( nodeVar121.x + nodeVar121.y ) * nodeVar121.z ) ), fract( ( ( nodeVar122.x + nodeVar122.y ) * nodeVar122.z ) ), nodeVar120.x ), mix( fract( ( ( nodeVar123.x + nodeVar123.y ) * nodeVar123.z ) ), fract( ( ( nodeVar124.x + nodeVar124.y ) * nodeVar124.z ) ), nodeVar120.x ), nodeVar120.y ) ) );
		nodeVar125 = ( ( nodeVar105 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
		nodeVar126 = floor( nodeVar125 );
		nodeVar127 = fract( nodeVar125 );
		nodeVar127 = ( ( nodeVar127 * nodeVar127 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar127 ) ) );
		nodeVar128 = fract( ( vec3<f32>( nodeVar126, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar128 = ( nodeVar128 + vec3<f32>( dot( nodeVar128, ( nodeVar128.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar129 = fract( ( vec3<f32>( ( nodeVar126 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar129 = ( nodeVar129 + vec3<f32>( dot( nodeVar129, ( nodeVar129.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar130 = fract( ( vec3<f32>( ( nodeVar126 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar130 = ( nodeVar130 + vec3<f32>( dot( nodeVar130, ( nodeVar130.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar131 = fract( ( vec3<f32>( ( nodeVar126 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar131 = ( nodeVar131 + vec3<f32>( dot( nodeVar131, ( nodeVar131.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar132 = ( nodeVar112 + ( 0.0625 * mix( mix( fract( ( ( nodeVar128.x + nodeVar128.y ) * nodeVar128.z ) ), fract( ( ( nodeVar129.x + nodeVar129.y ) * nodeVar129.z ) ), nodeVar127.x ), mix( fract( ( ( nodeVar130.x + nodeVar130.y ) * nodeVar130.z ) ), fract( ( ( nodeVar131.x + nodeVar131.y ) * nodeVar131.z ) ), nodeVar127.x ), nodeVar127.y ) ) );
		nodeVar133 = ( nodeVar104 * vec2<f32>( 0.018 ) );
		nodeVar134 = floor( nodeVar133 );
		nodeVar135 = fract( nodeVar133 );
		nodeVar135 = ( ( nodeVar135 * nodeVar135 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar135 ) ) );
		nodeVar136 = fract( ( vec3<f32>( nodeVar134, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar136 = ( nodeVar136 + vec3<f32>( dot( nodeVar136, ( nodeVar136.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar137 = fract( ( vec3<f32>( ( nodeVar134 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar137 = ( nodeVar137 + vec3<f32>( dot( nodeVar137, ( nodeVar137.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar138 = fract( ( vec3<f32>( ( nodeVar134 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar138 = ( nodeVar138 + vec3<f32>( dot( nodeVar138, ( nodeVar138.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar139 = fract( ( vec3<f32>( ( nodeVar134 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar139 = ( nodeVar139 + vec3<f32>( dot( nodeVar139, ( nodeVar139.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar140 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar136.x + nodeVar136.y ) * nodeVar136.z ) ), fract( ( ( nodeVar137.x + nodeVar137.y ) * nodeVar137.z ) ), nodeVar135.x ), mix( fract( ( ( nodeVar138.x + nodeVar138.y ) * nodeVar138.z ) ), fract( ( ( nodeVar139.x + nodeVar139.y ) * nodeVar139.z ) ), nodeVar135.x ), nodeVar135.y ) * 2.0 ) - 1.0 ) ) );
		nodeVar141 = ( smoothstep( 13.0, 155.0, ( - nodeVar104.x ) ) * ( ( 28.0 + ( nodeVar132 * 135.0 ) ) + ( nodeVar140 * 20.0 ) ) );
		nodeVar142 = ( smoothstep( 280.0, 670.0, ( - nodeVar104.y ) ) * ( ( 46.0 + ( nodeVar132 * 155.0 ) ) + ( nodeVar140 * 22.0 ) ) );
		nodeVar143 = ( smoothstep( 190.0, 430.0, nodeVar104.x ) * ( 30.0 + ( nodeVar132 * 95.0 ) ) );
		nodeVar144 = max( max( nodeVar141, nodeVar142 ), nodeVar143 );
		nodeVar145 = ( exp( ( - dot( ( ( nodeVar104 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar104 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar132 * 10.0 ) ) );
		nodeVar144 = max( nodeVar144, nodeVar145 );

		if ( ( nodeVar144 < 1.5 ) ) {


			if ( ( nodeVar104.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar104.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar104.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar104.y * 0.023 ) ) * 1.8 ) ) ) ) {

				nodeVar146 = -1.2;

			} else {

				nodeVar146 = ( 0.1 + ( nodeVar132 * 0.2 ) );

			}

			nodeVar144 = nodeVar146;
			

		}


		if ( ( ( nodeVar104.y > -175.0 ) && ( abs( ( nodeVar104.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar104.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar104.y ) ) ) ) ) ) < 7.3 ) ) ) {

			nodeVar144 = 0.0;
			

		}

		nodeVar147 = nodeVar144;
		nodeVar148 = ( nodeVar104.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar104.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar104.y ) ) ) ) );
		nodeVar149 = ( ( ( ( ( ( nodeVar148 < -9.0 ) || ( nodeVar104.y < -175.0 ) ) && ( nodeVar147 > -0.2 ) ) && ( nodeVar147 < 115.0 ) ) && ( nodeVar101 > 0.15 ) ) && ( ( nodeVar104.y < -12.0 ) || ( nodeVar104.x < -45.0 ) ) );

		if ( nodeVar149 ) {

			nodeVar150 = ( nodeVar53 - vec3<f32>( nodeVar104.x, nodeVar147, nodeVar104.y ) );
			nodeVar151 = ( 6.0 + ( nodeVar101 * 13.0 ) );
			nodeVar152 = clamp( ( nodeVar150.y / nodeVar151 ), 0.0, 1.0 );
			nodeVar153 = atan2( nodeVar150.z, nodeVar150.x );
			nodeVar154 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar150.y * 3.5 ) + ( nodeVar101 * 13.0 ) ) ) ) );
			nodeVar155 = ( ( ( 1.0 - nodeVar152 ) * ( 2.0 + ( nodeVar101 * 1.45 ) ) ) * nodeVar154 );
			nodeVar155 = ( nodeVar155 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar153 * 9.0 ) + ( nodeVar150.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar153 * 19.0 ) - ( nodeVar150.y * 6.0 ) ) ) ) ) );
			nodeVar156 = ( ( nodeVar150.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar150.y * 2.0 ) ) );
			nodeVar157 = floor( nodeVar156 );
			nodeVar158 = fract( nodeVar156 );
			nodeVar158 = ( ( nodeVar158 * nodeVar158 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar158 ) ) );
			nodeVar159 = fract( ( vec3<f32>( nodeVar157, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar159 = ( nodeVar159 + vec3<f32>( dot( nodeVar159, ( nodeVar159.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar160 = fract( ( vec3<f32>( ( nodeVar157 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar160 = ( nodeVar160 + vec3<f32>( dot( nodeVar160, ( nodeVar160.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar161 = fract( ( vec3<f32>( ( nodeVar157 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar161 = ( nodeVar161 + vec3<f32>( dot( nodeVar161, ( nodeVar161.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar162 = fract( ( vec3<f32>( ( nodeVar157 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar162 = ( nodeVar162 + vec3<f32>( dot( nodeVar162, ( nodeVar162.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar163 = ( ( ( mix( mix( fract( ( ( nodeVar159.x + nodeVar159.y ) * nodeVar159.z ) ), fract( ( ( nodeVar160.x + nodeVar160.y ) * nodeVar160.z ) ), nodeVar158.x ), mix( fract( ( ( nodeVar161.x + nodeVar161.y ) * nodeVar161.z ) ), fract( ( ( nodeVar162.x + nodeVar162.y ) * nodeVar162.z ) ), nodeVar158.x ), nodeVar158.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar152 ) );
			nodeVar164 = ( max( ( ( length( nodeVar150.xz ) - nodeVar155 ) + nodeVar163 ), max( ( 0.8 - nodeVar150.y ), ( nodeVar150.y - nodeVar151 ) ) ) * 0.67 );
			nodeVar166 = vec2<f32>( nodeVar164, 2.0 );

			if ( ( nodeVar98.x < nodeVar166.x ) ) {

				nodeVar165 = nodeVar98;

			} else {

				nodeVar165 = nodeVar166;

			}

			nodeVar98 = nodeVar165;
			nodeVar168 = vec2<f32>( max( ( length( nodeVar150.xz ) - ( 0.13 * ( 1.0 - ( nodeVar152 * 0.65 ) ) ) ), max( ( - nodeVar150.y ), ( nodeVar150.y - nodeVar151 ) ) ), 3.0 );

			if ( ( nodeVar98.x < nodeVar168.x ) ) {

				nodeVar167 = nodeVar98;

			} else {

				nodeVar167 = nodeVar168;

			}

			nodeVar98 = nodeVar167;
			

		}

		nodeVar169 = clamp( floor( ( ( ( ( - nodeVar53.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
		nodeVar170 = ( -10.0 - ( nodeVar169 * 38.0 ) );
		nodeVar171 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar170 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar170 ) ) ) ) - 6.35 );
		nodeVar172 = ( nodeVar53 - vec3<f32>( nodeVar171, 0.0, nodeVar170 ) );
		nodeVar173 = ( nodeVar172 - vec3<f32>( 0.0, 0.0, 0.0 ) );
		nodeVar174 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
		nodeVar175 = ( length( ( nodeVar173 - ( nodeVar174 * vec3<f32>( clamp( ( dot( nodeVar173, nodeVar174 ) / dot( nodeVar174, nodeVar174 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
		nodeVar176 = ( nodeVar172 - vec3<f32>( 0.0, 7.6, 0.0 ) );
		nodeVar177 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
		nodeVar175 = min( nodeVar175, ( length( ( nodeVar176 - ( nodeVar177 * vec3<f32>( clamp( ( dot( nodeVar176, nodeVar177 ) / dot( nodeVar177, nodeVar177 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
		nodeVar178 = ( nodeVar172 - vec3<f32>( 1.6, 8.05, 0.0 ) );
		nodeVar179 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
		nodeVar175 = min( nodeVar175, ( length( ( nodeVar178 - ( nodeVar179 * vec3<f32>( clamp( ( dot( nodeVar178, nodeVar179 ) / dot( nodeVar179, nodeVar179 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
		nodeVar180 = ( abs( ( nodeVar172 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
		nodeVar175 = min( nodeVar175, ( length( max( nodeVar180, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar180.x, max( nodeVar180.y, nodeVar180.z ) ), 0.0 ) ) );
		nodeVar182 = vec2<f32>( nodeVar175, 4.0 );

		if ( ( nodeVar98.x < nodeVar182.x ) ) {

			nodeVar181 = nodeVar98;

		} else {

			nodeVar181 = nodeVar182;

		}

		nodeVar98 = nodeVar181;
		nodeVar184 = ( abs( ( nodeVar172 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
		nodeVar185 = vec2<f32>( ( length( max( nodeVar184, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar184.x, max( nodeVar184.y, nodeVar184.z ) ), 0.0 ) ), 6.0 );

		if ( ( nodeVar98.x < nodeVar185.x ) ) {

			nodeVar183 = nodeVar98;

		} else {

			nodeVar183 = nodeVar185;

		}

		nodeVar98 = nodeVar183;

		if ( ( ( nodeVar53.z < 28.0 ) && ( nodeVar53.z > -176.0 ) ) ) {

			nodeVar186 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar53.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar53.z ) ) ) ) + 6.3 );
			nodeVar187 = ( abs( vec3<f32>( ( nodeVar53.x - nodeVar186 ), ( nodeVar53.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
			nodeVar188 = ( length( max( nodeVar187, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar187.x, max( nodeVar187.y, nodeVar187.z ) ), 0.0 ) );
			nodeVar189 = ( floor( ( ( nodeVar53.z / 5.0 ) + 0.5 ) ) * 5.0 );
			nodeVar190 = ( abs( ( nodeVar53 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar189 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar189 ) ) ) ) + 6.3 ), 0.45, nodeVar189 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
			nodeVar188 = min( nodeVar188, ( length( max( nodeVar190, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar190.x, max( nodeVar190.y, nodeVar190.z ) ), 0.0 ) ) );
			nodeVar192 = vec2<f32>( nodeVar188, 4.0 );

			if ( ( nodeVar98.x < nodeVar192.x ) ) {

				nodeVar191 = nodeVar98;

			} else {

				nodeVar191 = nodeVar192;

			}

			nodeVar98 = nodeVar191;
			

		}

		nodeVar193 = ( nodeVar53 - vec3<f32>( -17.0, 1.85, -73.0 ) );
		nodeVar194 = ( abs( nodeVar193 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
		nodeVar195 = ( length( max( nodeVar194, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar194.x, max( nodeVar194.y, nodeVar194.z ) ), 0.0 ) );
		nodeVar197 = vec2<f32>( nodeVar195, 9.0 );

		if ( ( nodeVar98.x < nodeVar197.x ) ) {

			nodeVar196 = nodeVar98;

		} else {

			nodeVar196 = nodeVar197;

		}

		nodeVar98 = nodeVar196;
		nodeVar199 = ( abs( ( nodeVar53 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
		nodeVar200 = vec2<f32>( ( length( max( nodeVar199, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar199.x, max( nodeVar199.y, nodeVar199.z ) ), 0.0 ) ), 4.0 );

		if ( ( nodeVar98.x < nodeVar200.x ) ) {

			nodeVar198 = nodeVar98;

		} else {

			nodeVar198 = nodeVar200;

		}

		nodeVar98 = nodeVar198;
		nodeVar202 = ( abs( ( nodeVar53 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
		nodeVar203 = vec2<f32>( ( length( max( nodeVar202, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar202.x, max( nodeVar202.y, nodeVar202.z ) ), 0.0 ) ), 6.0 );

		if ( ( nodeVar98.x < nodeVar203.x ) ) {

			nodeVar201 = nodeVar98;

		} else {

			nodeVar201 = nodeVar203;

		}

		nodeVar98 = nodeVar201;
		nodeVar205 = ( nodeVar53 - vec3<f32>( -19.0, 3.9, -74.0 ) );
		nodeVar206 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
		nodeVar207 = vec2<f32>( ( length( ( nodeVar205 - ( nodeVar206 * vec3<f32>( clamp( ( dot( nodeVar205, nodeVar206 ) / dot( nodeVar206, nodeVar206 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

		if ( ( nodeVar98.x < nodeVar207.x ) ) {

			nodeVar204 = nodeVar98;

		} else {

			nodeVar204 = nodeVar207;

		}

		nodeVar98 = nodeVar204;
		nodeVar208 = nodeVar98;
		nodeVar209 = max( 0.007, ( nodeVar51 * 0.00048 ) );

		if ( ( nodeVar208.x < nodeVar209 ) ) {

			nodeVar52 = nodeVar208.y;
			break;
			

		}

		nodeVar210 = max( 0.05, ( nodeVar208.x * 0.87 ) );

		if ( ( ( nodeVar53.y < 34.0 ) && ( nodeVar51 < 270.0 ) ) ) {

			nodeVar210 = min( nodeVar210, 4.8 );
			

		}

		nodeVar51 = ( nodeVar51 + nodeVar210 );

	}

	nodeVar211 = vec2<f32>( nodeVar51, nodeVar52 );
	nodeVar212 = nodeVar211.x;
	nodeVar213 = nodeVar211.y;
	nodeVar214 = ( frame.nodeUniform8 + ( nodeVar2 * vec3<f32>( nodeVar212 ) ) );
	nodeVar216 = nodeVar215;
	nodeVar217 = nodeVar4;
	nodeVar218 = ( ( ( nodeVar213 < 0.0 ) && ( nodeVar6 > 0.0 ) ) && ( nodeVar6 < 1800.0 ) );

	if ( nodeVar218 ) {

		nodeVar212 = nodeVar6;
		nodeVar214 = ( frame.nodeUniform8 + ( nodeVar2 * vec3<f32>( nodeVar212 ) ) );
		nodeVar219 = abs( ( nodeVar214.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.z ) ) ) ) ) );
		nodeVar220 = ( ( nodeVar214.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
		nodeVar221 = floor( nodeVar220 );
		nodeVar222 = fract( nodeVar220 );
		nodeVar222 = ( ( nodeVar222 * nodeVar222 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar222 ) ) );
		nodeVar223 = fract( ( vec3<f32>( nodeVar221, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar223 = ( nodeVar223 + vec3<f32>( dot( nodeVar223, ( nodeVar223.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar224 = fract( ( vec3<f32>( ( nodeVar221 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar224 = ( nodeVar224 + vec3<f32>( dot( nodeVar224, ( nodeVar224.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar225 = fract( ( vec3<f32>( ( nodeVar221 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar225 = ( nodeVar225 + vec3<f32>( dot( nodeVar225, ( nodeVar225.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar226 = fract( ( vec3<f32>( ( nodeVar221 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar226 = ( nodeVar226 + vec3<f32>( dot( nodeVar226, ( nodeVar226.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar227 = ( 0.5 * mix( mix( fract( ( ( nodeVar223.x + nodeVar223.y ) * nodeVar223.z ) ), fract( ( ( nodeVar224.x + nodeVar224.y ) * nodeVar224.z ) ), nodeVar222.x ), mix( fract( ( ( nodeVar225.x + nodeVar225.y ) * nodeVar225.z ) ), fract( ( ( nodeVar226.x + nodeVar226.y ) * nodeVar226.z ) ), nodeVar222.x ), nodeVar222.y ) );
		nodeVar220 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar220 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
		nodeVar228 = floor( nodeVar220 );
		nodeVar229 = fract( nodeVar220 );
		nodeVar229 = ( ( nodeVar229 * nodeVar229 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar229 ) ) );
		nodeVar230 = fract( ( vec3<f32>( nodeVar228, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar230 = ( nodeVar230 + vec3<f32>( dot( nodeVar230, ( nodeVar230.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar231 = fract( ( vec3<f32>( ( nodeVar228 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar231 = ( nodeVar231 + vec3<f32>( dot( nodeVar231, ( nodeVar231.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar232 = fract( ( vec3<f32>( ( nodeVar228 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar232 = ( nodeVar232 + vec3<f32>( dot( nodeVar232, ( nodeVar232.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar233 = fract( ( vec3<f32>( ( nodeVar228 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar233 = ( nodeVar233 + vec3<f32>( dot( nodeVar233, ( nodeVar233.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar227 = ( nodeVar227 + ( 0.25 * mix( mix( fract( ( ( nodeVar230.x + nodeVar230.y ) * nodeVar230.z ) ), fract( ( ( nodeVar231.x + nodeVar231.y ) * nodeVar231.z ) ), nodeVar229.x ), mix( fract( ( ( nodeVar232.x + nodeVar232.y ) * nodeVar232.z ) ), fract( ( ( nodeVar233.x + nodeVar233.y ) * nodeVar233.z ) ), nodeVar229.x ), nodeVar229.y ) ) );
		nodeVar220 = ( ( nodeVar220 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
		nodeVar234 = floor( nodeVar220 );
		nodeVar235 = fract( nodeVar220 );
		nodeVar235 = ( ( nodeVar235 * nodeVar235 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar235 ) ) );
		nodeVar236 = fract( ( vec3<f32>( nodeVar234, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar236 = ( nodeVar236 + vec3<f32>( dot( nodeVar236, ( nodeVar236.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar237 = fract( ( vec3<f32>( ( nodeVar234 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar237 = ( nodeVar237 + vec3<f32>( dot( nodeVar237, ( nodeVar237.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar238 = fract( ( vec3<f32>( ( nodeVar234 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar238 = ( nodeVar238 + vec3<f32>( dot( nodeVar238, ( nodeVar238.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar239 = fract( ( vec3<f32>( ( nodeVar234 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar239 = ( nodeVar239 + vec3<f32>( dot( nodeVar239, ( nodeVar239.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar227 = ( nodeVar227 + ( 0.125 * mix( mix( fract( ( ( nodeVar236.x + nodeVar236.y ) * nodeVar236.z ) ), fract( ( ( nodeVar237.x + nodeVar237.y ) * nodeVar237.z ) ), nodeVar235.x ), mix( fract( ( ( nodeVar238.x + nodeVar238.y ) * nodeVar238.z ) ), fract( ( ( nodeVar239.x + nodeVar239.y ) * nodeVar239.z ) ), nodeVar235.x ), nodeVar235.y ) ) );
		nodeVar240 = ( ( nodeVar220 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
		nodeVar241 = floor( nodeVar240 );
		nodeVar242 = fract( nodeVar240 );
		nodeVar242 = ( ( nodeVar242 * nodeVar242 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar242 ) ) );
		nodeVar243 = fract( ( vec3<f32>( nodeVar241, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar243 = ( nodeVar243 + vec3<f32>( dot( nodeVar243, ( nodeVar243.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar244 = fract( ( vec3<f32>( ( nodeVar241 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar244 = ( nodeVar244 + vec3<f32>( dot( nodeVar244, ( nodeVar244.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar245 = fract( ( vec3<f32>( ( nodeVar241 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar245 = ( nodeVar245 + vec3<f32>( dot( nodeVar245, ( nodeVar245.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar246 = fract( ( vec3<f32>( ( nodeVar241 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar246 = ( nodeVar246 + vec3<f32>( dot( nodeVar246, ( nodeVar246.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar247 = ( nodeVar227 + ( 0.0625 * mix( mix( fract( ( ( nodeVar243.x + nodeVar243.y ) * nodeVar243.z ) ), fract( ( ( nodeVar244.x + nodeVar244.y ) * nodeVar244.z ) ), nodeVar242.x ), mix( fract( ( ( nodeVar245.x + nodeVar245.y ) * nodeVar245.z ) ), fract( ( ( nodeVar246.x + nodeVar246.y ) * nodeVar246.z ) ), nodeVar242.x ), nodeVar242.y ) ) );
		nodeVar248 = ( nodeVar214.xz * vec2<f32>( 0.018 ) );
		nodeVar249 = floor( nodeVar248 );
		nodeVar250 = fract( nodeVar248 );
		nodeVar250 = ( ( nodeVar250 * nodeVar250 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar250 ) ) );
		nodeVar251 = fract( ( vec3<f32>( nodeVar249, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar251 = ( nodeVar251 + vec3<f32>( dot( nodeVar251, ( nodeVar251.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar252 = fract( ( vec3<f32>( ( nodeVar249 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar252 = ( nodeVar252 + vec3<f32>( dot( nodeVar252, ( nodeVar252.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar253 = fract( ( vec3<f32>( ( nodeVar249 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar253 = ( nodeVar253 + vec3<f32>( dot( nodeVar253, ( nodeVar253.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar254 = fract( ( vec3<f32>( ( nodeVar249 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar254 = ( nodeVar254 + vec3<f32>( dot( nodeVar254, ( nodeVar254.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar255 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar251.x + nodeVar251.y ) * nodeVar251.z ) ), fract( ( ( nodeVar252.x + nodeVar252.y ) * nodeVar252.z ) ), nodeVar250.x ), mix( fract( ( ( nodeVar253.x + nodeVar253.y ) * nodeVar253.z ) ), fract( ( ( nodeVar254.x + nodeVar254.y ) * nodeVar254.z ) ), nodeVar250.x ), nodeVar250.y ) * 2.0 ) - 1.0 ) ) );
		nodeVar256 = ( smoothstep( 13.0, 155.0, ( - nodeVar214.xz.x ) ) * ( ( 28.0 + ( nodeVar247 * 135.0 ) ) + ( nodeVar255 * 20.0 ) ) );
		nodeVar257 = ( smoothstep( 280.0, 670.0, ( - nodeVar214.xz.y ) ) * ( ( 46.0 + ( nodeVar247 * 155.0 ) ) + ( nodeVar255 * 22.0 ) ) );
		nodeVar258 = ( smoothstep( 190.0, 430.0, nodeVar214.xz.x ) * ( 30.0 + ( nodeVar247 * 95.0 ) ) );
		nodeVar259 = max( max( nodeVar256, nodeVar257 ), nodeVar258 );
		nodeVar260 = ( exp( ( - dot( ( ( nodeVar214.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar214.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar247 * 10.0 ) ) );
		nodeVar259 = max( nodeVar259, nodeVar260 );

		if ( ( nodeVar259 < 1.5 ) ) {


			if ( ( nodeVar214.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar214.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

				nodeVar261 = -1.2;

			} else {

				nodeVar261 = ( 0.1 + ( nodeVar247 * 0.2 ) );

			}

			nodeVar259 = nodeVar261;
			

		}


		if ( ( ( nodeVar214.xz.y > -175.0 ) && ( abs( ( nodeVar214.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

			nodeVar259 = 0.0;
			

		}

		nodeVar50 = ( ( nodeVar214.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.z ) ) ) ) + 9.2 ) + ( sin( ( nodeVar214.z * 0.023 ) ) * 1.8 ) ) ) && ( nodeVar259 < 0.0 ) );
		nodeVar262 = ( ( nodeVar219 < 5.35 ) && ( nodeVar214.z > -190.0 ) );
		nodeVar263 = floor( ( nodeVar214.xz / vec2<f32>( 2.2 ) ) );
		nodeVar264 = vec2<f32>( 0.0, 0.0 );

		for ( var i : i32 = -1; i <= 1; i ++ ) {

			for ( var j : i32 = -1; j <= 1; j ++ ) {

				nodeVar265 = ( nodeVar263 + vec2<f32>( f32( i ), f32( j ) ) );
				nodeVar266 = fract( ( vec3<f32>( ( nodeVar265 + vec2<f32>( 3.9 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar266 = ( nodeVar266 + vec3<f32>( dot( nodeVar266, ( nodeVar266.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar267 = fract( ( ( nodeVar266.x + nodeVar266.y ) * nodeVar266.z ) );
				nodeVar268 = fract( ( vec3<f32>( ( nodeVar265 + vec2<f32>( 19.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar268 = ( nodeVar268 + vec3<f32>( dot( nodeVar268, ( nodeVar268.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar269 = ( ( nodeVar265 + vec2<f32>( nodeVar267, fract( ( ( nodeVar268.x + nodeVar268.y ) * nodeVar268.z ) ) ) ) * vec2<f32>( 2.2 ) );
				nodeVar270 = ( nodeVar214.xz - nodeVar269 );
				nodeVar271 = ( length( nodeVar270 ) + 0.001 );
				nodeVar272 = fract( ( ( frame.nodeUniform9 * ( 0.6 + ( frame.nodeUniform10 * 0.2 ) ) ) + ( nodeVar267 * 7.3 ) ) );
				nodeVar273 = ( nodeVar271 - ( nodeVar272 * 1.7 ) );
				nodeVar274 = ( ( exp( ( ( - abs( nodeVar273 ) ) * 20.0 ) ) * ( 1.0 - nodeVar272 ) ) * smoothstep( 0.025, 0.1, nodeVar272 ) );
				nodeVar264 = ( nodeVar264 + ( ( ( ( nodeVar270 / vec2<f32>( nodeVar271 ) ) * vec2<f32>( cos( ( nodeVar273 * 95.0 ) ) ) ) * vec2<f32>( nodeVar274 ) ) * vec2<f32>( 0.055 ) ) );

			}

		}

		nodeVar275 = ( nodeVar264 * vec2<f32>( frame.nodeUniform10 ) );
		nodeVar276 = ( nodeVar214.xz * vec2<f32>( 2.6 ) );
		nodeVar277 = floor( nodeVar276 );
		nodeVar278 = fract( nodeVar276 );
		nodeVar278 = ( ( nodeVar278 * nodeVar278 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar278 ) ) );
		nodeVar279 = fract( ( vec3<f32>( nodeVar277, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar279 = ( nodeVar279 + vec3<f32>( dot( nodeVar279, ( nodeVar279.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar280 = fract( ( vec3<f32>( ( nodeVar277 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar280 = ( nodeVar280 + vec3<f32>( dot( nodeVar280, ( nodeVar280.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar281 = fract( ( vec3<f32>( ( nodeVar277 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar281 = ( nodeVar281 + vec3<f32>( dot( nodeVar281, ( nodeVar281.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar282 = fract( ( vec3<f32>( ( nodeVar277 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar282 = ( nodeVar282 + vec3<f32>( dot( nodeVar282, ( nodeVar282.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar283 = mix( mix( fract( ( ( nodeVar279.x + nodeVar279.y ) * nodeVar279.z ) ), fract( ( ( nodeVar280.x + nodeVar280.y ) * nodeVar280.z ) ), nodeVar278.x ), mix( fract( ( ( nodeVar281.x + nodeVar281.y ) * nodeVar281.z ) ), fract( ( ( nodeVar282.x + nodeVar282.y ) * nodeVar282.z ) ), nodeVar278.x ), nodeVar278.y );
		nodeVar284 = ( nodeVar214.xz * vec2<f32>( 72.0 ) );
		nodeVar285 = floor( nodeVar284 );
		nodeVar286 = fract( nodeVar284 );
		nodeVar286 = ( ( nodeVar286 * nodeVar286 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar286 ) ) );
		nodeVar287 = fract( ( vec3<f32>( nodeVar285, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar287 = ( nodeVar287 + vec3<f32>( dot( nodeVar287, ( nodeVar287.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar288 = fract( ( vec3<f32>( ( nodeVar285 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar288 = ( nodeVar288 + vec3<f32>( dot( nodeVar288, ( nodeVar288.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar289 = fract( ( vec3<f32>( ( nodeVar285 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar289 = ( nodeVar289 + vec3<f32>( dot( nodeVar289, ( nodeVar289.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar290 = fract( ( vec3<f32>( ( nodeVar285 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar290 = ( nodeVar290 + vec3<f32>( dot( nodeVar290, ( nodeVar290.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar291 = mix( mix( fract( ( ( nodeVar287.x + nodeVar287.y ) * nodeVar287.z ) ), fract( ( ( nodeVar288.x + nodeVar288.y ) * nodeVar288.z ) ), nodeVar286.x ), mix( fract( ( ( nodeVar289.x + nodeVar289.y ) * nodeVar289.z ) ), fract( ( ( nodeVar290.x + nodeVar290.y ) * nodeVar290.z ) ), nodeVar286.x ), nodeVar286.y );
		nodeVar292 = ( ( nodeVar214.xz * vec2<f32>( 0.25 ) ) + vec2<f32>( 7.0 ) );
		nodeVar293 = floor( nodeVar292 );
		nodeVar294 = fract( nodeVar292 );
		nodeVar294 = ( ( nodeVar294 * nodeVar294 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar294 ) ) );
		nodeVar295 = fract( ( vec3<f32>( nodeVar293, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar295 = ( nodeVar295 + vec3<f32>( dot( nodeVar295, ( nodeVar295.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar296 = fract( ( vec3<f32>( ( nodeVar293 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar296 = ( nodeVar296 + vec3<f32>( dot( nodeVar296, ( nodeVar296.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar297 = fract( ( vec3<f32>( ( nodeVar293 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar297 = ( nodeVar297 + vec3<f32>( dot( nodeVar297, ( nodeVar297.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar298 = fract( ( vec3<f32>( ( nodeVar293 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar298 = ( nodeVar298 + vec3<f32>( dot( nodeVar298, ( nodeVar298.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar299 = ( 0.5 * mix( mix( fract( ( ( nodeVar295.x + nodeVar295.y ) * nodeVar295.z ) ), fract( ( ( nodeVar296.x + nodeVar296.y ) * nodeVar296.z ) ), nodeVar294.x ), mix( fract( ( ( nodeVar297.x + nodeVar297.y ) * nodeVar297.z ) ), fract( ( ( nodeVar298.x + nodeVar298.y ) * nodeVar298.z ) ), nodeVar294.x ), nodeVar294.y ) );
		nodeVar292 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar292 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
		nodeVar300 = floor( nodeVar292 );
		nodeVar301 = fract( nodeVar292 );
		nodeVar301 = ( ( nodeVar301 * nodeVar301 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar301 ) ) );
		nodeVar302 = fract( ( vec3<f32>( nodeVar300, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar302 = ( nodeVar302 + vec3<f32>( dot( nodeVar302, ( nodeVar302.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar303 = fract( ( vec3<f32>( ( nodeVar300 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar303 = ( nodeVar303 + vec3<f32>( dot( nodeVar303, ( nodeVar303.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar304 = fract( ( vec3<f32>( ( nodeVar300 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar304 = ( nodeVar304 + vec3<f32>( dot( nodeVar304, ( nodeVar304.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar305 = fract( ( vec3<f32>( ( nodeVar300 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar305 = ( nodeVar305 + vec3<f32>( dot( nodeVar305, ( nodeVar305.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar299 = ( nodeVar299 + ( 0.25 * mix( mix( fract( ( ( nodeVar302.x + nodeVar302.y ) * nodeVar302.z ) ), fract( ( ( nodeVar303.x + nodeVar303.y ) * nodeVar303.z ) ), nodeVar301.x ), mix( fract( ( ( nodeVar304.x + nodeVar304.y ) * nodeVar304.z ) ), fract( ( ( nodeVar305.x + nodeVar305.y ) * nodeVar305.z ) ), nodeVar301.x ), nodeVar301.y ) ) );
		nodeVar292 = ( ( nodeVar292 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
		nodeVar306 = floor( nodeVar292 );
		nodeVar307 = fract( nodeVar292 );
		nodeVar307 = ( ( nodeVar307 * nodeVar307 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar307 ) ) );
		nodeVar308 = fract( ( vec3<f32>( nodeVar306, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar308 = ( nodeVar308 + vec3<f32>( dot( nodeVar308, ( nodeVar308.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar309 = fract( ( vec3<f32>( ( nodeVar306 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar309 = ( nodeVar309 + vec3<f32>( dot( nodeVar309, ( nodeVar309.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar310 = fract( ( vec3<f32>( ( nodeVar306 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar310 = ( nodeVar310 + vec3<f32>( dot( nodeVar310, ( nodeVar310.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar311 = fract( ( vec3<f32>( ( nodeVar306 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar311 = ( nodeVar311 + vec3<f32>( dot( nodeVar311, ( nodeVar311.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar299 = ( nodeVar299 + ( 0.125 * mix( mix( fract( ( ( nodeVar308.x + nodeVar308.y ) * nodeVar308.z ) ), fract( ( ( nodeVar309.x + nodeVar309.y ) * nodeVar309.z ) ), nodeVar307.x ), mix( fract( ( ( nodeVar310.x + nodeVar310.y ) * nodeVar310.z ) ), fract( ( ( nodeVar311.x + nodeVar311.y ) * nodeVar311.z ) ), nodeVar307.x ), nodeVar307.y ) ) );
		nodeVar312 = ( ( nodeVar292 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
		nodeVar313 = floor( nodeVar312 );
		nodeVar314 = fract( nodeVar312 );
		nodeVar314 = ( ( nodeVar314 * nodeVar314 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar314 ) ) );
		nodeVar315 = fract( ( vec3<f32>( nodeVar313, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar315 = ( nodeVar315 + vec3<f32>( dot( nodeVar315, ( nodeVar315.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar316 = fract( ( vec3<f32>( ( nodeVar313 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar316 = ( nodeVar316 + vec3<f32>( dot( nodeVar316, ( nodeVar316.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar317 = fract( ( vec3<f32>( ( nodeVar313 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar317 = ( nodeVar317 + vec3<f32>( dot( nodeVar317, ( nodeVar317.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar318 = fract( ( vec3<f32>( ( nodeVar313 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar318 = ( nodeVar318 + vec3<f32>( dot( nodeVar318, ( nodeVar318.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar319 = ( smoothstep( 0.37, 0.64, ( nodeVar299 + ( 0.0625 * mix( mix( fract( ( ( nodeVar315.x + nodeVar315.y ) * nodeVar315.z ) ), fract( ( ( nodeVar316.x + nodeVar316.y ) * nodeVar316.z ) ), nodeVar314.x ), mix( fract( ( ( nodeVar317.x + nodeVar317.y ) * nodeVar317.z ) ), fract( ( ( nodeVar318.x + nodeVar318.y ) * nodeVar318.z ) ), nodeVar314.x ), nodeVar314.y ) ) ) ) * frame.nodeUniform11 );

		if ( nodeVar50 ) {

			nodeVar319 = 1.0;
			

		}


		if ( nodeVar50 ) {

			nodeVar320 = 0.018;

		} else {

			nodeVar320 = 0.0015;

		}

		nodeVar321 = ( vec2<f32>( cos( ( ( ( nodeVar214.x * 1.3 ) + ( nodeVar214.z * 0.8 ) ) + ( frame.nodeUniform9 * 1.7 ) ) ), sin( ( ( ( nodeVar214.z * 1.7 ) - ( nodeVar214.x * 0.4 ) ) - ( frame.nodeUniform9 * 1.2 ) ) ) ) * vec2<f32>( nodeVar320 ) );
		nodeVar322 = ( nodeVar214.xz * vec2<f32>( 35.0 ) );
		nodeVar323 = floor( nodeVar322 );
		nodeVar324 = fract( nodeVar322 );
		nodeVar324 = ( ( nodeVar324 * nodeVar324 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar324 ) ) );
		nodeVar325 = fract( ( vec3<f32>( nodeVar323, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar325 = ( nodeVar325 + vec3<f32>( dot( nodeVar325, ( nodeVar325.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar326 = fract( ( vec3<f32>( ( nodeVar323 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar326 = ( nodeVar326 + vec3<f32>( dot( nodeVar326, ( nodeVar326.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar327 = fract( ( vec3<f32>( ( nodeVar323 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar327 = ( nodeVar327 + vec3<f32>( dot( nodeVar327, ( nodeVar327.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar328 = fract( ( vec3<f32>( ( nodeVar323 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar328 = ( nodeVar328 + vec3<f32>( dot( nodeVar328, ( nodeVar328.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar329 = ( ( nodeVar214.xz * vec2<f32>( 35.0 ) ) + vec2<f32>( 9.0 ) );
		nodeVar330 = floor( nodeVar329 );
		nodeVar331 = fract( nodeVar329 );
		nodeVar331 = ( ( nodeVar331 * nodeVar331 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar331 ) ) );
		nodeVar332 = fract( ( vec3<f32>( nodeVar330, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar332 = ( nodeVar332 + vec3<f32>( dot( nodeVar332, ( nodeVar332.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar333 = fract( ( vec3<f32>( ( nodeVar330 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar333 = ( nodeVar333 + vec3<f32>( dot( nodeVar333, ( nodeVar333.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar334 = fract( ( vec3<f32>( ( nodeVar330 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar334 = ( nodeVar334 + vec3<f32>( dot( nodeVar334, ( nodeVar334.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar335 = fract( ( vec3<f32>( ( nodeVar330 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar335 = ( nodeVar335 + vec3<f32>( dot( nodeVar335, ( nodeVar335.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar336 = ( ( vec2<f32>( mix( mix( fract( ( ( nodeVar325.x + nodeVar325.y ) * nodeVar325.z ) ), fract( ( ( nodeVar326.x + nodeVar326.y ) * nodeVar326.z ) ), nodeVar324.x ), mix( fract( ( ( nodeVar327.x + nodeVar327.y ) * nodeVar327.z ) ), fract( ( ( nodeVar328.x + nodeVar328.y ) * nodeVar328.z ) ), nodeVar324.x ), nodeVar324.y ), mix( mix( fract( ( ( nodeVar332.x + nodeVar332.y ) * nodeVar332.z ) ), fract( ( ( nodeVar333.x + nodeVar333.y ) * nodeVar333.z ) ), nodeVar331.x ), mix( fract( ( ( nodeVar334.x + nodeVar334.y ) * nodeVar334.z ) ), fract( ( ( nodeVar335.x + nodeVar335.y ) * nodeVar335.z ) ), nodeVar331.x ), nodeVar331.y ) ) - vec2<f32>( 0.5 ) ) * vec2<f32>( mix( 0.22, 0.013, nodeVar319 ) ) );
		nodeVar216 = normalize( vec3<f32>( ( ( nodeVar336.x + nodeVar321.x ) + nodeVar275.x ), 1.0, ( ( nodeVar336.y + nodeVar321.y ) + nodeVar275.y ) ) );

		if ( nodeVar262 ) {

			nodeVar337 = ( vec3<f32>( 0.031, 0.037, 0.042 ) * vec3<f32>( ( ( 0.58 + ( nodeVar283 * 0.4 ) ) + ( nodeVar291 * 0.3 ) ) ) );

		} else {

			nodeVar337 = ( vec3<f32>( 0.075, 0.086, 0.07 ) * vec3<f32>( ( 0.7 + ( nodeVar283 * 0.45 ) ) ) );

		}

		nodeVar338 = nodeVar337;
		nodeVar339 = mix( 0.7, 0.08, nodeVar319 );

		if ( nodeVar262 ) {

			nodeVar340 = ( nodeVar214.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.z ) ) ) ) );
			nodeVar341 = ( 1.0 - smoothstep( 0.042, 0.062, abs( ( abs( nodeVar340 ) - 0.14 ) ) ) );
			nodeVar342 = ( 1.0 - smoothstep( 0.06, 0.085, abs( ( nodeVar219 - 5.04 ) ) ) );
			nodeVar343 = ( nodeVar214.xz * vec2<f32>( 26.0 ) );
			nodeVar344 = floor( nodeVar343 );
			nodeVar345 = fract( nodeVar343 );
			nodeVar345 = ( ( nodeVar345 * nodeVar345 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar345 ) ) );
			nodeVar346 = fract( ( vec3<f32>( nodeVar344, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar346 = ( nodeVar346 + vec3<f32>( dot( nodeVar346, ( nodeVar346.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar347 = fract( ( vec3<f32>( ( nodeVar344 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar347 = ( nodeVar347 + vec3<f32>( dot( nodeVar347, ( nodeVar347.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar348 = fract( ( vec3<f32>( ( nodeVar344 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar348 = ( nodeVar348 + vec3<f32>( dot( nodeVar348, ( nodeVar348.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar349 = fract( ( vec3<f32>( ( nodeVar344 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar349 = ( nodeVar349 + vec3<f32>( dot( nodeVar349, ( nodeVar349.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar350 = smoothstep( 0.1, 0.35, mix( mix( fract( ( ( nodeVar346.x + nodeVar346.y ) * nodeVar346.z ) ), fract( ( ( nodeVar347.x + nodeVar347.y ) * nodeVar347.z ) ), nodeVar345.x ), mix( fract( ( ( nodeVar348.x + nodeVar348.y ) * nodeVar348.z ) ), fract( ( ( nodeVar349.x + nodeVar349.y ) * nodeVar349.z ) ), nodeVar345.x ), nodeVar345.y ) );
			nodeVar338 = mix( nodeVar338, vec3<f32>( 0.5, 0.36, 0.11 ), ( ( nodeVar341 * nodeVar350 ) * 0.85 ) );
			nodeVar338 = mix( nodeVar338, vec3<f32>( 0.49, 0.54, 0.5 ), ( ( nodeVar342 * nodeVar350 ) * 0.6 ) );
			

		}


		if ( nodeVar50 ) {

			nodeVar338 = frame.nodeUniform12;
			nodeVar339 = 0.045;
			

		}

		nodeVar351 = ( 0.45 + ( 0.55 * max( nodeVar216.y, 0.0 ) ) );
		nodeVar352 = ( nodeVar338 * ( ( frame.nodeUniform13 * vec3<f32>( nodeVar351 ) ) + ( frame.nodeUniform14 * vec3<f32>( max( dot( nodeVar216, frame.nodeUniform15 ), 0.0 ) ) ) ) );
		nodeVar352 = ( nodeVar352 + ( ( ( nodeVar338 * vec3<f32>( frame.nodeUniform16 ) ) * vec3<f32>( ( 0.6 + ( max( dot( nodeVar216, normalize( ( frame.nodeUniform17 - nodeVar214 ) ) ), 0.0 ) * 2.5 ) ) ) ) * frame.nodeUniform18 ) );

		for ( var i : i32 = 0; i < 6; i ++ ) {

			nodeVar353 = ( -10.0 - ( f32( i ) * 38.0 ) );
			nodeVar354 = vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar353 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar353 ) ) ) ) - 3.9 ), 7.87, nodeVar353 );
			nodeVar355 = ( nodeVar354 - nodeVar214 );
			nodeVar356 = dot( nodeVar355, nodeVar355 );
			nodeVar355 = normalize( nodeVar355 );
			nodeVar357 = max( dot( nodeVar216, nodeVar355 ), 0.0 );
			nodeVar358 = ( smoothstep( 0.1, 0.62, ( - nodeVar355.y ) ) * smoothstep( -0.1, 0.1, nodeVar355.y ) );
			nodeVar359 = ( 48.0 / ( 1.0 + nodeVar356 ) );
			nodeVar360 = frame.nodeUniform19;
			nodeVar352 = ( nodeVar352 + ( ( ( ( nodeVar338 * nodeVar360 ) * vec3<f32>( nodeVar359 ) ) * vec3<f32>( nodeVar357 ) ) * vec3<f32>( 2.0 ) ) );
			nodeVar361 = normalize( ( nodeVar355 + ( - nodeVar2 ) ) );
			nodeVar362 = mix( 20.0, 900.0, ( 1.0 - nodeVar339 ) );
			nodeVar363 = ( ( pow( max( dot( nodeVar216, nodeVar361 ), 0.0 ), nodeVar362 ) * ( nodeVar362 + 2.0 ) ) * 0.018 );

			if ( ( nodeVar339 > 0.55 ) ) {

				nodeVar364 = 0.022;

			} else {

				nodeVar364 = 1.0;

			}

			nodeVar352 = ( nodeVar352 + ( ( ( ( nodeVar360 * vec3<f32>( nodeVar363 ) ) * vec3<f32>( nodeVar359 ) ) * vec3<f32>( nodeVar357 ) ) * vec3<f32>( nodeVar364 ) ) );

		}

		nodeVar217 = nodeVar352;
		nodeVar365 = ( 0.025 + ( 0.975 * pow( ( 1.0 - max( dot( ( - nodeVar2 ), nodeVar216 ), 0.0 ) ), 5.0 ) ) );
		nodeVar366 = clamp( ( nodeVarying0 + ( vec2<f32>( nodeVar216.x, nodeVar216.z ) * vec2<f32>( 0.07, 0.05 ) ) ), vec2<f32>( 0.002 ), vec2<f32>( 0.998 ) );
		nodeVar367 = textureSample( nodeUniform7, nodeUniform7_sampler, vec2<f32>( nodeVar366.x, ( 1.0 - nodeVar366.y ) ) );
		nodeVar368 = nodeVar367.xyz;

		if ( ( f32( frame.nodeUniform20 ) != 0.0 ) ) {

			nodeVar369 = 0.5;

			for ( var i : i32 = 0; i < 36; i ++ ) {


				if ( ( nodeVar369 > 280.0 ) ) {

					break;
					

				}

				nodeVar370 = reflect( nodeVar2, nodeVar216 );
				nodeVar371 = ( ( nodeVar214 + ( nodeVar216 * vec3<f32>( 0.1 ) ) ) + ( nodeVar370 * vec3<f32>( nodeVar369 ) ) );
				nodeVar372 = ( ( nodeVar371.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
				nodeVar373 = floor( nodeVar372 );
				nodeVar374 = fract( nodeVar372 );
				nodeVar374 = ( ( nodeVar374 * nodeVar374 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar374 ) ) );
				nodeVar375 = fract( ( vec3<f32>( nodeVar373, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar375 = ( nodeVar375 + vec3<f32>( dot( nodeVar375, ( nodeVar375.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar376 = fract( ( vec3<f32>( ( nodeVar373 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar376 = ( nodeVar376 + vec3<f32>( dot( nodeVar376, ( nodeVar376.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar377 = fract( ( vec3<f32>( ( nodeVar373 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar377 = ( nodeVar377 + vec3<f32>( dot( nodeVar377, ( nodeVar377.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar378 = fract( ( vec3<f32>( ( nodeVar373 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar378 = ( nodeVar378 + vec3<f32>( dot( nodeVar378, ( nodeVar378.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar379 = ( 0.5 * mix( mix( fract( ( ( nodeVar375.x + nodeVar375.y ) * nodeVar375.z ) ), fract( ( ( nodeVar376.x + nodeVar376.y ) * nodeVar376.z ) ), nodeVar374.x ), mix( fract( ( ( nodeVar377.x + nodeVar377.y ) * nodeVar377.z ) ), fract( ( ( nodeVar378.x + nodeVar378.y ) * nodeVar378.z ) ), nodeVar374.x ), nodeVar374.y ) );
				nodeVar372 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar372 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
				nodeVar380 = floor( nodeVar372 );
				nodeVar381 = fract( nodeVar372 );
				nodeVar381 = ( ( nodeVar381 * nodeVar381 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar381 ) ) );
				nodeVar382 = fract( ( vec3<f32>( nodeVar380, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar382 = ( nodeVar382 + vec3<f32>( dot( nodeVar382, ( nodeVar382.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar383 = fract( ( vec3<f32>( ( nodeVar380 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar383 = ( nodeVar383 + vec3<f32>( dot( nodeVar383, ( nodeVar383.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar384 = fract( ( vec3<f32>( ( nodeVar380 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar384 = ( nodeVar384 + vec3<f32>( dot( nodeVar384, ( nodeVar384.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar385 = fract( ( vec3<f32>( ( nodeVar380 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar385 = ( nodeVar385 + vec3<f32>( dot( nodeVar385, ( nodeVar385.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar379 = ( nodeVar379 + ( 0.25 * mix( mix( fract( ( ( nodeVar382.x + nodeVar382.y ) * nodeVar382.z ) ), fract( ( ( nodeVar383.x + nodeVar383.y ) * nodeVar383.z ) ), nodeVar381.x ), mix( fract( ( ( nodeVar384.x + nodeVar384.y ) * nodeVar384.z ) ), fract( ( ( nodeVar385.x + nodeVar385.y ) * nodeVar385.z ) ), nodeVar381.x ), nodeVar381.y ) ) );
				nodeVar372 = ( ( nodeVar372 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
				nodeVar386 = floor( nodeVar372 );
				nodeVar387 = fract( nodeVar372 );
				nodeVar387 = ( ( nodeVar387 * nodeVar387 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar387 ) ) );
				nodeVar388 = fract( ( vec3<f32>( nodeVar386, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar388 = ( nodeVar388 + vec3<f32>( dot( nodeVar388, ( nodeVar388.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar389 = fract( ( vec3<f32>( ( nodeVar386 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar389 = ( nodeVar389 + vec3<f32>( dot( nodeVar389, ( nodeVar389.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar390 = fract( ( vec3<f32>( ( nodeVar386 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar390 = ( nodeVar390 + vec3<f32>( dot( nodeVar390, ( nodeVar390.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar391 = fract( ( vec3<f32>( ( nodeVar386 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar391 = ( nodeVar391 + vec3<f32>( dot( nodeVar391, ( nodeVar391.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar379 = ( nodeVar379 + ( 0.125 * mix( mix( fract( ( ( nodeVar388.x + nodeVar388.y ) * nodeVar388.z ) ), fract( ( ( nodeVar389.x + nodeVar389.y ) * nodeVar389.z ) ), nodeVar387.x ), mix( fract( ( ( nodeVar390.x + nodeVar390.y ) * nodeVar390.z ) ), fract( ( ( nodeVar391.x + nodeVar391.y ) * nodeVar391.z ) ), nodeVar387.x ), nodeVar387.y ) ) );
				nodeVar392 = ( ( nodeVar372 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
				nodeVar393 = floor( nodeVar392 );
				nodeVar394 = fract( nodeVar392 );
				nodeVar394 = ( ( nodeVar394 * nodeVar394 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar394 ) ) );
				nodeVar395 = fract( ( vec3<f32>( nodeVar393, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar395 = ( nodeVar395 + vec3<f32>( dot( nodeVar395, ( nodeVar395.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar396 = fract( ( vec3<f32>( ( nodeVar393 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar396 = ( nodeVar396 + vec3<f32>( dot( nodeVar396, ( nodeVar396.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar397 = fract( ( vec3<f32>( ( nodeVar393 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar397 = ( nodeVar397 + vec3<f32>( dot( nodeVar397, ( nodeVar397.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar398 = fract( ( vec3<f32>( ( nodeVar393 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar398 = ( nodeVar398 + vec3<f32>( dot( nodeVar398, ( nodeVar398.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar399 = ( nodeVar379 + ( 0.0625 * mix( mix( fract( ( ( nodeVar395.x + nodeVar395.y ) * nodeVar395.z ) ), fract( ( ( nodeVar396.x + nodeVar396.y ) * nodeVar396.z ) ), nodeVar394.x ), mix( fract( ( ( nodeVar397.x + nodeVar397.y ) * nodeVar397.z ) ), fract( ( ( nodeVar398.x + nodeVar398.y ) * nodeVar398.z ) ), nodeVar394.x ), nodeVar394.y ) ) );
				nodeVar400 = ( nodeVar371.xz * vec2<f32>( 0.018 ) );
				nodeVar401 = floor( nodeVar400 );
				nodeVar402 = fract( nodeVar400 );
				nodeVar402 = ( ( nodeVar402 * nodeVar402 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar402 ) ) );
				nodeVar403 = fract( ( vec3<f32>( nodeVar401, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar403 = ( nodeVar403 + vec3<f32>( dot( nodeVar403, ( nodeVar403.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar404 = fract( ( vec3<f32>( ( nodeVar401 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar404 = ( nodeVar404 + vec3<f32>( dot( nodeVar404, ( nodeVar404.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar405 = fract( ( vec3<f32>( ( nodeVar401 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar405 = ( nodeVar405 + vec3<f32>( dot( nodeVar405, ( nodeVar405.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar406 = fract( ( vec3<f32>( ( nodeVar401 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar406 = ( nodeVar406 + vec3<f32>( dot( nodeVar406, ( nodeVar406.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar407 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar403.x + nodeVar403.y ) * nodeVar403.z ) ), fract( ( ( nodeVar404.x + nodeVar404.y ) * nodeVar404.z ) ), nodeVar402.x ), mix( fract( ( ( nodeVar405.x + nodeVar405.y ) * nodeVar405.z ) ), fract( ( ( nodeVar406.x + nodeVar406.y ) * nodeVar406.z ) ), nodeVar402.x ), nodeVar402.y ) * 2.0 ) - 1.0 ) ) );
				nodeVar408 = ( smoothstep( 13.0, 155.0, ( - nodeVar371.xz.x ) ) * ( ( 28.0 + ( nodeVar399 * 135.0 ) ) + ( nodeVar407 * 20.0 ) ) );
				nodeVar409 = ( smoothstep( 280.0, 670.0, ( - nodeVar371.xz.y ) ) * ( ( 46.0 + ( nodeVar399 * 155.0 ) ) + ( nodeVar407 * 22.0 ) ) );
				nodeVar410 = ( smoothstep( 190.0, 430.0, nodeVar371.xz.x ) * ( 30.0 + ( nodeVar399 * 95.0 ) ) );
				nodeVar411 = max( max( nodeVar408, nodeVar409 ), nodeVar410 );
				nodeVar412 = ( exp( ( - dot( ( ( nodeVar371.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar371.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar399 * 10.0 ) ) );
				nodeVar411 = max( nodeVar411, nodeVar412 );

				if ( ( nodeVar411 < 1.5 ) ) {


					if ( ( nodeVar371.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar371.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar371.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar371.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

						nodeVar413 = -1.2;

					} else {

						nodeVar413 = ( 0.1 + ( nodeVar399 * 0.2 ) );

					}

					nodeVar411 = nodeVar413;
					

				}


				if ( ( ( nodeVar371.xz.y > -175.0 ) && ( abs( ( nodeVar371.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar371.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar371.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

					nodeVar411 = 0.0;
					

				}

				nodeVar414 = nodeVar411;

				if ( ( nodeVar414 > 1.0 ) ) {

					nodeVar415 = nodeVar414;

				} else {

					nodeVar415 = -3.5;

				}

				nodeVar416 = vec2<f32>( ( ( nodeVar371.y - nodeVar415 ) * 0.58 ), 1.0 );
				nodeVar417 = floor( ( ( nodeVar371.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
				nodeVar418 = fract( ( vec3<f32>( ( nodeVar417 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar418 = ( nodeVar418 + vec3<f32>( dot( nodeVar418, ( nodeVar418.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar419 = fract( ( ( nodeVar418.x + nodeVar418.y ) * nodeVar418.z ) );
				nodeVar420 = fract( ( vec3<f32>( ( nodeVar417 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar420 = ( nodeVar420 + vec3<f32>( dot( nodeVar420, ( nodeVar420.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar421 = fract( ( vec3<f32>( ( nodeVar417 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar421 = ( nodeVar421 + vec3<f32>( dot( nodeVar421, ( nodeVar421.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar422 = ( ( ( ( ( nodeVar417 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar420.x + nodeVar420.y ) * nodeVar420.z ) ), fract( ( ( nodeVar421.x + nodeVar421.y ) * nodeVar421.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
				nodeVar423 = ( ( nodeVar422 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
				nodeVar424 = floor( nodeVar423 );
				nodeVar425 = fract( nodeVar423 );
				nodeVar425 = ( ( nodeVar425 * nodeVar425 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar425 ) ) );
				nodeVar426 = fract( ( vec3<f32>( nodeVar424, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar426 = ( nodeVar426 + vec3<f32>( dot( nodeVar426, ( nodeVar426.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar427 = fract( ( vec3<f32>( ( nodeVar424 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar427 = ( nodeVar427 + vec3<f32>( dot( nodeVar427, ( nodeVar427.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar428 = fract( ( vec3<f32>( ( nodeVar424 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar428 = ( nodeVar428 + vec3<f32>( dot( nodeVar428, ( nodeVar428.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar429 = fract( ( vec3<f32>( ( nodeVar424 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar429 = ( nodeVar429 + vec3<f32>( dot( nodeVar429, ( nodeVar429.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar430 = ( 0.5 * mix( mix( fract( ( ( nodeVar426.x + nodeVar426.y ) * nodeVar426.z ) ), fract( ( ( nodeVar427.x + nodeVar427.y ) * nodeVar427.z ) ), nodeVar425.x ), mix( fract( ( ( nodeVar428.x + nodeVar428.y ) * nodeVar428.z ) ), fract( ( ( nodeVar429.x + nodeVar429.y ) * nodeVar429.z ) ), nodeVar425.x ), nodeVar425.y ) );
				nodeVar423 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar423 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
				nodeVar431 = floor( nodeVar423 );
				nodeVar432 = fract( nodeVar423 );
				nodeVar432 = ( ( nodeVar432 * nodeVar432 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar432 ) ) );
				nodeVar433 = fract( ( vec3<f32>( nodeVar431, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar433 = ( nodeVar433 + vec3<f32>( dot( nodeVar433, ( nodeVar433.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar434 = fract( ( vec3<f32>( ( nodeVar431 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar434 = ( nodeVar434 + vec3<f32>( dot( nodeVar434, ( nodeVar434.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar435 = fract( ( vec3<f32>( ( nodeVar431 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar435 = ( nodeVar435 + vec3<f32>( dot( nodeVar435, ( nodeVar435.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar436 = fract( ( vec3<f32>( ( nodeVar431 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar436 = ( nodeVar436 + vec3<f32>( dot( nodeVar436, ( nodeVar436.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar430 = ( nodeVar430 + ( 0.25 * mix( mix( fract( ( ( nodeVar433.x + nodeVar433.y ) * nodeVar433.z ) ), fract( ( ( nodeVar434.x + nodeVar434.y ) * nodeVar434.z ) ), nodeVar432.x ), mix( fract( ( ( nodeVar435.x + nodeVar435.y ) * nodeVar435.z ) ), fract( ( ( nodeVar436.x + nodeVar436.y ) * nodeVar436.z ) ), nodeVar432.x ), nodeVar432.y ) ) );
				nodeVar423 = ( ( nodeVar423 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
				nodeVar437 = floor( nodeVar423 );
				nodeVar438 = fract( nodeVar423 );
				nodeVar438 = ( ( nodeVar438 * nodeVar438 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar438 ) ) );
				nodeVar439 = fract( ( vec3<f32>( nodeVar437, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar439 = ( nodeVar439 + vec3<f32>( dot( nodeVar439, ( nodeVar439.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar440 = fract( ( vec3<f32>( ( nodeVar437 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar440 = ( nodeVar440 + vec3<f32>( dot( nodeVar440, ( nodeVar440.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar441 = fract( ( vec3<f32>( ( nodeVar437 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar441 = ( nodeVar441 + vec3<f32>( dot( nodeVar441, ( nodeVar441.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar442 = fract( ( vec3<f32>( ( nodeVar437 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar442 = ( nodeVar442 + vec3<f32>( dot( nodeVar442, ( nodeVar442.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar430 = ( nodeVar430 + ( 0.125 * mix( mix( fract( ( ( nodeVar439.x + nodeVar439.y ) * nodeVar439.z ) ), fract( ( ( nodeVar440.x + nodeVar440.y ) * nodeVar440.z ) ), nodeVar438.x ), mix( fract( ( ( nodeVar441.x + nodeVar441.y ) * nodeVar441.z ) ), fract( ( ( nodeVar442.x + nodeVar442.y ) * nodeVar442.z ) ), nodeVar438.x ), nodeVar438.y ) ) );
				nodeVar443 = ( ( nodeVar423 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
				nodeVar444 = floor( nodeVar443 );
				nodeVar445 = fract( nodeVar443 );
				nodeVar445 = ( ( nodeVar445 * nodeVar445 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar445 ) ) );
				nodeVar446 = fract( ( vec3<f32>( nodeVar444, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar446 = ( nodeVar446 + vec3<f32>( dot( nodeVar446, ( nodeVar446.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar447 = fract( ( vec3<f32>( ( nodeVar444 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar447 = ( nodeVar447 + vec3<f32>( dot( nodeVar447, ( nodeVar447.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar448 = fract( ( vec3<f32>( ( nodeVar444 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar448 = ( nodeVar448 + vec3<f32>( dot( nodeVar448, ( nodeVar448.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar449 = fract( ( vec3<f32>( ( nodeVar444 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar449 = ( nodeVar449 + vec3<f32>( dot( nodeVar449, ( nodeVar449.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar450 = ( nodeVar430 + ( 0.0625 * mix( mix( fract( ( ( nodeVar446.x + nodeVar446.y ) * nodeVar446.z ) ), fract( ( ( nodeVar447.x + nodeVar447.y ) * nodeVar447.z ) ), nodeVar445.x ), mix( fract( ( ( nodeVar448.x + nodeVar448.y ) * nodeVar448.z ) ), fract( ( ( nodeVar449.x + nodeVar449.y ) * nodeVar449.z ) ), nodeVar445.x ), nodeVar445.y ) ) );
				nodeVar451 = ( nodeVar422 * vec2<f32>( 0.018 ) );
				nodeVar452 = floor( nodeVar451 );
				nodeVar453 = fract( nodeVar451 );
				nodeVar453 = ( ( nodeVar453 * nodeVar453 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar453 ) ) );
				nodeVar454 = fract( ( vec3<f32>( nodeVar452, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar454 = ( nodeVar454 + vec3<f32>( dot( nodeVar454, ( nodeVar454.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar455 = fract( ( vec3<f32>( ( nodeVar452 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar455 = ( nodeVar455 + vec3<f32>( dot( nodeVar455, ( nodeVar455.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar456 = fract( ( vec3<f32>( ( nodeVar452 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar456 = ( nodeVar456 + vec3<f32>( dot( nodeVar456, ( nodeVar456.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar457 = fract( ( vec3<f32>( ( nodeVar452 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar457 = ( nodeVar457 + vec3<f32>( dot( nodeVar457, ( nodeVar457.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar458 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar454.x + nodeVar454.y ) * nodeVar454.z ) ), fract( ( ( nodeVar455.x + nodeVar455.y ) * nodeVar455.z ) ), nodeVar453.x ), mix( fract( ( ( nodeVar456.x + nodeVar456.y ) * nodeVar456.z ) ), fract( ( ( nodeVar457.x + nodeVar457.y ) * nodeVar457.z ) ), nodeVar453.x ), nodeVar453.y ) * 2.0 ) - 1.0 ) ) );
				nodeVar459 = ( smoothstep( 13.0, 155.0, ( - nodeVar422.x ) ) * ( ( 28.0 + ( nodeVar450 * 135.0 ) ) + ( nodeVar458 * 20.0 ) ) );
				nodeVar460 = ( smoothstep( 280.0, 670.0, ( - nodeVar422.y ) ) * ( ( 46.0 + ( nodeVar450 * 155.0 ) ) + ( nodeVar458 * 22.0 ) ) );
				nodeVar461 = ( smoothstep( 190.0, 430.0, nodeVar422.x ) * ( 30.0 + ( nodeVar450 * 95.0 ) ) );
				nodeVar462 = max( max( nodeVar459, nodeVar460 ), nodeVar461 );
				nodeVar463 = ( exp( ( - dot( ( ( nodeVar422 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar422 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar450 * 10.0 ) ) );
				nodeVar462 = max( nodeVar462, nodeVar463 );

				if ( ( nodeVar462 < 1.5 ) ) {


					if ( ( nodeVar422.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar422.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar422.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar422.y * 0.023 ) ) * 1.8 ) ) ) ) {

						nodeVar464 = -1.2;

					} else {

						nodeVar464 = ( 0.1 + ( nodeVar450 * 0.2 ) );

					}

					nodeVar462 = nodeVar464;
					

				}


				if ( ( ( nodeVar422.y > -175.0 ) && ( abs( ( nodeVar422.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar422.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar422.y ) ) ) ) ) ) < 7.3 ) ) ) {

					nodeVar462 = 0.0;
					

				}

				nodeVar465 = nodeVar462;
				nodeVar466 = ( nodeVar422.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar422.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar422.y ) ) ) ) );
				nodeVar467 = ( ( ( ( ( ( nodeVar466 < -9.0 ) || ( nodeVar422.y < -175.0 ) ) && ( nodeVar465 > -0.2 ) ) && ( nodeVar465 < 115.0 ) ) && ( nodeVar419 > 0.15 ) ) && ( ( nodeVar422.y < -12.0 ) || ( nodeVar422.x < -45.0 ) ) );

				if ( nodeVar467 ) {

					nodeVar468 = ( nodeVar371 - vec3<f32>( nodeVar422.x, nodeVar465, nodeVar422.y ) );
					nodeVar469 = ( 6.0 + ( nodeVar419 * 13.0 ) );
					nodeVar470 = clamp( ( nodeVar468.y / nodeVar469 ), 0.0, 1.0 );
					nodeVar471 = atan2( nodeVar468.z, nodeVar468.x );
					nodeVar472 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar468.y * 3.5 ) + ( nodeVar419 * 13.0 ) ) ) ) );
					nodeVar473 = ( ( ( 1.0 - nodeVar470 ) * ( 2.0 + ( nodeVar419 * 1.45 ) ) ) * nodeVar472 );
					nodeVar473 = ( nodeVar473 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar471 * 9.0 ) + ( nodeVar468.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar471 * 19.0 ) - ( nodeVar468.y * 6.0 ) ) ) ) ) );
					nodeVar474 = ( ( nodeVar468.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar468.y * 2.0 ) ) );
					nodeVar475 = floor( nodeVar474 );
					nodeVar476 = fract( nodeVar474 );
					nodeVar476 = ( ( nodeVar476 * nodeVar476 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar476 ) ) );
					nodeVar477 = fract( ( vec3<f32>( nodeVar475, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar477 = ( nodeVar477 + vec3<f32>( dot( nodeVar477, ( nodeVar477.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar478 = fract( ( vec3<f32>( ( nodeVar475 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar478 = ( nodeVar478 + vec3<f32>( dot( nodeVar478, ( nodeVar478.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar479 = fract( ( vec3<f32>( ( nodeVar475 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar479 = ( nodeVar479 + vec3<f32>( dot( nodeVar479, ( nodeVar479.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar480 = fract( ( vec3<f32>( ( nodeVar475 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar480 = ( nodeVar480 + vec3<f32>( dot( nodeVar480, ( nodeVar480.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar481 = ( ( ( mix( mix( fract( ( ( nodeVar477.x + nodeVar477.y ) * nodeVar477.z ) ), fract( ( ( nodeVar478.x + nodeVar478.y ) * nodeVar478.z ) ), nodeVar476.x ), mix( fract( ( ( nodeVar479.x + nodeVar479.y ) * nodeVar479.z ) ), fract( ( ( nodeVar480.x + nodeVar480.y ) * nodeVar480.z ) ), nodeVar476.x ), nodeVar476.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar470 ) );
					nodeVar482 = ( max( ( ( length( nodeVar468.xz ) - nodeVar473 ) + nodeVar481 ), max( ( 0.8 - nodeVar468.y ), ( nodeVar468.y - nodeVar469 ) ) ) * 0.67 );
					nodeVar484 = vec2<f32>( nodeVar482, 2.0 );

					if ( ( nodeVar416.x < nodeVar484.x ) ) {

						nodeVar483 = nodeVar416;

					} else {

						nodeVar483 = nodeVar484;

					}

					nodeVar416 = nodeVar483;
					nodeVar486 = vec2<f32>( max( ( length( nodeVar468.xz ) - ( 0.13 * ( 1.0 - ( nodeVar470 * 0.65 ) ) ) ), max( ( - nodeVar468.y ), ( nodeVar468.y - nodeVar469 ) ) ), 3.0 );

					if ( ( nodeVar416.x < nodeVar486.x ) ) {

						nodeVar485 = nodeVar416;

					} else {

						nodeVar485 = nodeVar486;

					}

					nodeVar416 = nodeVar485;
					

				}

				nodeVar487 = clamp( floor( ( ( ( ( - nodeVar371.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
				nodeVar488 = ( -10.0 - ( nodeVar487 * 38.0 ) );
				nodeVar489 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar488 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar488 ) ) ) ) - 6.35 );
				nodeVar490 = ( nodeVar371 - vec3<f32>( nodeVar489, 0.0, nodeVar488 ) );
				nodeVar491 = ( nodeVar490 - vec3<f32>( 0.0, 0.0, 0.0 ) );
				nodeVar492 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
				nodeVar493 = ( length( ( nodeVar491 - ( nodeVar492 * vec3<f32>( clamp( ( dot( nodeVar491, nodeVar492 ) / dot( nodeVar492, nodeVar492 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
				nodeVar494 = ( nodeVar490 - vec3<f32>( 0.0, 7.6, 0.0 ) );
				nodeVar495 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
				nodeVar493 = min( nodeVar493, ( length( ( nodeVar494 - ( nodeVar495 * vec3<f32>( clamp( ( dot( nodeVar494, nodeVar495 ) / dot( nodeVar495, nodeVar495 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
				nodeVar496 = ( nodeVar490 - vec3<f32>( 1.6, 8.05, 0.0 ) );
				nodeVar497 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
				nodeVar493 = min( nodeVar493, ( length( ( nodeVar496 - ( nodeVar497 * vec3<f32>( clamp( ( dot( nodeVar496, nodeVar497 ) / dot( nodeVar497, nodeVar497 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
				nodeVar498 = ( abs( ( nodeVar490 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
				nodeVar493 = min( nodeVar493, ( length( max( nodeVar498, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar498.x, max( nodeVar498.y, nodeVar498.z ) ), 0.0 ) ) );
				nodeVar500 = vec2<f32>( nodeVar493, 4.0 );

				if ( ( nodeVar416.x < nodeVar500.x ) ) {

					nodeVar499 = nodeVar416;

				} else {

					nodeVar499 = nodeVar500;

				}

				nodeVar416 = nodeVar499;
				nodeVar502 = ( abs( ( nodeVar490 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
				nodeVar503 = vec2<f32>( ( length( max( nodeVar502, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar502.x, max( nodeVar502.y, nodeVar502.z ) ), 0.0 ) ), 6.0 );

				if ( ( nodeVar416.x < nodeVar503.x ) ) {

					nodeVar501 = nodeVar416;

				} else {

					nodeVar501 = nodeVar503;

				}

				nodeVar416 = nodeVar501;

				if ( ( ( nodeVar371.z < 28.0 ) && ( nodeVar371.z > -176.0 ) ) ) {

					nodeVar504 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar371.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar371.z ) ) ) ) + 6.3 );
					nodeVar505 = ( abs( vec3<f32>( ( nodeVar371.x - nodeVar504 ), ( nodeVar371.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
					nodeVar506 = ( length( max( nodeVar505, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar505.x, max( nodeVar505.y, nodeVar505.z ) ), 0.0 ) );
					nodeVar507 = ( floor( ( ( nodeVar371.z / 5.0 ) + 0.5 ) ) * 5.0 );
					nodeVar508 = ( abs( ( nodeVar371 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar507 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar507 ) ) ) ) + 6.3 ), 0.45, nodeVar507 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
					nodeVar506 = min( nodeVar506, ( length( max( nodeVar508, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar508.x, max( nodeVar508.y, nodeVar508.z ) ), 0.0 ) ) );
					nodeVar510 = vec2<f32>( nodeVar506, 4.0 );

					if ( ( nodeVar416.x < nodeVar510.x ) ) {

						nodeVar509 = nodeVar416;

					} else {

						nodeVar509 = nodeVar510;

					}

					nodeVar416 = nodeVar509;
					

				}

				nodeVar511 = ( nodeVar371 - vec3<f32>( -17.0, 1.85, -73.0 ) );
				nodeVar512 = ( abs( nodeVar511 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
				nodeVar513 = ( length( max( nodeVar512, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar512.x, max( nodeVar512.y, nodeVar512.z ) ), 0.0 ) );
				nodeVar515 = vec2<f32>( nodeVar513, 9.0 );

				if ( ( nodeVar416.x < nodeVar515.x ) ) {

					nodeVar514 = nodeVar416;

				} else {

					nodeVar514 = nodeVar515;

				}

				nodeVar416 = nodeVar514;
				nodeVar517 = ( abs( ( nodeVar371 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
				nodeVar518 = vec2<f32>( ( length( max( nodeVar517, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar517.x, max( nodeVar517.y, nodeVar517.z ) ), 0.0 ) ), 4.0 );

				if ( ( nodeVar416.x < nodeVar518.x ) ) {

					nodeVar516 = nodeVar416;

				} else {

					nodeVar516 = nodeVar518;

				}

				nodeVar416 = nodeVar516;
				nodeVar520 = ( abs( ( nodeVar371 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
				nodeVar521 = vec2<f32>( ( length( max( nodeVar520, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar520.x, max( nodeVar520.y, nodeVar520.z ) ), 0.0 ) ), 6.0 );

				if ( ( nodeVar416.x < nodeVar521.x ) ) {

					nodeVar519 = nodeVar416;

				} else {

					nodeVar519 = nodeVar521;

				}

				nodeVar416 = nodeVar519;
				nodeVar523 = ( nodeVar371 - vec3<f32>( -19.0, 3.9, -74.0 ) );
				nodeVar524 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
				nodeVar525 = vec2<f32>( ( length( ( nodeVar523 - ( nodeVar524 * vec3<f32>( clamp( ( dot( nodeVar523, nodeVar524 ) / dot( nodeVar524, nodeVar524 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

				if ( ( nodeVar416.x < nodeVar525.x ) ) {

					nodeVar522 = nodeVar416;

				} else {

					nodeVar522 = nodeVar525;

				}

				nodeVar416 = nodeVar522;
				nodeVar526 = nodeVar416;

				if ( ( nodeVar526.x < max( 0.03, ( nodeVar369 * 0.0016 ) ) ) ) {


					if ( ( ( nodeVar526.y > 5.5 ) && ( nodeVar526.y < 6.5 ) ) ) {

						nodeVar368 = ( frame.nodeUniform21 * vec3<f32>( 0.75 ) );
						

					} else {

						nodeVar527 = ( ( nodeVar371.xz * vec2<f32>( 4.3 ) ) + vec2<f32>( nodeVar371.y ) );
						nodeVar528 = floor( nodeVar527 );
						nodeVar529 = fract( nodeVar527 );
						nodeVar529 = ( ( nodeVar529 * nodeVar529 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar529 ) ) );
						nodeVar530 = fract( ( vec3<f32>( nodeVar528, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar530 = ( nodeVar530 + vec3<f32>( dot( nodeVar530, ( nodeVar530.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar531 = fract( ( vec3<f32>( ( nodeVar528 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar531 = ( nodeVar531 + vec3<f32>( dot( nodeVar531, ( nodeVar531.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar532 = fract( ( vec3<f32>( ( nodeVar528 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar532 = ( nodeVar532 + vec3<f32>( dot( nodeVar532, ( nodeVar532.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar533 = fract( ( vec3<f32>( ( nodeVar528 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar533 = ( nodeVar533 + vec3<f32>( dot( nodeVar533, ( nodeVar533.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar534 = ( nodeVar371.xz * vec2<f32>( 31.0 ) );
						nodeVar535 = floor( nodeVar534 );
						nodeVar536 = fract( nodeVar534 );
						nodeVar536 = ( ( nodeVar536 * nodeVar536 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar536 ) ) );
						nodeVar537 = fract( ( vec3<f32>( nodeVar535, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar537 = ( nodeVar537 + vec3<f32>( dot( nodeVar537, ( nodeVar537.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar538 = fract( ( vec3<f32>( ( nodeVar535 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar538 = ( nodeVar538 + vec3<f32>( dot( nodeVar538, ( nodeVar538.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar539 = fract( ( vec3<f32>( ( nodeVar535 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar539 = ( nodeVar539 + vec3<f32>( dot( nodeVar539, ( nodeVar539.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar540 = fract( ( vec3<f32>( ( nodeVar535 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar540 = ( nodeVar540 + vec3<f32>( dot( nodeVar540, ( nodeVar540.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar541 = ( ( mix( mix( fract( ( ( nodeVar530.x + nodeVar530.y ) * nodeVar530.z ) ), fract( ( ( nodeVar531.x + nodeVar531.y ) * nodeVar531.z ) ), nodeVar529.x ), mix( fract( ( ( nodeVar532.x + nodeVar532.y ) * nodeVar532.z ) ), fract( ( ( nodeVar533.x + nodeVar533.y ) * nodeVar533.z ) ), nodeVar529.x ), nodeVar529.y ) * 0.2 ) + ( mix( mix( fract( ( ( nodeVar537.x + nodeVar537.y ) * nodeVar537.z ) ), fract( ( ( nodeVar538.x + nodeVar538.y ) * nodeVar538.z ) ), nodeVar536.x ), mix( fract( ( ( nodeVar539.x + nodeVar539.y ) * nodeVar539.z ) ), fract( ( ( nodeVar540.x + nodeVar540.y ) * nodeVar540.z ) ), nodeVar536.x ), nodeVar536.y ) * 0.09 ) );
						nodeVar542 = vec3<f32>( 0.1, 0.1, 0.1 );

						if ( ( nodeVar526.y < 1.5 ) ) {

							nodeVar543 = ( ( nodeVar371.xz * vec2<f32>( 0.3 ) ) + vec2<f32>( ( nodeVar371.y * 0.4 ) ) );
							nodeVar544 = floor( nodeVar543 );
							nodeVar545 = fract( nodeVar543 );
							nodeVar545 = ( ( nodeVar545 * nodeVar545 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar545 ) ) );
							nodeVar546 = fract( ( vec3<f32>( nodeVar544, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar546 = ( nodeVar546 + vec3<f32>( dot( nodeVar546, ( nodeVar546.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar547 = fract( ( vec3<f32>( ( nodeVar544 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar547 = ( nodeVar547 + vec3<f32>( dot( nodeVar547, ( nodeVar547.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar548 = fract( ( vec3<f32>( ( nodeVar544 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar548 = ( nodeVar548 + vec3<f32>( dot( nodeVar548, ( nodeVar548.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar549 = fract( ( vec3<f32>( ( nodeVar544 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar549 = ( nodeVar549 + vec3<f32>( dot( nodeVar549, ( nodeVar549.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar550 = ( 0.5 * mix( mix( fract( ( ( nodeVar546.x + nodeVar546.y ) * nodeVar546.z ) ), fract( ( ( nodeVar547.x + nodeVar547.y ) * nodeVar547.z ) ), nodeVar545.x ), mix( fract( ( ( nodeVar548.x + nodeVar548.y ) * nodeVar548.z ) ), fract( ( ( nodeVar549.x + nodeVar549.y ) * nodeVar549.z ) ), nodeVar545.x ), nodeVar545.y ) );
							nodeVar543 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar543 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
							nodeVar551 = floor( nodeVar543 );
							nodeVar552 = fract( nodeVar543 );
							nodeVar552 = ( ( nodeVar552 * nodeVar552 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar552 ) ) );
							nodeVar553 = fract( ( vec3<f32>( nodeVar551, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar553 = ( nodeVar553 + vec3<f32>( dot( nodeVar553, ( nodeVar553.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar554 = fract( ( vec3<f32>( ( nodeVar551 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar554 = ( nodeVar554 + vec3<f32>( dot( nodeVar554, ( nodeVar554.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar555 = fract( ( vec3<f32>( ( nodeVar551 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar555 = ( nodeVar555 + vec3<f32>( dot( nodeVar555, ( nodeVar555.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar556 = fract( ( vec3<f32>( ( nodeVar551 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar556 = ( nodeVar556 + vec3<f32>( dot( nodeVar556, ( nodeVar556.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar550 = ( nodeVar550 + ( 0.25 * mix( mix( fract( ( ( nodeVar553.x + nodeVar553.y ) * nodeVar553.z ) ), fract( ( ( nodeVar554.x + nodeVar554.y ) * nodeVar554.z ) ), nodeVar552.x ), mix( fract( ( ( nodeVar555.x + nodeVar555.y ) * nodeVar555.z ) ), fract( ( ( nodeVar556.x + nodeVar556.y ) * nodeVar556.z ) ), nodeVar552.x ), nodeVar552.y ) ) );
							nodeVar543 = ( ( nodeVar543 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
							nodeVar557 = floor( nodeVar543 );
							nodeVar558 = fract( nodeVar543 );
							nodeVar558 = ( ( nodeVar558 * nodeVar558 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar558 ) ) );
							nodeVar559 = fract( ( vec3<f32>( nodeVar557, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar559 = ( nodeVar559 + vec3<f32>( dot( nodeVar559, ( nodeVar559.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar560 = fract( ( vec3<f32>( ( nodeVar557 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar560 = ( nodeVar560 + vec3<f32>( dot( nodeVar560, ( nodeVar560.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar561 = fract( ( vec3<f32>( ( nodeVar557 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar561 = ( nodeVar561 + vec3<f32>( dot( nodeVar561, ( nodeVar561.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar562 = fract( ( vec3<f32>( ( nodeVar557 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar562 = ( nodeVar562 + vec3<f32>( dot( nodeVar562, ( nodeVar562.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar550 = ( nodeVar550 + ( 0.125 * mix( mix( fract( ( ( nodeVar559.x + nodeVar559.y ) * nodeVar559.z ) ), fract( ( ( nodeVar560.x + nodeVar560.y ) * nodeVar560.z ) ), nodeVar558.x ), mix( fract( ( ( nodeVar561.x + nodeVar561.y ) * nodeVar561.z ) ), fract( ( ( nodeVar562.x + nodeVar562.y ) * nodeVar562.z ) ), nodeVar558.x ), nodeVar558.y ) ) );
							nodeVar563 = ( ( nodeVar543 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
							nodeVar564 = floor( nodeVar563 );
							nodeVar565 = fract( nodeVar563 );
							nodeVar565 = ( ( nodeVar565 * nodeVar565 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar565 ) ) );
							nodeVar566 = fract( ( vec3<f32>( nodeVar564, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar566 = ( nodeVar566 + vec3<f32>( dot( nodeVar566, ( nodeVar566.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar567 = fract( ( vec3<f32>( ( nodeVar564 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar567 = ( nodeVar567 + vec3<f32>( dot( nodeVar567, ( nodeVar567.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar568 = fract( ( vec3<f32>( ( nodeVar564 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar568 = ( nodeVar568 + vec3<f32>( dot( nodeVar568, ( nodeVar568.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar569 = fract( ( vec3<f32>( ( nodeVar564 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
							nodeVar569 = ( nodeVar569 + vec3<f32>( dot( nodeVar569, ( nodeVar569.yzx + vec3<f32>( 33.33 ) ) ) ) );
							nodeVar570 = ( smoothstep( 0.46, 0.66, ( nodeVar550 + ( 0.0625 * mix( mix( fract( ( ( nodeVar566.x + nodeVar566.y ) * nodeVar566.z ) ), fract( ( ( nodeVar567.x + nodeVar567.y ) * nodeVar567.z ) ), nodeVar565.x ), mix( fract( ( ( nodeVar568.x + nodeVar568.y ) * nodeVar568.z ) ), fract( ( ( nodeVar569.x + nodeVar569.y ) * nodeVar569.z ) ), nodeVar565.x ), nodeVar565.y ) ) ) ) * smoothstep( 0.4, 0.9, vec3<f32>( 0.0, 1.0, 0.0 ).y ) );
							nodeVar542 = ( mix( vec3<f32>( 0.075, 0.091, 0.09 ), vec3<f32>( 0.038, 0.068, 0.042 ), nodeVar570 ) * vec3<f32>( ( 0.7 + nodeVar541 ) ) );
							

						} else {


							if ( ( nodeVar526.y < 2.5 ) ) {

								nodeVar571 = ( ( nodeVar371.xz * vec2<f32>( 5.0 ) ) + vec2<f32>( nodeVar371.y ) );
								nodeVar572 = floor( nodeVar571 );
								nodeVar573 = fract( nodeVar571 );
								nodeVar573 = ( ( nodeVar573 * nodeVar573 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar573 ) ) );
								nodeVar574 = fract( ( vec3<f32>( nodeVar572, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
								nodeVar574 = ( nodeVar574 + vec3<f32>( dot( nodeVar574, ( nodeVar574.yzx + vec3<f32>( 33.33 ) ) ) ) );
								nodeVar575 = fract( ( vec3<f32>( ( nodeVar572 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
								nodeVar575 = ( nodeVar575 + vec3<f32>( dot( nodeVar575, ( nodeVar575.yzx + vec3<f32>( 33.33 ) ) ) ) );
								nodeVar576 = fract( ( vec3<f32>( ( nodeVar572 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
								nodeVar576 = ( nodeVar576 + vec3<f32>( dot( nodeVar576, ( nodeVar576.yzx + vec3<f32>( 33.33 ) ) ) ) );
								nodeVar577 = fract( ( vec3<f32>( ( nodeVar572 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
								nodeVar577 = ( nodeVar577 + vec3<f32>( dot( nodeVar577, ( nodeVar577.yzx + vec3<f32>( 33.33 ) ) ) ) );
								nodeVar542 = ( mix( vec3<f32>( 0.017, 0.034, 0.027 ), vec3<f32>( 0.045, 0.071, 0.047 ), mix( mix( fract( ( ( nodeVar574.x + nodeVar574.y ) * nodeVar574.z ) ), fract( ( ( nodeVar575.x + nodeVar575.y ) * nodeVar575.z ) ), nodeVar573.x ), mix( fract( ( ( nodeVar576.x + nodeVar576.y ) * nodeVar576.z ) ), fract( ( ( nodeVar577.x + nodeVar577.y ) * nodeVar577.z ) ), nodeVar573.x ), nodeVar573.y ) ) * vec3<f32>( ( 0.8 + ( max( vec3<f32>( 0.0, 1.0, 0.0 ).y, 0.0 ) * 0.35 ) ) ) );
								

							} else {


								if ( ( nodeVar526.y < 3.5 ) ) {

									nodeVar542 = vec3<f32>( 0.06, 0.047, 0.036 );
									

								} else {


									if ( ( nodeVar526.y < 4.5 ) ) {

										nodeVar542 = ( vec3<f32>( 0.12, 0.155, 0.17 ) * vec3<f32>( ( 0.8 + nodeVar541 ) ) );
										

									} else {


										if ( ( nodeVar526.y > 8.5 ) ) {

											nodeVar578 = ( 0.75 + ( 0.25 * smoothstep( 0.01, 0.1, abs( ( fract( ( nodeVar371.x * 3.0 ) ) - 0.5 ) ) ) ) );
											nodeVar542 = ( vec3<f32>( 0.09, 0.13, 0.14 ) * vec3<f32>( nodeVar578 ) );
											

										}

										

									}

									

								}

								

							}

							

						}

						nodeVar368 = mix( ( nodeVar542 * vec3<f32>( 0.7 ) ), ( mix( frame.nodeUniform22, frame.nodeUniform23, smoothstep( 0.0, 0.7, abs( nodeVar370.y ) ) ) + ( vec3<f32>( frame.nodeUniform16 ) * vec3<f32>( 0.11, 0.16, 0.24 ) ) ), ( 1.0 - exp( ( ( - nodeVar369 ) * ( 0.0015 + ( frame.nodeUniform24 * 0.004 ) ) ) ) ) );
						

					}

					break;
					

				}

				nodeVar369 = ( nodeVar369 + max( 0.15, ( nodeVar526.x * 0.9 ) ) );

			}

			

		}

		nodeVar579 = nodeVar368;

		if ( nodeVar50 ) {

			nodeVar580 = ( 0.25 + ( nodeVar365 * 0.7 ) );

		} else {

			nodeVar580 = ( ( ( frame.nodeUniform11 * 0.05 ) + ( nodeVar319 * 0.23 ) ) + ( nodeVar365 * 0.5 ) );

		}

		nodeVar581 = nodeVar580;
		nodeVar217 = mix( nodeVar217, nodeVar579, clamp( nodeVar581, 0.0, 0.94 ) );
		nodeVar217 = ( nodeVar217 + ( ( vec3<f32>( length( nodeVar275 ) ) * vec3<f32>( 0.055, 0.077, 0.09 ) ) * vec3<f32>( frame.nodeUniform10 ) ) );

		if ( nodeVar50 ) {

			nodeVar582 = 8.0;

		} else {


			if ( nodeVar262 ) {

				nodeVar583 = 7.0;

			} else {

				nodeVar583 = 1.0;

			}

			nodeVar582 = nodeVar583;

		}

		nodeVar213 = nodeVar582;
		

	} else {


		if ( ( nodeVar213 > 0.0 ) ) {

			nodeVar584 = max( 0.008, ( nodeVar212 * 0.00032 ) );
			nodeVar585 = ( vec2<f32>( 1.0, -1.0 ) * vec2<f32>( 0.5773 ) );
			nodeVar586 = ( nodeVar214 + ( vec3<f32>( nodeVar585, 0.0 ).xyy * vec3<f32>( nodeVar584 ) ) );
			nodeVar587 = ( ( nodeVar586.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar588 = floor( nodeVar587 );
			nodeVar589 = fract( nodeVar587 );
			nodeVar589 = ( ( nodeVar589 * nodeVar589 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar589 ) ) );
			nodeVar590 = fract( ( vec3<f32>( nodeVar588, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar590 = ( nodeVar590 + vec3<f32>( dot( nodeVar590, ( nodeVar590.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar591 = fract( ( vec3<f32>( ( nodeVar588 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar591 = ( nodeVar591 + vec3<f32>( dot( nodeVar591, ( nodeVar591.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar592 = fract( ( vec3<f32>( ( nodeVar588 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar592 = ( nodeVar592 + vec3<f32>( dot( nodeVar592, ( nodeVar592.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar593 = fract( ( vec3<f32>( ( nodeVar588 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar593 = ( nodeVar593 + vec3<f32>( dot( nodeVar593, ( nodeVar593.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar594 = ( 0.5 * mix( mix( fract( ( ( nodeVar590.x + nodeVar590.y ) * nodeVar590.z ) ), fract( ( ( nodeVar591.x + nodeVar591.y ) * nodeVar591.z ) ), nodeVar589.x ), mix( fract( ( ( nodeVar592.x + nodeVar592.y ) * nodeVar592.z ) ), fract( ( ( nodeVar593.x + nodeVar593.y ) * nodeVar593.z ) ), nodeVar589.x ), nodeVar589.y ) );
			nodeVar587 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar587 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar595 = floor( nodeVar587 );
			nodeVar596 = fract( nodeVar587 );
			nodeVar596 = ( ( nodeVar596 * nodeVar596 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar596 ) ) );
			nodeVar597 = fract( ( vec3<f32>( nodeVar595, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar597 = ( nodeVar597 + vec3<f32>( dot( nodeVar597, ( nodeVar597.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar598 = fract( ( vec3<f32>( ( nodeVar595 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar598 = ( nodeVar598 + vec3<f32>( dot( nodeVar598, ( nodeVar598.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar599 = fract( ( vec3<f32>( ( nodeVar595 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar599 = ( nodeVar599 + vec3<f32>( dot( nodeVar599, ( nodeVar599.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar600 = fract( ( vec3<f32>( ( nodeVar595 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar600 = ( nodeVar600 + vec3<f32>( dot( nodeVar600, ( nodeVar600.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar594 = ( nodeVar594 + ( 0.25 * mix( mix( fract( ( ( nodeVar597.x + nodeVar597.y ) * nodeVar597.z ) ), fract( ( ( nodeVar598.x + nodeVar598.y ) * nodeVar598.z ) ), nodeVar596.x ), mix( fract( ( ( nodeVar599.x + nodeVar599.y ) * nodeVar599.z ) ), fract( ( ( nodeVar600.x + nodeVar600.y ) * nodeVar600.z ) ), nodeVar596.x ), nodeVar596.y ) ) );
			nodeVar587 = ( ( nodeVar587 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar601 = floor( nodeVar587 );
			nodeVar602 = fract( nodeVar587 );
			nodeVar602 = ( ( nodeVar602 * nodeVar602 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar602 ) ) );
			nodeVar603 = fract( ( vec3<f32>( nodeVar601, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar603 = ( nodeVar603 + vec3<f32>( dot( nodeVar603, ( nodeVar603.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar604 = fract( ( vec3<f32>( ( nodeVar601 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar604 = ( nodeVar604 + vec3<f32>( dot( nodeVar604, ( nodeVar604.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar605 = fract( ( vec3<f32>( ( nodeVar601 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar605 = ( nodeVar605 + vec3<f32>( dot( nodeVar605, ( nodeVar605.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar606 = fract( ( vec3<f32>( ( nodeVar601 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar606 = ( nodeVar606 + vec3<f32>( dot( nodeVar606, ( nodeVar606.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar594 = ( nodeVar594 + ( 0.125 * mix( mix( fract( ( ( nodeVar603.x + nodeVar603.y ) * nodeVar603.z ) ), fract( ( ( nodeVar604.x + nodeVar604.y ) * nodeVar604.z ) ), nodeVar602.x ), mix( fract( ( ( nodeVar605.x + nodeVar605.y ) * nodeVar605.z ) ), fract( ( ( nodeVar606.x + nodeVar606.y ) * nodeVar606.z ) ), nodeVar602.x ), nodeVar602.y ) ) );
			nodeVar607 = ( ( nodeVar587 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar608 = floor( nodeVar607 );
			nodeVar609 = fract( nodeVar607 );
			nodeVar609 = ( ( nodeVar609 * nodeVar609 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar609 ) ) );
			nodeVar610 = fract( ( vec3<f32>( nodeVar608, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar610 = ( nodeVar610 + vec3<f32>( dot( nodeVar610, ( nodeVar610.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar611 = fract( ( vec3<f32>( ( nodeVar608 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar611 = ( nodeVar611 + vec3<f32>( dot( nodeVar611, ( nodeVar611.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar612 = fract( ( vec3<f32>( ( nodeVar608 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar612 = ( nodeVar612 + vec3<f32>( dot( nodeVar612, ( nodeVar612.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar613 = fract( ( vec3<f32>( ( nodeVar608 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar613 = ( nodeVar613 + vec3<f32>( dot( nodeVar613, ( nodeVar613.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar614 = ( nodeVar594 + ( 0.0625 * mix( mix( fract( ( ( nodeVar610.x + nodeVar610.y ) * nodeVar610.z ) ), fract( ( ( nodeVar611.x + nodeVar611.y ) * nodeVar611.z ) ), nodeVar609.x ), mix( fract( ( ( nodeVar612.x + nodeVar612.y ) * nodeVar612.z ) ), fract( ( ( nodeVar613.x + nodeVar613.y ) * nodeVar613.z ) ), nodeVar609.x ), nodeVar609.y ) ) );
			nodeVar615 = ( nodeVar586.xz * vec2<f32>( 0.018 ) );
			nodeVar616 = floor( nodeVar615 );
			nodeVar617 = fract( nodeVar615 );
			nodeVar617 = ( ( nodeVar617 * nodeVar617 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar617 ) ) );
			nodeVar618 = fract( ( vec3<f32>( nodeVar616, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar618 = ( nodeVar618 + vec3<f32>( dot( nodeVar618, ( nodeVar618.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar619 = fract( ( vec3<f32>( ( nodeVar616 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar619 = ( nodeVar619 + vec3<f32>( dot( nodeVar619, ( nodeVar619.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar620 = fract( ( vec3<f32>( ( nodeVar616 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar620 = ( nodeVar620 + vec3<f32>( dot( nodeVar620, ( nodeVar620.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar621 = fract( ( vec3<f32>( ( nodeVar616 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar621 = ( nodeVar621 + vec3<f32>( dot( nodeVar621, ( nodeVar621.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar622 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar618.x + nodeVar618.y ) * nodeVar618.z ) ), fract( ( ( nodeVar619.x + nodeVar619.y ) * nodeVar619.z ) ), nodeVar617.x ), mix( fract( ( ( nodeVar620.x + nodeVar620.y ) * nodeVar620.z ) ), fract( ( ( nodeVar621.x + nodeVar621.y ) * nodeVar621.z ) ), nodeVar617.x ), nodeVar617.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar623 = ( smoothstep( 13.0, 155.0, ( - nodeVar586.xz.x ) ) * ( ( 28.0 + ( nodeVar614 * 135.0 ) ) + ( nodeVar622 * 20.0 ) ) );
			nodeVar624 = ( smoothstep( 280.0, 670.0, ( - nodeVar586.xz.y ) ) * ( ( 46.0 + ( nodeVar614 * 155.0 ) ) + ( nodeVar622 * 22.0 ) ) );
			nodeVar625 = ( smoothstep( 190.0, 430.0, nodeVar586.xz.x ) * ( 30.0 + ( nodeVar614 * 95.0 ) ) );
			nodeVar626 = max( max( nodeVar623, nodeVar624 ), nodeVar625 );
			nodeVar627 = ( exp( ( - dot( ( ( nodeVar586.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar586.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar614 * 10.0 ) ) );
			nodeVar626 = max( nodeVar626, nodeVar627 );

			if ( ( nodeVar626 < 1.5 ) ) {


				if ( ( nodeVar586.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar586.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar586.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar586.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar628 = -1.2;

				} else {

					nodeVar628 = ( 0.1 + ( nodeVar614 * 0.2 ) );

				}

				nodeVar626 = nodeVar628;
				

			}


			if ( ( ( nodeVar586.xz.y > -175.0 ) && ( abs( ( nodeVar586.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar586.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar586.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar626 = 0.0;
				

			}

			nodeVar629 = nodeVar626;

			if ( ( nodeVar629 > 1.0 ) ) {

				nodeVar630 = nodeVar629;

			} else {

				nodeVar630 = -3.5;

			}

			nodeVar631 = vec2<f32>( ( ( nodeVar586.y - nodeVar630 ) * 0.58 ), 1.0 );
			nodeVar632 = floor( ( ( nodeVar586.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
			nodeVar633 = fract( ( vec3<f32>( ( nodeVar632 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar633 = ( nodeVar633 + vec3<f32>( dot( nodeVar633, ( nodeVar633.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar634 = fract( ( ( nodeVar633.x + nodeVar633.y ) * nodeVar633.z ) );
			nodeVar635 = fract( ( vec3<f32>( ( nodeVar632 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar635 = ( nodeVar635 + vec3<f32>( dot( nodeVar635, ( nodeVar635.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar636 = fract( ( vec3<f32>( ( nodeVar632 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar636 = ( nodeVar636 + vec3<f32>( dot( nodeVar636, ( nodeVar636.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar637 = ( ( ( ( ( nodeVar632 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar635.x + nodeVar635.y ) * nodeVar635.z ) ), fract( ( ( nodeVar636.x + nodeVar636.y ) * nodeVar636.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
			nodeVar638 = ( ( nodeVar637 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar639 = floor( nodeVar638 );
			nodeVar640 = fract( nodeVar638 );
			nodeVar640 = ( ( nodeVar640 * nodeVar640 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar640 ) ) );
			nodeVar641 = fract( ( vec3<f32>( nodeVar639, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar641 = ( nodeVar641 + vec3<f32>( dot( nodeVar641, ( nodeVar641.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar642 = fract( ( vec3<f32>( ( nodeVar639 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar642 = ( nodeVar642 + vec3<f32>( dot( nodeVar642, ( nodeVar642.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar643 = fract( ( vec3<f32>( ( nodeVar639 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar643 = ( nodeVar643 + vec3<f32>( dot( nodeVar643, ( nodeVar643.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar644 = fract( ( vec3<f32>( ( nodeVar639 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar644 = ( nodeVar644 + vec3<f32>( dot( nodeVar644, ( nodeVar644.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar645 = ( 0.5 * mix( mix( fract( ( ( nodeVar641.x + nodeVar641.y ) * nodeVar641.z ) ), fract( ( ( nodeVar642.x + nodeVar642.y ) * nodeVar642.z ) ), nodeVar640.x ), mix( fract( ( ( nodeVar643.x + nodeVar643.y ) * nodeVar643.z ) ), fract( ( ( nodeVar644.x + nodeVar644.y ) * nodeVar644.z ) ), nodeVar640.x ), nodeVar640.y ) );
			nodeVar638 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar638 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar646 = floor( nodeVar638 );
			nodeVar647 = fract( nodeVar638 );
			nodeVar647 = ( ( nodeVar647 * nodeVar647 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar647 ) ) );
			nodeVar648 = fract( ( vec3<f32>( nodeVar646, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar648 = ( nodeVar648 + vec3<f32>( dot( nodeVar648, ( nodeVar648.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar649 = fract( ( vec3<f32>( ( nodeVar646 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar649 = ( nodeVar649 + vec3<f32>( dot( nodeVar649, ( nodeVar649.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar650 = fract( ( vec3<f32>( ( nodeVar646 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar650 = ( nodeVar650 + vec3<f32>( dot( nodeVar650, ( nodeVar650.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar651 = fract( ( vec3<f32>( ( nodeVar646 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar651 = ( nodeVar651 + vec3<f32>( dot( nodeVar651, ( nodeVar651.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar645 = ( nodeVar645 + ( 0.25 * mix( mix( fract( ( ( nodeVar648.x + nodeVar648.y ) * nodeVar648.z ) ), fract( ( ( nodeVar649.x + nodeVar649.y ) * nodeVar649.z ) ), nodeVar647.x ), mix( fract( ( ( nodeVar650.x + nodeVar650.y ) * nodeVar650.z ) ), fract( ( ( nodeVar651.x + nodeVar651.y ) * nodeVar651.z ) ), nodeVar647.x ), nodeVar647.y ) ) );
			nodeVar638 = ( ( nodeVar638 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar652 = floor( nodeVar638 );
			nodeVar653 = fract( nodeVar638 );
			nodeVar653 = ( ( nodeVar653 * nodeVar653 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar653 ) ) );
			nodeVar654 = fract( ( vec3<f32>( nodeVar652, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar654 = ( nodeVar654 + vec3<f32>( dot( nodeVar654, ( nodeVar654.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar655 = fract( ( vec3<f32>( ( nodeVar652 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar655 = ( nodeVar655 + vec3<f32>( dot( nodeVar655, ( nodeVar655.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar656 = fract( ( vec3<f32>( ( nodeVar652 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar656 = ( nodeVar656 + vec3<f32>( dot( nodeVar656, ( nodeVar656.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar657 = fract( ( vec3<f32>( ( nodeVar652 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar657 = ( nodeVar657 + vec3<f32>( dot( nodeVar657, ( nodeVar657.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar645 = ( nodeVar645 + ( 0.125 * mix( mix( fract( ( ( nodeVar654.x + nodeVar654.y ) * nodeVar654.z ) ), fract( ( ( nodeVar655.x + nodeVar655.y ) * nodeVar655.z ) ), nodeVar653.x ), mix( fract( ( ( nodeVar656.x + nodeVar656.y ) * nodeVar656.z ) ), fract( ( ( nodeVar657.x + nodeVar657.y ) * nodeVar657.z ) ), nodeVar653.x ), nodeVar653.y ) ) );
			nodeVar658 = ( ( nodeVar638 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar659 = floor( nodeVar658 );
			nodeVar660 = fract( nodeVar658 );
			nodeVar660 = ( ( nodeVar660 * nodeVar660 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar660 ) ) );
			nodeVar661 = fract( ( vec3<f32>( nodeVar659, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar661 = ( nodeVar661 + vec3<f32>( dot( nodeVar661, ( nodeVar661.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar662 = fract( ( vec3<f32>( ( nodeVar659 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar662 = ( nodeVar662 + vec3<f32>( dot( nodeVar662, ( nodeVar662.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar663 = fract( ( vec3<f32>( ( nodeVar659 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar663 = ( nodeVar663 + vec3<f32>( dot( nodeVar663, ( nodeVar663.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar664 = fract( ( vec3<f32>( ( nodeVar659 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar664 = ( nodeVar664 + vec3<f32>( dot( nodeVar664, ( nodeVar664.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar665 = ( nodeVar645 + ( 0.0625 * mix( mix( fract( ( ( nodeVar661.x + nodeVar661.y ) * nodeVar661.z ) ), fract( ( ( nodeVar662.x + nodeVar662.y ) * nodeVar662.z ) ), nodeVar660.x ), mix( fract( ( ( nodeVar663.x + nodeVar663.y ) * nodeVar663.z ) ), fract( ( ( nodeVar664.x + nodeVar664.y ) * nodeVar664.z ) ), nodeVar660.x ), nodeVar660.y ) ) );
			nodeVar666 = ( nodeVar637 * vec2<f32>( 0.018 ) );
			nodeVar667 = floor( nodeVar666 );
			nodeVar668 = fract( nodeVar666 );
			nodeVar668 = ( ( nodeVar668 * nodeVar668 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar668 ) ) );
			nodeVar669 = fract( ( vec3<f32>( nodeVar667, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar669 = ( nodeVar669 + vec3<f32>( dot( nodeVar669, ( nodeVar669.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar670 = fract( ( vec3<f32>( ( nodeVar667 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar670 = ( nodeVar670 + vec3<f32>( dot( nodeVar670, ( nodeVar670.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar671 = fract( ( vec3<f32>( ( nodeVar667 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar671 = ( nodeVar671 + vec3<f32>( dot( nodeVar671, ( nodeVar671.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar672 = fract( ( vec3<f32>( ( nodeVar667 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar672 = ( nodeVar672 + vec3<f32>( dot( nodeVar672, ( nodeVar672.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar673 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar669.x + nodeVar669.y ) * nodeVar669.z ) ), fract( ( ( nodeVar670.x + nodeVar670.y ) * nodeVar670.z ) ), nodeVar668.x ), mix( fract( ( ( nodeVar671.x + nodeVar671.y ) * nodeVar671.z ) ), fract( ( ( nodeVar672.x + nodeVar672.y ) * nodeVar672.z ) ), nodeVar668.x ), nodeVar668.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar674 = ( smoothstep( 13.0, 155.0, ( - nodeVar637.x ) ) * ( ( 28.0 + ( nodeVar665 * 135.0 ) ) + ( nodeVar673 * 20.0 ) ) );
			nodeVar675 = ( smoothstep( 280.0, 670.0, ( - nodeVar637.y ) ) * ( ( 46.0 + ( nodeVar665 * 155.0 ) ) + ( nodeVar673 * 22.0 ) ) );
			nodeVar676 = ( smoothstep( 190.0, 430.0, nodeVar637.x ) * ( 30.0 + ( nodeVar665 * 95.0 ) ) );
			nodeVar677 = max( max( nodeVar674, nodeVar675 ), nodeVar676 );
			nodeVar678 = ( exp( ( - dot( ( ( nodeVar637 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar637 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar665 * 10.0 ) ) );
			nodeVar677 = max( nodeVar677, nodeVar678 );

			if ( ( nodeVar677 < 1.5 ) ) {


				if ( ( nodeVar637.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar637.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar637.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar637.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar679 = -1.2;

				} else {

					nodeVar679 = ( 0.1 + ( nodeVar665 * 0.2 ) );

				}

				nodeVar677 = nodeVar679;
				

			}


			if ( ( ( nodeVar637.y > -175.0 ) && ( abs( ( nodeVar637.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar637.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar637.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar677 = 0.0;
				

			}

			nodeVar680 = nodeVar677;
			nodeVar681 = ( nodeVar637.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar637.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar637.y ) ) ) ) );
			nodeVar682 = ( ( ( ( ( ( nodeVar681 < -9.0 ) || ( nodeVar637.y < -175.0 ) ) && ( nodeVar680 > -0.2 ) ) && ( nodeVar680 < 115.0 ) ) && ( nodeVar634 > 0.15 ) ) && ( ( nodeVar637.y < -12.0 ) || ( nodeVar637.x < -45.0 ) ) );

			if ( nodeVar682 ) {

				nodeVar683 = ( nodeVar586 - vec3<f32>( nodeVar637.x, nodeVar680, nodeVar637.y ) );
				nodeVar684 = ( 6.0 + ( nodeVar634 * 13.0 ) );
				nodeVar685 = clamp( ( nodeVar683.y / nodeVar684 ), 0.0, 1.0 );
				nodeVar686 = atan2( nodeVar683.z, nodeVar683.x );
				nodeVar687 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar683.y * 3.5 ) + ( nodeVar634 * 13.0 ) ) ) ) );
				nodeVar688 = ( ( ( 1.0 - nodeVar685 ) * ( 2.0 + ( nodeVar634 * 1.45 ) ) ) * nodeVar687 );
				nodeVar688 = ( nodeVar688 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar686 * 9.0 ) + ( nodeVar683.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar686 * 19.0 ) - ( nodeVar683.y * 6.0 ) ) ) ) ) );
				nodeVar689 = ( ( nodeVar683.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar683.y * 2.0 ) ) );
				nodeVar690 = floor( nodeVar689 );
				nodeVar691 = fract( nodeVar689 );
				nodeVar691 = ( ( nodeVar691 * nodeVar691 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar691 ) ) );
				nodeVar692 = fract( ( vec3<f32>( nodeVar690, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar692 = ( nodeVar692 + vec3<f32>( dot( nodeVar692, ( nodeVar692.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar693 = fract( ( vec3<f32>( ( nodeVar690 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar693 = ( nodeVar693 + vec3<f32>( dot( nodeVar693, ( nodeVar693.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar694 = fract( ( vec3<f32>( ( nodeVar690 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar694 = ( nodeVar694 + vec3<f32>( dot( nodeVar694, ( nodeVar694.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar695 = fract( ( vec3<f32>( ( nodeVar690 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar695 = ( nodeVar695 + vec3<f32>( dot( nodeVar695, ( nodeVar695.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar696 = ( ( ( mix( mix( fract( ( ( nodeVar692.x + nodeVar692.y ) * nodeVar692.z ) ), fract( ( ( nodeVar693.x + nodeVar693.y ) * nodeVar693.z ) ), nodeVar691.x ), mix( fract( ( ( nodeVar694.x + nodeVar694.y ) * nodeVar694.z ) ), fract( ( ( nodeVar695.x + nodeVar695.y ) * nodeVar695.z ) ), nodeVar691.x ), nodeVar691.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar685 ) );
				nodeVar697 = ( max( ( ( length( nodeVar683.xz ) - nodeVar688 ) + nodeVar696 ), max( ( 0.8 - nodeVar683.y ), ( nodeVar683.y - nodeVar684 ) ) ) * 0.67 );
				nodeVar699 = vec2<f32>( nodeVar697, 2.0 );

				if ( ( nodeVar631.x < nodeVar699.x ) ) {

					nodeVar698 = nodeVar631;

				} else {

					nodeVar698 = nodeVar699;

				}

				nodeVar631 = nodeVar698;
				nodeVar701 = vec2<f32>( max( ( length( nodeVar683.xz ) - ( 0.13 * ( 1.0 - ( nodeVar685 * 0.65 ) ) ) ), max( ( - nodeVar683.y ), ( nodeVar683.y - nodeVar684 ) ) ), 3.0 );

				if ( ( nodeVar631.x < nodeVar701.x ) ) {

					nodeVar700 = nodeVar631;

				} else {

					nodeVar700 = nodeVar701;

				}

				nodeVar631 = nodeVar700;
				

			}

			nodeVar702 = clamp( floor( ( ( ( ( - nodeVar586.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
			nodeVar703 = ( -10.0 - ( nodeVar702 * 38.0 ) );
			nodeVar704 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar703 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar703 ) ) ) ) - 6.35 );
			nodeVar705 = ( nodeVar586 - vec3<f32>( nodeVar704, 0.0, nodeVar703 ) );
			nodeVar706 = ( nodeVar705 - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar707 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar708 = ( length( ( nodeVar706 - ( nodeVar707 * vec3<f32>( clamp( ( dot( nodeVar706, nodeVar707 ) / dot( nodeVar707, nodeVar707 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
			nodeVar709 = ( nodeVar705 - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar710 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar708 = min( nodeVar708, ( length( ( nodeVar709 - ( nodeVar710 * vec3<f32>( clamp( ( dot( nodeVar709, nodeVar710 ) / dot( nodeVar710, nodeVar710 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
			nodeVar711 = ( nodeVar705 - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar712 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar708 = min( nodeVar708, ( length( ( nodeVar711 - ( nodeVar712 * vec3<f32>( clamp( ( dot( nodeVar711, nodeVar712 ) / dot( nodeVar712, nodeVar712 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
			nodeVar713 = ( abs( ( nodeVar705 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
			nodeVar708 = min( nodeVar708, ( length( max( nodeVar713, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar713.x, max( nodeVar713.y, nodeVar713.z ) ), 0.0 ) ) );
			nodeVar715 = vec2<f32>( nodeVar708, 4.0 );

			if ( ( nodeVar631.x < nodeVar715.x ) ) {

				nodeVar714 = nodeVar631;

			} else {

				nodeVar714 = nodeVar715;

			}

			nodeVar631 = nodeVar714;
			nodeVar717 = ( abs( ( nodeVar705 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
			nodeVar718 = vec2<f32>( ( length( max( nodeVar717, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar717.x, max( nodeVar717.y, nodeVar717.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar631.x < nodeVar718.x ) ) {

				nodeVar716 = nodeVar631;

			} else {

				nodeVar716 = nodeVar718;

			}

			nodeVar631 = nodeVar716;

			if ( ( ( nodeVar586.z < 28.0 ) && ( nodeVar586.z > -176.0 ) ) ) {

				nodeVar719 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar586.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar586.z ) ) ) ) + 6.3 );
				nodeVar720 = ( abs( vec3<f32>( ( nodeVar586.x - nodeVar719 ), ( nodeVar586.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
				nodeVar721 = ( length( max( nodeVar720, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar720.x, max( nodeVar720.y, nodeVar720.z ) ), 0.0 ) );
				nodeVar722 = ( floor( ( ( nodeVar586.z / 5.0 ) + 0.5 ) ) * 5.0 );
				nodeVar723 = ( abs( ( nodeVar586 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar722 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar722 ) ) ) ) + 6.3 ), 0.45, nodeVar722 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
				nodeVar721 = min( nodeVar721, ( length( max( nodeVar723, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar723.x, max( nodeVar723.y, nodeVar723.z ) ), 0.0 ) ) );
				nodeVar725 = vec2<f32>( nodeVar721, 4.0 );

				if ( ( nodeVar631.x < nodeVar725.x ) ) {

					nodeVar724 = nodeVar631;

				} else {

					nodeVar724 = nodeVar725;

				}

				nodeVar631 = nodeVar724;
				

			}

			nodeVar726 = ( nodeVar586 - vec3<f32>( -17.0, 1.85, -73.0 ) );
			nodeVar727 = ( abs( nodeVar726 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
			nodeVar728 = ( length( max( nodeVar727, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar727.x, max( nodeVar727.y, nodeVar727.z ) ), 0.0 ) );
			nodeVar730 = vec2<f32>( nodeVar728, 9.0 );

			if ( ( nodeVar631.x < nodeVar730.x ) ) {

				nodeVar729 = nodeVar631;

			} else {

				nodeVar729 = nodeVar730;

			}

			nodeVar631 = nodeVar729;
			nodeVar732 = ( abs( ( nodeVar586 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
			nodeVar733 = vec2<f32>( ( length( max( nodeVar732, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar732.x, max( nodeVar732.y, nodeVar732.z ) ), 0.0 ) ), 4.0 );

			if ( ( nodeVar631.x < nodeVar733.x ) ) {

				nodeVar731 = nodeVar631;

			} else {

				nodeVar731 = nodeVar733;

			}

			nodeVar631 = nodeVar731;
			nodeVar735 = ( abs( ( nodeVar586 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
			nodeVar736 = vec2<f32>( ( length( max( nodeVar735, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar735.x, max( nodeVar735.y, nodeVar735.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar631.x < nodeVar736.x ) ) {

				nodeVar734 = nodeVar631;

			} else {

				nodeVar734 = nodeVar736;

			}

			nodeVar631 = nodeVar734;
			nodeVar738 = ( nodeVar586 - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar739 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar740 = vec2<f32>( ( length( ( nodeVar738 - ( nodeVar739 * vec3<f32>( clamp( ( dot( nodeVar738, nodeVar739 ) / dot( nodeVar739, nodeVar739 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

			if ( ( nodeVar631.x < nodeVar740.x ) ) {

				nodeVar737 = nodeVar631;

			} else {

				nodeVar737 = nodeVar740;

			}

			nodeVar631 = nodeVar737;
			nodeVar741 = ( nodeVar214 + ( vec3<f32>( nodeVar585, 0.0 ).yyx * vec3<f32>( nodeVar584 ) ) );
			nodeVar742 = ( ( nodeVar741.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar743 = floor( nodeVar742 );
			nodeVar744 = fract( nodeVar742 );
			nodeVar744 = ( ( nodeVar744 * nodeVar744 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar744 ) ) );
			nodeVar745 = fract( ( vec3<f32>( nodeVar743, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar745 = ( nodeVar745 + vec3<f32>( dot( nodeVar745, ( nodeVar745.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar746 = fract( ( vec3<f32>( ( nodeVar743 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar746 = ( nodeVar746 + vec3<f32>( dot( nodeVar746, ( nodeVar746.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar747 = fract( ( vec3<f32>( ( nodeVar743 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar747 = ( nodeVar747 + vec3<f32>( dot( nodeVar747, ( nodeVar747.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar748 = fract( ( vec3<f32>( ( nodeVar743 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar748 = ( nodeVar748 + vec3<f32>( dot( nodeVar748, ( nodeVar748.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar749 = ( 0.5 * mix( mix( fract( ( ( nodeVar745.x + nodeVar745.y ) * nodeVar745.z ) ), fract( ( ( nodeVar746.x + nodeVar746.y ) * nodeVar746.z ) ), nodeVar744.x ), mix( fract( ( ( nodeVar747.x + nodeVar747.y ) * nodeVar747.z ) ), fract( ( ( nodeVar748.x + nodeVar748.y ) * nodeVar748.z ) ), nodeVar744.x ), nodeVar744.y ) );
			nodeVar742 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar742 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar750 = floor( nodeVar742 );
			nodeVar751 = fract( nodeVar742 );
			nodeVar751 = ( ( nodeVar751 * nodeVar751 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar751 ) ) );
			nodeVar752 = fract( ( vec3<f32>( nodeVar750, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar752 = ( nodeVar752 + vec3<f32>( dot( nodeVar752, ( nodeVar752.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar753 = fract( ( vec3<f32>( ( nodeVar750 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar753 = ( nodeVar753 + vec3<f32>( dot( nodeVar753, ( nodeVar753.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar754 = fract( ( vec3<f32>( ( nodeVar750 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar754 = ( nodeVar754 + vec3<f32>( dot( nodeVar754, ( nodeVar754.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar755 = fract( ( vec3<f32>( ( nodeVar750 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar755 = ( nodeVar755 + vec3<f32>( dot( nodeVar755, ( nodeVar755.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar749 = ( nodeVar749 + ( 0.25 * mix( mix( fract( ( ( nodeVar752.x + nodeVar752.y ) * nodeVar752.z ) ), fract( ( ( nodeVar753.x + nodeVar753.y ) * nodeVar753.z ) ), nodeVar751.x ), mix( fract( ( ( nodeVar754.x + nodeVar754.y ) * nodeVar754.z ) ), fract( ( ( nodeVar755.x + nodeVar755.y ) * nodeVar755.z ) ), nodeVar751.x ), nodeVar751.y ) ) );
			nodeVar742 = ( ( nodeVar742 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar756 = floor( nodeVar742 );
			nodeVar757 = fract( nodeVar742 );
			nodeVar757 = ( ( nodeVar757 * nodeVar757 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar757 ) ) );
			nodeVar758 = fract( ( vec3<f32>( nodeVar756, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar758 = ( nodeVar758 + vec3<f32>( dot( nodeVar758, ( nodeVar758.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar759 = fract( ( vec3<f32>( ( nodeVar756 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar759 = ( nodeVar759 + vec3<f32>( dot( nodeVar759, ( nodeVar759.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar760 = fract( ( vec3<f32>( ( nodeVar756 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar760 = ( nodeVar760 + vec3<f32>( dot( nodeVar760, ( nodeVar760.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar761 = fract( ( vec3<f32>( ( nodeVar756 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar761 = ( nodeVar761 + vec3<f32>( dot( nodeVar761, ( nodeVar761.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar749 = ( nodeVar749 + ( 0.125 * mix( mix( fract( ( ( nodeVar758.x + nodeVar758.y ) * nodeVar758.z ) ), fract( ( ( nodeVar759.x + nodeVar759.y ) * nodeVar759.z ) ), nodeVar757.x ), mix( fract( ( ( nodeVar760.x + nodeVar760.y ) * nodeVar760.z ) ), fract( ( ( nodeVar761.x + nodeVar761.y ) * nodeVar761.z ) ), nodeVar757.x ), nodeVar757.y ) ) );
			nodeVar762 = ( ( nodeVar742 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar763 = floor( nodeVar762 );
			nodeVar764 = fract( nodeVar762 );
			nodeVar764 = ( ( nodeVar764 * nodeVar764 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar764 ) ) );
			nodeVar765 = fract( ( vec3<f32>( nodeVar763, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar765 = ( nodeVar765 + vec3<f32>( dot( nodeVar765, ( nodeVar765.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar766 = fract( ( vec3<f32>( ( nodeVar763 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar766 = ( nodeVar766 + vec3<f32>( dot( nodeVar766, ( nodeVar766.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar767 = fract( ( vec3<f32>( ( nodeVar763 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar767 = ( nodeVar767 + vec3<f32>( dot( nodeVar767, ( nodeVar767.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar768 = fract( ( vec3<f32>( ( nodeVar763 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar768 = ( nodeVar768 + vec3<f32>( dot( nodeVar768, ( nodeVar768.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar769 = ( nodeVar749 + ( 0.0625 * mix( mix( fract( ( ( nodeVar765.x + nodeVar765.y ) * nodeVar765.z ) ), fract( ( ( nodeVar766.x + nodeVar766.y ) * nodeVar766.z ) ), nodeVar764.x ), mix( fract( ( ( nodeVar767.x + nodeVar767.y ) * nodeVar767.z ) ), fract( ( ( nodeVar768.x + nodeVar768.y ) * nodeVar768.z ) ), nodeVar764.x ), nodeVar764.y ) ) );
			nodeVar770 = ( nodeVar741.xz * vec2<f32>( 0.018 ) );
			nodeVar771 = floor( nodeVar770 );
			nodeVar772 = fract( nodeVar770 );
			nodeVar772 = ( ( nodeVar772 * nodeVar772 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar772 ) ) );
			nodeVar773 = fract( ( vec3<f32>( nodeVar771, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar773 = ( nodeVar773 + vec3<f32>( dot( nodeVar773, ( nodeVar773.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar774 = fract( ( vec3<f32>( ( nodeVar771 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar774 = ( nodeVar774 + vec3<f32>( dot( nodeVar774, ( nodeVar774.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar775 = fract( ( vec3<f32>( ( nodeVar771 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar775 = ( nodeVar775 + vec3<f32>( dot( nodeVar775, ( nodeVar775.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar776 = fract( ( vec3<f32>( ( nodeVar771 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar776 = ( nodeVar776 + vec3<f32>( dot( nodeVar776, ( nodeVar776.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar777 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar773.x + nodeVar773.y ) * nodeVar773.z ) ), fract( ( ( nodeVar774.x + nodeVar774.y ) * nodeVar774.z ) ), nodeVar772.x ), mix( fract( ( ( nodeVar775.x + nodeVar775.y ) * nodeVar775.z ) ), fract( ( ( nodeVar776.x + nodeVar776.y ) * nodeVar776.z ) ), nodeVar772.x ), nodeVar772.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar778 = ( smoothstep( 13.0, 155.0, ( - nodeVar741.xz.x ) ) * ( ( 28.0 + ( nodeVar769 * 135.0 ) ) + ( nodeVar777 * 20.0 ) ) );
			nodeVar779 = ( smoothstep( 280.0, 670.0, ( - nodeVar741.xz.y ) ) * ( ( 46.0 + ( nodeVar769 * 155.0 ) ) + ( nodeVar777 * 22.0 ) ) );
			nodeVar780 = ( smoothstep( 190.0, 430.0, nodeVar741.xz.x ) * ( 30.0 + ( nodeVar769 * 95.0 ) ) );
			nodeVar781 = max( max( nodeVar778, nodeVar779 ), nodeVar780 );
			nodeVar782 = ( exp( ( - dot( ( ( nodeVar741.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar741.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar769 * 10.0 ) ) );
			nodeVar781 = max( nodeVar781, nodeVar782 );

			if ( ( nodeVar781 < 1.5 ) ) {


				if ( ( nodeVar741.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar741.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar741.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar741.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar783 = -1.2;

				} else {

					nodeVar783 = ( 0.1 + ( nodeVar769 * 0.2 ) );

				}

				nodeVar781 = nodeVar783;
				

			}


			if ( ( ( nodeVar741.xz.y > -175.0 ) && ( abs( ( nodeVar741.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar741.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar741.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar781 = 0.0;
				

			}

			nodeVar784 = nodeVar781;

			if ( ( nodeVar784 > 1.0 ) ) {

				nodeVar785 = nodeVar784;

			} else {

				nodeVar785 = -3.5;

			}

			nodeVar786 = vec2<f32>( ( ( nodeVar741.y - nodeVar785 ) * 0.58 ), 1.0 );
			nodeVar787 = floor( ( ( nodeVar741.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
			nodeVar788 = fract( ( vec3<f32>( ( nodeVar787 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar788 = ( nodeVar788 + vec3<f32>( dot( nodeVar788, ( nodeVar788.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar789 = fract( ( ( nodeVar788.x + nodeVar788.y ) * nodeVar788.z ) );
			nodeVar790 = fract( ( vec3<f32>( ( nodeVar787 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar790 = ( nodeVar790 + vec3<f32>( dot( nodeVar790, ( nodeVar790.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar791 = fract( ( vec3<f32>( ( nodeVar787 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar791 = ( nodeVar791 + vec3<f32>( dot( nodeVar791, ( nodeVar791.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar792 = ( ( ( ( ( nodeVar787 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar790.x + nodeVar790.y ) * nodeVar790.z ) ), fract( ( ( nodeVar791.x + nodeVar791.y ) * nodeVar791.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
			nodeVar793 = ( ( nodeVar792 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar794 = floor( nodeVar793 );
			nodeVar795 = fract( nodeVar793 );
			nodeVar795 = ( ( nodeVar795 * nodeVar795 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar795 ) ) );
			nodeVar796 = fract( ( vec3<f32>( nodeVar794, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar796 = ( nodeVar796 + vec3<f32>( dot( nodeVar796, ( nodeVar796.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar797 = fract( ( vec3<f32>( ( nodeVar794 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar797 = ( nodeVar797 + vec3<f32>( dot( nodeVar797, ( nodeVar797.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar798 = fract( ( vec3<f32>( ( nodeVar794 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar798 = ( nodeVar798 + vec3<f32>( dot( nodeVar798, ( nodeVar798.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar799 = fract( ( vec3<f32>( ( nodeVar794 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar799 = ( nodeVar799 + vec3<f32>( dot( nodeVar799, ( nodeVar799.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar800 = ( 0.5 * mix( mix( fract( ( ( nodeVar796.x + nodeVar796.y ) * nodeVar796.z ) ), fract( ( ( nodeVar797.x + nodeVar797.y ) * nodeVar797.z ) ), nodeVar795.x ), mix( fract( ( ( nodeVar798.x + nodeVar798.y ) * nodeVar798.z ) ), fract( ( ( nodeVar799.x + nodeVar799.y ) * nodeVar799.z ) ), nodeVar795.x ), nodeVar795.y ) );
			nodeVar793 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar793 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar801 = floor( nodeVar793 );
			nodeVar802 = fract( nodeVar793 );
			nodeVar802 = ( ( nodeVar802 * nodeVar802 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar802 ) ) );
			nodeVar803 = fract( ( vec3<f32>( nodeVar801, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar803 = ( nodeVar803 + vec3<f32>( dot( nodeVar803, ( nodeVar803.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar804 = fract( ( vec3<f32>( ( nodeVar801 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar804 = ( nodeVar804 + vec3<f32>( dot( nodeVar804, ( nodeVar804.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar805 = fract( ( vec3<f32>( ( nodeVar801 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar805 = ( nodeVar805 + vec3<f32>( dot( nodeVar805, ( nodeVar805.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar806 = fract( ( vec3<f32>( ( nodeVar801 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar806 = ( nodeVar806 + vec3<f32>( dot( nodeVar806, ( nodeVar806.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar800 = ( nodeVar800 + ( 0.25 * mix( mix( fract( ( ( nodeVar803.x + nodeVar803.y ) * nodeVar803.z ) ), fract( ( ( nodeVar804.x + nodeVar804.y ) * nodeVar804.z ) ), nodeVar802.x ), mix( fract( ( ( nodeVar805.x + nodeVar805.y ) * nodeVar805.z ) ), fract( ( ( nodeVar806.x + nodeVar806.y ) * nodeVar806.z ) ), nodeVar802.x ), nodeVar802.y ) ) );
			nodeVar793 = ( ( nodeVar793 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar807 = floor( nodeVar793 );
			nodeVar808 = fract( nodeVar793 );
			nodeVar808 = ( ( nodeVar808 * nodeVar808 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar808 ) ) );
			nodeVar809 = fract( ( vec3<f32>( nodeVar807, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar809 = ( nodeVar809 + vec3<f32>( dot( nodeVar809, ( nodeVar809.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar810 = fract( ( vec3<f32>( ( nodeVar807 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar810 = ( nodeVar810 + vec3<f32>( dot( nodeVar810, ( nodeVar810.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar811 = fract( ( vec3<f32>( ( nodeVar807 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar811 = ( nodeVar811 + vec3<f32>( dot( nodeVar811, ( nodeVar811.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar812 = fract( ( vec3<f32>( ( nodeVar807 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar812 = ( nodeVar812 + vec3<f32>( dot( nodeVar812, ( nodeVar812.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar800 = ( nodeVar800 + ( 0.125 * mix( mix( fract( ( ( nodeVar809.x + nodeVar809.y ) * nodeVar809.z ) ), fract( ( ( nodeVar810.x + nodeVar810.y ) * nodeVar810.z ) ), nodeVar808.x ), mix( fract( ( ( nodeVar811.x + nodeVar811.y ) * nodeVar811.z ) ), fract( ( ( nodeVar812.x + nodeVar812.y ) * nodeVar812.z ) ), nodeVar808.x ), nodeVar808.y ) ) );
			nodeVar813 = ( ( nodeVar793 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar814 = floor( nodeVar813 );
			nodeVar815 = fract( nodeVar813 );
			nodeVar815 = ( ( nodeVar815 * nodeVar815 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar815 ) ) );
			nodeVar816 = fract( ( vec3<f32>( nodeVar814, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar816 = ( nodeVar816 + vec3<f32>( dot( nodeVar816, ( nodeVar816.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar817 = fract( ( vec3<f32>( ( nodeVar814 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar817 = ( nodeVar817 + vec3<f32>( dot( nodeVar817, ( nodeVar817.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar818 = fract( ( vec3<f32>( ( nodeVar814 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar818 = ( nodeVar818 + vec3<f32>( dot( nodeVar818, ( nodeVar818.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar819 = fract( ( vec3<f32>( ( nodeVar814 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar819 = ( nodeVar819 + vec3<f32>( dot( nodeVar819, ( nodeVar819.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar820 = ( nodeVar800 + ( 0.0625 * mix( mix( fract( ( ( nodeVar816.x + nodeVar816.y ) * nodeVar816.z ) ), fract( ( ( nodeVar817.x + nodeVar817.y ) * nodeVar817.z ) ), nodeVar815.x ), mix( fract( ( ( nodeVar818.x + nodeVar818.y ) * nodeVar818.z ) ), fract( ( ( nodeVar819.x + nodeVar819.y ) * nodeVar819.z ) ), nodeVar815.x ), nodeVar815.y ) ) );
			nodeVar821 = ( nodeVar792 * vec2<f32>( 0.018 ) );
			nodeVar822 = floor( nodeVar821 );
			nodeVar823 = fract( nodeVar821 );
			nodeVar823 = ( ( nodeVar823 * nodeVar823 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar823 ) ) );
			nodeVar824 = fract( ( vec3<f32>( nodeVar822, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar824 = ( nodeVar824 + vec3<f32>( dot( nodeVar824, ( nodeVar824.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar825 = fract( ( vec3<f32>( ( nodeVar822 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar825 = ( nodeVar825 + vec3<f32>( dot( nodeVar825, ( nodeVar825.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar826 = fract( ( vec3<f32>( ( nodeVar822 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar826 = ( nodeVar826 + vec3<f32>( dot( nodeVar826, ( nodeVar826.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar827 = fract( ( vec3<f32>( ( nodeVar822 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar827 = ( nodeVar827 + vec3<f32>( dot( nodeVar827, ( nodeVar827.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar828 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar824.x + nodeVar824.y ) * nodeVar824.z ) ), fract( ( ( nodeVar825.x + nodeVar825.y ) * nodeVar825.z ) ), nodeVar823.x ), mix( fract( ( ( nodeVar826.x + nodeVar826.y ) * nodeVar826.z ) ), fract( ( ( nodeVar827.x + nodeVar827.y ) * nodeVar827.z ) ), nodeVar823.x ), nodeVar823.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar829 = ( smoothstep( 13.0, 155.0, ( - nodeVar792.x ) ) * ( ( 28.0 + ( nodeVar820 * 135.0 ) ) + ( nodeVar828 * 20.0 ) ) );
			nodeVar830 = ( smoothstep( 280.0, 670.0, ( - nodeVar792.y ) ) * ( ( 46.0 + ( nodeVar820 * 155.0 ) ) + ( nodeVar828 * 22.0 ) ) );
			nodeVar831 = ( smoothstep( 190.0, 430.0, nodeVar792.x ) * ( 30.0 + ( nodeVar820 * 95.0 ) ) );
			nodeVar832 = max( max( nodeVar829, nodeVar830 ), nodeVar831 );
			nodeVar833 = ( exp( ( - dot( ( ( nodeVar792 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar792 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar820 * 10.0 ) ) );
			nodeVar832 = max( nodeVar832, nodeVar833 );

			if ( ( nodeVar832 < 1.5 ) ) {


				if ( ( nodeVar792.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar792.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar792.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar792.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar834 = -1.2;

				} else {

					nodeVar834 = ( 0.1 + ( nodeVar820 * 0.2 ) );

				}

				nodeVar832 = nodeVar834;
				

			}


			if ( ( ( nodeVar792.y > -175.0 ) && ( abs( ( nodeVar792.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar792.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar792.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar832 = 0.0;
				

			}

			nodeVar835 = nodeVar832;
			nodeVar836 = ( nodeVar792.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar792.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar792.y ) ) ) ) );
			nodeVar837 = ( ( ( ( ( ( nodeVar836 < -9.0 ) || ( nodeVar792.y < -175.0 ) ) && ( nodeVar835 > -0.2 ) ) && ( nodeVar835 < 115.0 ) ) && ( nodeVar789 > 0.15 ) ) && ( ( nodeVar792.y < -12.0 ) || ( nodeVar792.x < -45.0 ) ) );

			if ( nodeVar837 ) {

				nodeVar838 = ( nodeVar741 - vec3<f32>( nodeVar792.x, nodeVar835, nodeVar792.y ) );
				nodeVar839 = ( 6.0 + ( nodeVar789 * 13.0 ) );
				nodeVar840 = clamp( ( nodeVar838.y / nodeVar839 ), 0.0, 1.0 );
				nodeVar841 = atan2( nodeVar838.z, nodeVar838.x );
				nodeVar842 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar838.y * 3.5 ) + ( nodeVar789 * 13.0 ) ) ) ) );
				nodeVar843 = ( ( ( 1.0 - nodeVar840 ) * ( 2.0 + ( nodeVar789 * 1.45 ) ) ) * nodeVar842 );
				nodeVar843 = ( nodeVar843 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar841 * 9.0 ) + ( nodeVar838.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar841 * 19.0 ) - ( nodeVar838.y * 6.0 ) ) ) ) ) );
				nodeVar844 = ( ( nodeVar838.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar838.y * 2.0 ) ) );
				nodeVar845 = floor( nodeVar844 );
				nodeVar846 = fract( nodeVar844 );
				nodeVar846 = ( ( nodeVar846 * nodeVar846 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar846 ) ) );
				nodeVar847 = fract( ( vec3<f32>( nodeVar845, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar847 = ( nodeVar847 + vec3<f32>( dot( nodeVar847, ( nodeVar847.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar848 = fract( ( vec3<f32>( ( nodeVar845 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar848 = ( nodeVar848 + vec3<f32>( dot( nodeVar848, ( nodeVar848.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar849 = fract( ( vec3<f32>( ( nodeVar845 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar849 = ( nodeVar849 + vec3<f32>( dot( nodeVar849, ( nodeVar849.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar850 = fract( ( vec3<f32>( ( nodeVar845 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar850 = ( nodeVar850 + vec3<f32>( dot( nodeVar850, ( nodeVar850.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar851 = ( ( ( mix( mix( fract( ( ( nodeVar847.x + nodeVar847.y ) * nodeVar847.z ) ), fract( ( ( nodeVar848.x + nodeVar848.y ) * nodeVar848.z ) ), nodeVar846.x ), mix( fract( ( ( nodeVar849.x + nodeVar849.y ) * nodeVar849.z ) ), fract( ( ( nodeVar850.x + nodeVar850.y ) * nodeVar850.z ) ), nodeVar846.x ), nodeVar846.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar840 ) );
				nodeVar852 = ( max( ( ( length( nodeVar838.xz ) - nodeVar843 ) + nodeVar851 ), max( ( 0.8 - nodeVar838.y ), ( nodeVar838.y - nodeVar839 ) ) ) * 0.67 );
				nodeVar854 = vec2<f32>( nodeVar852, 2.0 );

				if ( ( nodeVar786.x < nodeVar854.x ) ) {

					nodeVar853 = nodeVar786;

				} else {

					nodeVar853 = nodeVar854;

				}

				nodeVar786 = nodeVar853;
				nodeVar856 = vec2<f32>( max( ( length( nodeVar838.xz ) - ( 0.13 * ( 1.0 - ( nodeVar840 * 0.65 ) ) ) ), max( ( - nodeVar838.y ), ( nodeVar838.y - nodeVar839 ) ) ), 3.0 );

				if ( ( nodeVar786.x < nodeVar856.x ) ) {

					nodeVar855 = nodeVar786;

				} else {

					nodeVar855 = nodeVar856;

				}

				nodeVar786 = nodeVar855;
				

			}

			nodeVar857 = clamp( floor( ( ( ( ( - nodeVar741.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
			nodeVar858 = ( -10.0 - ( nodeVar857 * 38.0 ) );
			nodeVar859 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar858 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar858 ) ) ) ) - 6.35 );
			nodeVar860 = ( nodeVar741 - vec3<f32>( nodeVar859, 0.0, nodeVar858 ) );
			nodeVar861 = ( nodeVar860 - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar862 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar863 = ( length( ( nodeVar861 - ( nodeVar862 * vec3<f32>( clamp( ( dot( nodeVar861, nodeVar862 ) / dot( nodeVar862, nodeVar862 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
			nodeVar864 = ( nodeVar860 - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar865 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar863 = min( nodeVar863, ( length( ( nodeVar864 - ( nodeVar865 * vec3<f32>( clamp( ( dot( nodeVar864, nodeVar865 ) / dot( nodeVar865, nodeVar865 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
			nodeVar866 = ( nodeVar860 - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar867 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar863 = min( nodeVar863, ( length( ( nodeVar866 - ( nodeVar867 * vec3<f32>( clamp( ( dot( nodeVar866, nodeVar867 ) / dot( nodeVar867, nodeVar867 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
			nodeVar868 = ( abs( ( nodeVar860 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
			nodeVar863 = min( nodeVar863, ( length( max( nodeVar868, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar868.x, max( nodeVar868.y, nodeVar868.z ) ), 0.0 ) ) );
			nodeVar870 = vec2<f32>( nodeVar863, 4.0 );

			if ( ( nodeVar786.x < nodeVar870.x ) ) {

				nodeVar869 = nodeVar786;

			} else {

				nodeVar869 = nodeVar870;

			}

			nodeVar786 = nodeVar869;
			nodeVar872 = ( abs( ( nodeVar860 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
			nodeVar873 = vec2<f32>( ( length( max( nodeVar872, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar872.x, max( nodeVar872.y, nodeVar872.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar786.x < nodeVar873.x ) ) {

				nodeVar871 = nodeVar786;

			} else {

				nodeVar871 = nodeVar873;

			}

			nodeVar786 = nodeVar871;

			if ( ( ( nodeVar741.z < 28.0 ) && ( nodeVar741.z > -176.0 ) ) ) {

				nodeVar874 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar741.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar741.z ) ) ) ) + 6.3 );
				nodeVar875 = ( abs( vec3<f32>( ( nodeVar741.x - nodeVar874 ), ( nodeVar741.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
				nodeVar876 = ( length( max( nodeVar875, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar875.x, max( nodeVar875.y, nodeVar875.z ) ), 0.0 ) );
				nodeVar877 = ( floor( ( ( nodeVar741.z / 5.0 ) + 0.5 ) ) * 5.0 );
				nodeVar878 = ( abs( ( nodeVar741 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar877 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar877 ) ) ) ) + 6.3 ), 0.45, nodeVar877 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
				nodeVar876 = min( nodeVar876, ( length( max( nodeVar878, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar878.x, max( nodeVar878.y, nodeVar878.z ) ), 0.0 ) ) );
				nodeVar880 = vec2<f32>( nodeVar876, 4.0 );

				if ( ( nodeVar786.x < nodeVar880.x ) ) {

					nodeVar879 = nodeVar786;

				} else {

					nodeVar879 = nodeVar880;

				}

				nodeVar786 = nodeVar879;
				

			}

			nodeVar881 = ( nodeVar741 - vec3<f32>( -17.0, 1.85, -73.0 ) );
			nodeVar882 = ( abs( nodeVar881 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
			nodeVar883 = ( length( max( nodeVar882, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar882.x, max( nodeVar882.y, nodeVar882.z ) ), 0.0 ) );
			nodeVar885 = vec2<f32>( nodeVar883, 9.0 );

			if ( ( nodeVar786.x < nodeVar885.x ) ) {

				nodeVar884 = nodeVar786;

			} else {

				nodeVar884 = nodeVar885;

			}

			nodeVar786 = nodeVar884;
			nodeVar887 = ( abs( ( nodeVar741 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
			nodeVar888 = vec2<f32>( ( length( max( nodeVar887, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar887.x, max( nodeVar887.y, nodeVar887.z ) ), 0.0 ) ), 4.0 );

			if ( ( nodeVar786.x < nodeVar888.x ) ) {

				nodeVar886 = nodeVar786;

			} else {

				nodeVar886 = nodeVar888;

			}

			nodeVar786 = nodeVar886;
			nodeVar890 = ( abs( ( nodeVar741 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
			nodeVar891 = vec2<f32>( ( length( max( nodeVar890, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar890.x, max( nodeVar890.y, nodeVar890.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar786.x < nodeVar891.x ) ) {

				nodeVar889 = nodeVar786;

			} else {

				nodeVar889 = nodeVar891;

			}

			nodeVar786 = nodeVar889;
			nodeVar893 = ( nodeVar741 - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar894 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar895 = vec2<f32>( ( length( ( nodeVar893 - ( nodeVar894 * vec3<f32>( clamp( ( dot( nodeVar893, nodeVar894 ) / dot( nodeVar894, nodeVar894 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

			if ( ( nodeVar786.x < nodeVar895.x ) ) {

				nodeVar892 = nodeVar786;

			} else {

				nodeVar892 = nodeVar895;

			}

			nodeVar786 = nodeVar892;
			nodeVar896 = ( nodeVar214 + ( vec3<f32>( nodeVar585, 0.0 ).yxy * vec3<f32>( nodeVar584 ) ) );
			nodeVar897 = ( ( nodeVar896.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar898 = floor( nodeVar897 );
			nodeVar899 = fract( nodeVar897 );
			nodeVar899 = ( ( nodeVar899 * nodeVar899 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar899 ) ) );
			nodeVar900 = fract( ( vec3<f32>( nodeVar898, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar900 = ( nodeVar900 + vec3<f32>( dot( nodeVar900, ( nodeVar900.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar901 = fract( ( vec3<f32>( ( nodeVar898 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar901 = ( nodeVar901 + vec3<f32>( dot( nodeVar901, ( nodeVar901.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar902 = fract( ( vec3<f32>( ( nodeVar898 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar902 = ( nodeVar902 + vec3<f32>( dot( nodeVar902, ( nodeVar902.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar903 = fract( ( vec3<f32>( ( nodeVar898 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar903 = ( nodeVar903 + vec3<f32>( dot( nodeVar903, ( nodeVar903.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar904 = ( 0.5 * mix( mix( fract( ( ( nodeVar900.x + nodeVar900.y ) * nodeVar900.z ) ), fract( ( ( nodeVar901.x + nodeVar901.y ) * nodeVar901.z ) ), nodeVar899.x ), mix( fract( ( ( nodeVar902.x + nodeVar902.y ) * nodeVar902.z ) ), fract( ( ( nodeVar903.x + nodeVar903.y ) * nodeVar903.z ) ), nodeVar899.x ), nodeVar899.y ) );
			nodeVar897 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar897 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar905 = floor( nodeVar897 );
			nodeVar906 = fract( nodeVar897 );
			nodeVar906 = ( ( nodeVar906 * nodeVar906 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar906 ) ) );
			nodeVar907 = fract( ( vec3<f32>( nodeVar905, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar907 = ( nodeVar907 + vec3<f32>( dot( nodeVar907, ( nodeVar907.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar908 = fract( ( vec3<f32>( ( nodeVar905 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar908 = ( nodeVar908 + vec3<f32>( dot( nodeVar908, ( nodeVar908.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar909 = fract( ( vec3<f32>( ( nodeVar905 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar909 = ( nodeVar909 + vec3<f32>( dot( nodeVar909, ( nodeVar909.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar910 = fract( ( vec3<f32>( ( nodeVar905 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar910 = ( nodeVar910 + vec3<f32>( dot( nodeVar910, ( nodeVar910.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar904 = ( nodeVar904 + ( 0.25 * mix( mix( fract( ( ( nodeVar907.x + nodeVar907.y ) * nodeVar907.z ) ), fract( ( ( nodeVar908.x + nodeVar908.y ) * nodeVar908.z ) ), nodeVar906.x ), mix( fract( ( ( nodeVar909.x + nodeVar909.y ) * nodeVar909.z ) ), fract( ( ( nodeVar910.x + nodeVar910.y ) * nodeVar910.z ) ), nodeVar906.x ), nodeVar906.y ) ) );
			nodeVar897 = ( ( nodeVar897 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar911 = floor( nodeVar897 );
			nodeVar912 = fract( nodeVar897 );
			nodeVar912 = ( ( nodeVar912 * nodeVar912 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar912 ) ) );
			nodeVar913 = fract( ( vec3<f32>( nodeVar911, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar913 = ( nodeVar913 + vec3<f32>( dot( nodeVar913, ( nodeVar913.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar914 = fract( ( vec3<f32>( ( nodeVar911 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar914 = ( nodeVar914 + vec3<f32>( dot( nodeVar914, ( nodeVar914.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar915 = fract( ( vec3<f32>( ( nodeVar911 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar915 = ( nodeVar915 + vec3<f32>( dot( nodeVar915, ( nodeVar915.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar916 = fract( ( vec3<f32>( ( nodeVar911 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar916 = ( nodeVar916 + vec3<f32>( dot( nodeVar916, ( nodeVar916.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar904 = ( nodeVar904 + ( 0.125 * mix( mix( fract( ( ( nodeVar913.x + nodeVar913.y ) * nodeVar913.z ) ), fract( ( ( nodeVar914.x + nodeVar914.y ) * nodeVar914.z ) ), nodeVar912.x ), mix( fract( ( ( nodeVar915.x + nodeVar915.y ) * nodeVar915.z ) ), fract( ( ( nodeVar916.x + nodeVar916.y ) * nodeVar916.z ) ), nodeVar912.x ), nodeVar912.y ) ) );
			nodeVar917 = ( ( nodeVar897 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar918 = floor( nodeVar917 );
			nodeVar919 = fract( nodeVar917 );
			nodeVar919 = ( ( nodeVar919 * nodeVar919 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar919 ) ) );
			nodeVar920 = fract( ( vec3<f32>( nodeVar918, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar920 = ( nodeVar920 + vec3<f32>( dot( nodeVar920, ( nodeVar920.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar921 = fract( ( vec3<f32>( ( nodeVar918 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar921 = ( nodeVar921 + vec3<f32>( dot( nodeVar921, ( nodeVar921.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar922 = fract( ( vec3<f32>( ( nodeVar918 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar922 = ( nodeVar922 + vec3<f32>( dot( nodeVar922, ( nodeVar922.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar923 = fract( ( vec3<f32>( ( nodeVar918 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar923 = ( nodeVar923 + vec3<f32>( dot( nodeVar923, ( nodeVar923.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar924 = ( nodeVar904 + ( 0.0625 * mix( mix( fract( ( ( nodeVar920.x + nodeVar920.y ) * nodeVar920.z ) ), fract( ( ( nodeVar921.x + nodeVar921.y ) * nodeVar921.z ) ), nodeVar919.x ), mix( fract( ( ( nodeVar922.x + nodeVar922.y ) * nodeVar922.z ) ), fract( ( ( nodeVar923.x + nodeVar923.y ) * nodeVar923.z ) ), nodeVar919.x ), nodeVar919.y ) ) );
			nodeVar925 = ( nodeVar896.xz * vec2<f32>( 0.018 ) );
			nodeVar926 = floor( nodeVar925 );
			nodeVar927 = fract( nodeVar925 );
			nodeVar927 = ( ( nodeVar927 * nodeVar927 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar927 ) ) );
			nodeVar928 = fract( ( vec3<f32>( nodeVar926, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar928 = ( nodeVar928 + vec3<f32>( dot( nodeVar928, ( nodeVar928.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar929 = fract( ( vec3<f32>( ( nodeVar926 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar929 = ( nodeVar929 + vec3<f32>( dot( nodeVar929, ( nodeVar929.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar930 = fract( ( vec3<f32>( ( nodeVar926 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar930 = ( nodeVar930 + vec3<f32>( dot( nodeVar930, ( nodeVar930.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar931 = fract( ( vec3<f32>( ( nodeVar926 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar931 = ( nodeVar931 + vec3<f32>( dot( nodeVar931, ( nodeVar931.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar932 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar928.x + nodeVar928.y ) * nodeVar928.z ) ), fract( ( ( nodeVar929.x + nodeVar929.y ) * nodeVar929.z ) ), nodeVar927.x ), mix( fract( ( ( nodeVar930.x + nodeVar930.y ) * nodeVar930.z ) ), fract( ( ( nodeVar931.x + nodeVar931.y ) * nodeVar931.z ) ), nodeVar927.x ), nodeVar927.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar933 = ( smoothstep( 13.0, 155.0, ( - nodeVar896.xz.x ) ) * ( ( 28.0 + ( nodeVar924 * 135.0 ) ) + ( nodeVar932 * 20.0 ) ) );
			nodeVar934 = ( smoothstep( 280.0, 670.0, ( - nodeVar896.xz.y ) ) * ( ( 46.0 + ( nodeVar924 * 155.0 ) ) + ( nodeVar932 * 22.0 ) ) );
			nodeVar935 = ( smoothstep( 190.0, 430.0, nodeVar896.xz.x ) * ( 30.0 + ( nodeVar924 * 95.0 ) ) );
			nodeVar936 = max( max( nodeVar933, nodeVar934 ), nodeVar935 );
			nodeVar937 = ( exp( ( - dot( ( ( nodeVar896.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar896.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar924 * 10.0 ) ) );
			nodeVar936 = max( nodeVar936, nodeVar937 );

			if ( ( nodeVar936 < 1.5 ) ) {


				if ( ( nodeVar896.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar896.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar896.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar896.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar938 = -1.2;

				} else {

					nodeVar938 = ( 0.1 + ( nodeVar924 * 0.2 ) );

				}

				nodeVar936 = nodeVar938;
				

			}


			if ( ( ( nodeVar896.xz.y > -175.0 ) && ( abs( ( nodeVar896.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar896.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar896.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar936 = 0.0;
				

			}

			nodeVar939 = nodeVar936;

			if ( ( nodeVar939 > 1.0 ) ) {

				nodeVar940 = nodeVar939;

			} else {

				nodeVar940 = -3.5;

			}

			nodeVar941 = vec2<f32>( ( ( nodeVar896.y - nodeVar940 ) * 0.58 ), 1.0 );
			nodeVar942 = floor( ( ( nodeVar896.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
			nodeVar943 = fract( ( vec3<f32>( ( nodeVar942 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar943 = ( nodeVar943 + vec3<f32>( dot( nodeVar943, ( nodeVar943.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar944 = fract( ( ( nodeVar943.x + nodeVar943.y ) * nodeVar943.z ) );
			nodeVar945 = fract( ( vec3<f32>( ( nodeVar942 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar945 = ( nodeVar945 + vec3<f32>( dot( nodeVar945, ( nodeVar945.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar946 = fract( ( vec3<f32>( ( nodeVar942 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar946 = ( nodeVar946 + vec3<f32>( dot( nodeVar946, ( nodeVar946.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar947 = ( ( ( ( ( nodeVar942 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar945.x + nodeVar945.y ) * nodeVar945.z ) ), fract( ( ( nodeVar946.x + nodeVar946.y ) * nodeVar946.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
			nodeVar948 = ( ( nodeVar947 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar949 = floor( nodeVar948 );
			nodeVar950 = fract( nodeVar948 );
			nodeVar950 = ( ( nodeVar950 * nodeVar950 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar950 ) ) );
			nodeVar951 = fract( ( vec3<f32>( nodeVar949, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar951 = ( nodeVar951 + vec3<f32>( dot( nodeVar951, ( nodeVar951.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar952 = fract( ( vec3<f32>( ( nodeVar949 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar952 = ( nodeVar952 + vec3<f32>( dot( nodeVar952, ( nodeVar952.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar953 = fract( ( vec3<f32>( ( nodeVar949 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar953 = ( nodeVar953 + vec3<f32>( dot( nodeVar953, ( nodeVar953.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar954 = fract( ( vec3<f32>( ( nodeVar949 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar954 = ( nodeVar954 + vec3<f32>( dot( nodeVar954, ( nodeVar954.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar955 = ( 0.5 * mix( mix( fract( ( ( nodeVar951.x + nodeVar951.y ) * nodeVar951.z ) ), fract( ( ( nodeVar952.x + nodeVar952.y ) * nodeVar952.z ) ), nodeVar950.x ), mix( fract( ( ( nodeVar953.x + nodeVar953.y ) * nodeVar953.z ) ), fract( ( ( nodeVar954.x + nodeVar954.y ) * nodeVar954.z ) ), nodeVar950.x ), nodeVar950.y ) );
			nodeVar948 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar948 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar956 = floor( nodeVar948 );
			nodeVar957 = fract( nodeVar948 );
			nodeVar957 = ( ( nodeVar957 * nodeVar957 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar957 ) ) );
			nodeVar958 = fract( ( vec3<f32>( nodeVar956, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar958 = ( nodeVar958 + vec3<f32>( dot( nodeVar958, ( nodeVar958.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar959 = fract( ( vec3<f32>( ( nodeVar956 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar959 = ( nodeVar959 + vec3<f32>( dot( nodeVar959, ( nodeVar959.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar960 = fract( ( vec3<f32>( ( nodeVar956 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar960 = ( nodeVar960 + vec3<f32>( dot( nodeVar960, ( nodeVar960.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar961 = fract( ( vec3<f32>( ( nodeVar956 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar961 = ( nodeVar961 + vec3<f32>( dot( nodeVar961, ( nodeVar961.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar955 = ( nodeVar955 + ( 0.25 * mix( mix( fract( ( ( nodeVar958.x + nodeVar958.y ) * nodeVar958.z ) ), fract( ( ( nodeVar959.x + nodeVar959.y ) * nodeVar959.z ) ), nodeVar957.x ), mix( fract( ( ( nodeVar960.x + nodeVar960.y ) * nodeVar960.z ) ), fract( ( ( nodeVar961.x + nodeVar961.y ) * nodeVar961.z ) ), nodeVar957.x ), nodeVar957.y ) ) );
			nodeVar948 = ( ( nodeVar948 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar962 = floor( nodeVar948 );
			nodeVar963 = fract( nodeVar948 );
			nodeVar963 = ( ( nodeVar963 * nodeVar963 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar963 ) ) );
			nodeVar964 = fract( ( vec3<f32>( nodeVar962, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar964 = ( nodeVar964 + vec3<f32>( dot( nodeVar964, ( nodeVar964.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar965 = fract( ( vec3<f32>( ( nodeVar962 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar965 = ( nodeVar965 + vec3<f32>( dot( nodeVar965, ( nodeVar965.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar966 = fract( ( vec3<f32>( ( nodeVar962 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar966 = ( nodeVar966 + vec3<f32>( dot( nodeVar966, ( nodeVar966.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar967 = fract( ( vec3<f32>( ( nodeVar962 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar967 = ( nodeVar967 + vec3<f32>( dot( nodeVar967, ( nodeVar967.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar955 = ( nodeVar955 + ( 0.125 * mix( mix( fract( ( ( nodeVar964.x + nodeVar964.y ) * nodeVar964.z ) ), fract( ( ( nodeVar965.x + nodeVar965.y ) * nodeVar965.z ) ), nodeVar963.x ), mix( fract( ( ( nodeVar966.x + nodeVar966.y ) * nodeVar966.z ) ), fract( ( ( nodeVar967.x + nodeVar967.y ) * nodeVar967.z ) ), nodeVar963.x ), nodeVar963.y ) ) );
			nodeVar968 = ( ( nodeVar948 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar969 = floor( nodeVar968 );
			nodeVar970 = fract( nodeVar968 );
			nodeVar970 = ( ( nodeVar970 * nodeVar970 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar970 ) ) );
			nodeVar971 = fract( ( vec3<f32>( nodeVar969, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar971 = ( nodeVar971 + vec3<f32>( dot( nodeVar971, ( nodeVar971.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar972 = fract( ( vec3<f32>( ( nodeVar969 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar972 = ( nodeVar972 + vec3<f32>( dot( nodeVar972, ( nodeVar972.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar973 = fract( ( vec3<f32>( ( nodeVar969 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar973 = ( nodeVar973 + vec3<f32>( dot( nodeVar973, ( nodeVar973.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar974 = fract( ( vec3<f32>( ( nodeVar969 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar974 = ( nodeVar974 + vec3<f32>( dot( nodeVar974, ( nodeVar974.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar975 = ( nodeVar955 + ( 0.0625 * mix( mix( fract( ( ( nodeVar971.x + nodeVar971.y ) * nodeVar971.z ) ), fract( ( ( nodeVar972.x + nodeVar972.y ) * nodeVar972.z ) ), nodeVar970.x ), mix( fract( ( ( nodeVar973.x + nodeVar973.y ) * nodeVar973.z ) ), fract( ( ( nodeVar974.x + nodeVar974.y ) * nodeVar974.z ) ), nodeVar970.x ), nodeVar970.y ) ) );
			nodeVar976 = ( nodeVar947 * vec2<f32>( 0.018 ) );
			nodeVar977 = floor( nodeVar976 );
			nodeVar978 = fract( nodeVar976 );
			nodeVar978 = ( ( nodeVar978 * nodeVar978 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar978 ) ) );
			nodeVar979 = fract( ( vec3<f32>( nodeVar977, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar979 = ( nodeVar979 + vec3<f32>( dot( nodeVar979, ( nodeVar979.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar980 = fract( ( vec3<f32>( ( nodeVar977 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar980 = ( nodeVar980 + vec3<f32>( dot( nodeVar980, ( nodeVar980.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar981 = fract( ( vec3<f32>( ( nodeVar977 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar981 = ( nodeVar981 + vec3<f32>( dot( nodeVar981, ( nodeVar981.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar982 = fract( ( vec3<f32>( ( nodeVar977 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar982 = ( nodeVar982 + vec3<f32>( dot( nodeVar982, ( nodeVar982.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar983 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar979.x + nodeVar979.y ) * nodeVar979.z ) ), fract( ( ( nodeVar980.x + nodeVar980.y ) * nodeVar980.z ) ), nodeVar978.x ), mix( fract( ( ( nodeVar981.x + nodeVar981.y ) * nodeVar981.z ) ), fract( ( ( nodeVar982.x + nodeVar982.y ) * nodeVar982.z ) ), nodeVar978.x ), nodeVar978.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar984 = ( smoothstep( 13.0, 155.0, ( - nodeVar947.x ) ) * ( ( 28.0 + ( nodeVar975 * 135.0 ) ) + ( nodeVar983 * 20.0 ) ) );
			nodeVar985 = ( smoothstep( 280.0, 670.0, ( - nodeVar947.y ) ) * ( ( 46.0 + ( nodeVar975 * 155.0 ) ) + ( nodeVar983 * 22.0 ) ) );
			nodeVar986 = ( smoothstep( 190.0, 430.0, nodeVar947.x ) * ( 30.0 + ( nodeVar975 * 95.0 ) ) );
			nodeVar987 = max( max( nodeVar984, nodeVar985 ), nodeVar986 );
			nodeVar988 = ( exp( ( - dot( ( ( nodeVar947 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar947 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar975 * 10.0 ) ) );
			nodeVar987 = max( nodeVar987, nodeVar988 );

			if ( ( nodeVar987 < 1.5 ) ) {


				if ( ( nodeVar947.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar947.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar947.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar947.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar989 = -1.2;

				} else {

					nodeVar989 = ( 0.1 + ( nodeVar975 * 0.2 ) );

				}

				nodeVar987 = nodeVar989;
				

			}


			if ( ( ( nodeVar947.y > -175.0 ) && ( abs( ( nodeVar947.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar947.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar947.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar987 = 0.0;
				

			}

			nodeVar990 = nodeVar987;
			nodeVar991 = ( nodeVar947.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar947.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar947.y ) ) ) ) );
			nodeVar992 = ( ( ( ( ( ( nodeVar991 < -9.0 ) || ( nodeVar947.y < -175.0 ) ) && ( nodeVar990 > -0.2 ) ) && ( nodeVar990 < 115.0 ) ) && ( nodeVar944 > 0.15 ) ) && ( ( nodeVar947.y < -12.0 ) || ( nodeVar947.x < -45.0 ) ) );

			if ( nodeVar992 ) {

				nodeVar993 = ( nodeVar896 - vec3<f32>( nodeVar947.x, nodeVar990, nodeVar947.y ) );
				nodeVar994 = ( 6.0 + ( nodeVar944 * 13.0 ) );
				nodeVar995 = clamp( ( nodeVar993.y / nodeVar994 ), 0.0, 1.0 );
				nodeVar996 = atan2( nodeVar993.z, nodeVar993.x );
				nodeVar997 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar993.y * 3.5 ) + ( nodeVar944 * 13.0 ) ) ) ) );
				nodeVar998 = ( ( ( 1.0 - nodeVar995 ) * ( 2.0 + ( nodeVar944 * 1.45 ) ) ) * nodeVar997 );
				nodeVar998 = ( nodeVar998 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar996 * 9.0 ) + ( nodeVar993.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar996 * 19.0 ) - ( nodeVar993.y * 6.0 ) ) ) ) ) );
				nodeVar999 = ( ( nodeVar993.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar993.y * 2.0 ) ) );
				nodeVar1000 = floor( nodeVar999 );
				nodeVar1001 = fract( nodeVar999 );
				nodeVar1001 = ( ( nodeVar1001 * nodeVar1001 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1001 ) ) );
				nodeVar1002 = fract( ( vec3<f32>( nodeVar1000, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1002 = ( nodeVar1002 + vec3<f32>( dot( nodeVar1002, ( nodeVar1002.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1003 = fract( ( vec3<f32>( ( nodeVar1000 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1003 = ( nodeVar1003 + vec3<f32>( dot( nodeVar1003, ( nodeVar1003.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1004 = fract( ( vec3<f32>( ( nodeVar1000 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1004 = ( nodeVar1004 + vec3<f32>( dot( nodeVar1004, ( nodeVar1004.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1005 = fract( ( vec3<f32>( ( nodeVar1000 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1005 = ( nodeVar1005 + vec3<f32>( dot( nodeVar1005, ( nodeVar1005.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1006 = ( ( ( mix( mix( fract( ( ( nodeVar1002.x + nodeVar1002.y ) * nodeVar1002.z ) ), fract( ( ( nodeVar1003.x + nodeVar1003.y ) * nodeVar1003.z ) ), nodeVar1001.x ), mix( fract( ( ( nodeVar1004.x + nodeVar1004.y ) * nodeVar1004.z ) ), fract( ( ( nodeVar1005.x + nodeVar1005.y ) * nodeVar1005.z ) ), nodeVar1001.x ), nodeVar1001.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar995 ) );
				nodeVar1007 = ( max( ( ( length( nodeVar993.xz ) - nodeVar998 ) + nodeVar1006 ), max( ( 0.8 - nodeVar993.y ), ( nodeVar993.y - nodeVar994 ) ) ) * 0.67 );
				nodeVar1009 = vec2<f32>( nodeVar1007, 2.0 );

				if ( ( nodeVar941.x < nodeVar1009.x ) ) {

					nodeVar1008 = nodeVar941;

				} else {

					nodeVar1008 = nodeVar1009;

				}

				nodeVar941 = nodeVar1008;
				nodeVar1011 = vec2<f32>( max( ( length( nodeVar993.xz ) - ( 0.13 * ( 1.0 - ( nodeVar995 * 0.65 ) ) ) ), max( ( - nodeVar993.y ), ( nodeVar993.y - nodeVar994 ) ) ), 3.0 );

				if ( ( nodeVar941.x < nodeVar1011.x ) ) {

					nodeVar1010 = nodeVar941;

				} else {

					nodeVar1010 = nodeVar1011;

				}

				nodeVar941 = nodeVar1010;
				

			}

			nodeVar1012 = clamp( floor( ( ( ( ( - nodeVar896.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
			nodeVar1013 = ( -10.0 - ( nodeVar1012 * 38.0 ) );
			nodeVar1014 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1013 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1013 ) ) ) ) - 6.35 );
			nodeVar1015 = ( nodeVar896 - vec3<f32>( nodeVar1014, 0.0, nodeVar1013 ) );
			nodeVar1016 = ( nodeVar1015 - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar1017 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar1018 = ( length( ( nodeVar1016 - ( nodeVar1017 * vec3<f32>( clamp( ( dot( nodeVar1016, nodeVar1017 ) / dot( nodeVar1017, nodeVar1017 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
			nodeVar1019 = ( nodeVar1015 - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar1020 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar1018 = min( nodeVar1018, ( length( ( nodeVar1019 - ( nodeVar1020 * vec3<f32>( clamp( ( dot( nodeVar1019, nodeVar1020 ) / dot( nodeVar1020, nodeVar1020 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
			nodeVar1021 = ( nodeVar1015 - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar1022 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar1018 = min( nodeVar1018, ( length( ( nodeVar1021 - ( nodeVar1022 * vec3<f32>( clamp( ( dot( nodeVar1021, nodeVar1022 ) / dot( nodeVar1022, nodeVar1022 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
			nodeVar1023 = ( abs( ( nodeVar1015 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
			nodeVar1018 = min( nodeVar1018, ( length( max( nodeVar1023, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1023.x, max( nodeVar1023.y, nodeVar1023.z ) ), 0.0 ) ) );
			nodeVar1025 = vec2<f32>( nodeVar1018, 4.0 );

			if ( ( nodeVar941.x < nodeVar1025.x ) ) {

				nodeVar1024 = nodeVar941;

			} else {

				nodeVar1024 = nodeVar1025;

			}

			nodeVar941 = nodeVar1024;
			nodeVar1027 = ( abs( ( nodeVar1015 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
			nodeVar1028 = vec2<f32>( ( length( max( nodeVar1027, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1027.x, max( nodeVar1027.y, nodeVar1027.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar941.x < nodeVar1028.x ) ) {

				nodeVar1026 = nodeVar941;

			} else {

				nodeVar1026 = nodeVar1028;

			}

			nodeVar941 = nodeVar1026;

			if ( ( ( nodeVar896.z < 28.0 ) && ( nodeVar896.z > -176.0 ) ) ) {

				nodeVar1029 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar896.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar896.z ) ) ) ) + 6.3 );
				nodeVar1030 = ( abs( vec3<f32>( ( nodeVar896.x - nodeVar1029 ), ( nodeVar896.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
				nodeVar1031 = ( length( max( nodeVar1030, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1030.x, max( nodeVar1030.y, nodeVar1030.z ) ), 0.0 ) );
				nodeVar1032 = ( floor( ( ( nodeVar896.z / 5.0 ) + 0.5 ) ) * 5.0 );
				nodeVar1033 = ( abs( ( nodeVar896 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1032 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1032 ) ) ) ) + 6.3 ), 0.45, nodeVar1032 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
				nodeVar1031 = min( nodeVar1031, ( length( max( nodeVar1033, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1033.x, max( nodeVar1033.y, nodeVar1033.z ) ), 0.0 ) ) );
				nodeVar1035 = vec2<f32>( nodeVar1031, 4.0 );

				if ( ( nodeVar941.x < nodeVar1035.x ) ) {

					nodeVar1034 = nodeVar941;

				} else {

					nodeVar1034 = nodeVar1035;

				}

				nodeVar941 = nodeVar1034;
				

			}

			nodeVar1036 = ( nodeVar896 - vec3<f32>( -17.0, 1.85, -73.0 ) );
			nodeVar1037 = ( abs( nodeVar1036 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
			nodeVar1038 = ( length( max( nodeVar1037, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1037.x, max( nodeVar1037.y, nodeVar1037.z ) ), 0.0 ) );
			nodeVar1040 = vec2<f32>( nodeVar1038, 9.0 );

			if ( ( nodeVar941.x < nodeVar1040.x ) ) {

				nodeVar1039 = nodeVar941;

			} else {

				nodeVar1039 = nodeVar1040;

			}

			nodeVar941 = nodeVar1039;
			nodeVar1042 = ( abs( ( nodeVar896 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
			nodeVar1043 = vec2<f32>( ( length( max( nodeVar1042, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1042.x, max( nodeVar1042.y, nodeVar1042.z ) ), 0.0 ) ), 4.0 );

			if ( ( nodeVar941.x < nodeVar1043.x ) ) {

				nodeVar1041 = nodeVar941;

			} else {

				nodeVar1041 = nodeVar1043;

			}

			nodeVar941 = nodeVar1041;
			nodeVar1045 = ( abs( ( nodeVar896 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
			nodeVar1046 = vec2<f32>( ( length( max( nodeVar1045, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1045.x, max( nodeVar1045.y, nodeVar1045.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar941.x < nodeVar1046.x ) ) {

				nodeVar1044 = nodeVar941;

			} else {

				nodeVar1044 = nodeVar1046;

			}

			nodeVar941 = nodeVar1044;
			nodeVar1048 = ( nodeVar896 - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar1049 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar1050 = vec2<f32>( ( length( ( nodeVar1048 - ( nodeVar1049 * vec3<f32>( clamp( ( dot( nodeVar1048, nodeVar1049 ) / dot( nodeVar1049, nodeVar1049 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

			if ( ( nodeVar941.x < nodeVar1050.x ) ) {

				nodeVar1047 = nodeVar941;

			} else {

				nodeVar1047 = nodeVar1050;

			}

			nodeVar941 = nodeVar1047;
			nodeVar1051 = ( nodeVar214 + ( vec3<f32>( nodeVar585, 0.0 ).xxx * vec3<f32>( nodeVar584 ) ) );
			nodeVar1052 = ( ( nodeVar1051.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar1053 = floor( nodeVar1052 );
			nodeVar1054 = fract( nodeVar1052 );
			nodeVar1054 = ( ( nodeVar1054 * nodeVar1054 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1054 ) ) );
			nodeVar1055 = fract( ( vec3<f32>( nodeVar1053, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1055 = ( nodeVar1055 + vec3<f32>( dot( nodeVar1055, ( nodeVar1055.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1056 = fract( ( vec3<f32>( ( nodeVar1053 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1056 = ( nodeVar1056 + vec3<f32>( dot( nodeVar1056, ( nodeVar1056.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1057 = fract( ( vec3<f32>( ( nodeVar1053 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1057 = ( nodeVar1057 + vec3<f32>( dot( nodeVar1057, ( nodeVar1057.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1058 = fract( ( vec3<f32>( ( nodeVar1053 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1058 = ( nodeVar1058 + vec3<f32>( dot( nodeVar1058, ( nodeVar1058.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1059 = ( 0.5 * mix( mix( fract( ( ( nodeVar1055.x + nodeVar1055.y ) * nodeVar1055.z ) ), fract( ( ( nodeVar1056.x + nodeVar1056.y ) * nodeVar1056.z ) ), nodeVar1054.x ), mix( fract( ( ( nodeVar1057.x + nodeVar1057.y ) * nodeVar1057.z ) ), fract( ( ( nodeVar1058.x + nodeVar1058.y ) * nodeVar1058.z ) ), nodeVar1054.x ), nodeVar1054.y ) );
			nodeVar1052 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar1052 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar1060 = floor( nodeVar1052 );
			nodeVar1061 = fract( nodeVar1052 );
			nodeVar1061 = ( ( nodeVar1061 * nodeVar1061 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1061 ) ) );
			nodeVar1062 = fract( ( vec3<f32>( nodeVar1060, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1062 = ( nodeVar1062 + vec3<f32>( dot( nodeVar1062, ( nodeVar1062.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1063 = fract( ( vec3<f32>( ( nodeVar1060 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1063 = ( nodeVar1063 + vec3<f32>( dot( nodeVar1063, ( nodeVar1063.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1064 = fract( ( vec3<f32>( ( nodeVar1060 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1064 = ( nodeVar1064 + vec3<f32>( dot( nodeVar1064, ( nodeVar1064.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1065 = fract( ( vec3<f32>( ( nodeVar1060 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1065 = ( nodeVar1065 + vec3<f32>( dot( nodeVar1065, ( nodeVar1065.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1059 = ( nodeVar1059 + ( 0.25 * mix( mix( fract( ( ( nodeVar1062.x + nodeVar1062.y ) * nodeVar1062.z ) ), fract( ( ( nodeVar1063.x + nodeVar1063.y ) * nodeVar1063.z ) ), nodeVar1061.x ), mix( fract( ( ( nodeVar1064.x + nodeVar1064.y ) * nodeVar1064.z ) ), fract( ( ( nodeVar1065.x + nodeVar1065.y ) * nodeVar1065.z ) ), nodeVar1061.x ), nodeVar1061.y ) ) );
			nodeVar1052 = ( ( nodeVar1052 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar1066 = floor( nodeVar1052 );
			nodeVar1067 = fract( nodeVar1052 );
			nodeVar1067 = ( ( nodeVar1067 * nodeVar1067 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1067 ) ) );
			nodeVar1068 = fract( ( vec3<f32>( nodeVar1066, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1068 = ( nodeVar1068 + vec3<f32>( dot( nodeVar1068, ( nodeVar1068.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1069 = fract( ( vec3<f32>( ( nodeVar1066 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1069 = ( nodeVar1069 + vec3<f32>( dot( nodeVar1069, ( nodeVar1069.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1070 = fract( ( vec3<f32>( ( nodeVar1066 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1070 = ( nodeVar1070 + vec3<f32>( dot( nodeVar1070, ( nodeVar1070.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1071 = fract( ( vec3<f32>( ( nodeVar1066 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1071 = ( nodeVar1071 + vec3<f32>( dot( nodeVar1071, ( nodeVar1071.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1059 = ( nodeVar1059 + ( 0.125 * mix( mix( fract( ( ( nodeVar1068.x + nodeVar1068.y ) * nodeVar1068.z ) ), fract( ( ( nodeVar1069.x + nodeVar1069.y ) * nodeVar1069.z ) ), nodeVar1067.x ), mix( fract( ( ( nodeVar1070.x + nodeVar1070.y ) * nodeVar1070.z ) ), fract( ( ( nodeVar1071.x + nodeVar1071.y ) * nodeVar1071.z ) ), nodeVar1067.x ), nodeVar1067.y ) ) );
			nodeVar1072 = ( ( nodeVar1052 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar1073 = floor( nodeVar1072 );
			nodeVar1074 = fract( nodeVar1072 );
			nodeVar1074 = ( ( nodeVar1074 * nodeVar1074 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1074 ) ) );
			nodeVar1075 = fract( ( vec3<f32>( nodeVar1073, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1075 = ( nodeVar1075 + vec3<f32>( dot( nodeVar1075, ( nodeVar1075.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1076 = fract( ( vec3<f32>( ( nodeVar1073 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1076 = ( nodeVar1076 + vec3<f32>( dot( nodeVar1076, ( nodeVar1076.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1077 = fract( ( vec3<f32>( ( nodeVar1073 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1077 = ( nodeVar1077 + vec3<f32>( dot( nodeVar1077, ( nodeVar1077.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1078 = fract( ( vec3<f32>( ( nodeVar1073 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1078 = ( nodeVar1078 + vec3<f32>( dot( nodeVar1078, ( nodeVar1078.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1079 = ( nodeVar1059 + ( 0.0625 * mix( mix( fract( ( ( nodeVar1075.x + nodeVar1075.y ) * nodeVar1075.z ) ), fract( ( ( nodeVar1076.x + nodeVar1076.y ) * nodeVar1076.z ) ), nodeVar1074.x ), mix( fract( ( ( nodeVar1077.x + nodeVar1077.y ) * nodeVar1077.z ) ), fract( ( ( nodeVar1078.x + nodeVar1078.y ) * nodeVar1078.z ) ), nodeVar1074.x ), nodeVar1074.y ) ) );
			nodeVar1080 = ( nodeVar1051.xz * vec2<f32>( 0.018 ) );
			nodeVar1081 = floor( nodeVar1080 );
			nodeVar1082 = fract( nodeVar1080 );
			nodeVar1082 = ( ( nodeVar1082 * nodeVar1082 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1082 ) ) );
			nodeVar1083 = fract( ( vec3<f32>( nodeVar1081, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1083 = ( nodeVar1083 + vec3<f32>( dot( nodeVar1083, ( nodeVar1083.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1084 = fract( ( vec3<f32>( ( nodeVar1081 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1084 = ( nodeVar1084 + vec3<f32>( dot( nodeVar1084, ( nodeVar1084.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1085 = fract( ( vec3<f32>( ( nodeVar1081 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1085 = ( nodeVar1085 + vec3<f32>( dot( nodeVar1085, ( nodeVar1085.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1086 = fract( ( vec3<f32>( ( nodeVar1081 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1086 = ( nodeVar1086 + vec3<f32>( dot( nodeVar1086, ( nodeVar1086.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1087 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar1083.x + nodeVar1083.y ) * nodeVar1083.z ) ), fract( ( ( nodeVar1084.x + nodeVar1084.y ) * nodeVar1084.z ) ), nodeVar1082.x ), mix( fract( ( ( nodeVar1085.x + nodeVar1085.y ) * nodeVar1085.z ) ), fract( ( ( nodeVar1086.x + nodeVar1086.y ) * nodeVar1086.z ) ), nodeVar1082.x ), nodeVar1082.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar1088 = ( smoothstep( 13.0, 155.0, ( - nodeVar1051.xz.x ) ) * ( ( 28.0 + ( nodeVar1079 * 135.0 ) ) + ( nodeVar1087 * 20.0 ) ) );
			nodeVar1089 = ( smoothstep( 280.0, 670.0, ( - nodeVar1051.xz.y ) ) * ( ( 46.0 + ( nodeVar1079 * 155.0 ) ) + ( nodeVar1087 * 22.0 ) ) );
			nodeVar1090 = ( smoothstep( 190.0, 430.0, nodeVar1051.xz.x ) * ( 30.0 + ( nodeVar1079 * 95.0 ) ) );
			nodeVar1091 = max( max( nodeVar1088, nodeVar1089 ), nodeVar1090 );
			nodeVar1092 = ( exp( ( - dot( ( ( nodeVar1051.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar1051.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar1079 * 10.0 ) ) );
			nodeVar1091 = max( nodeVar1091, nodeVar1092 );

			if ( ( nodeVar1091 < 1.5 ) ) {


				if ( ( nodeVar1051.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1051.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1051.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar1051.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar1093 = -1.2;

				} else {

					nodeVar1093 = ( 0.1 + ( nodeVar1079 * 0.2 ) );

				}

				nodeVar1091 = nodeVar1093;
				

			}


			if ( ( ( nodeVar1051.xz.y > -175.0 ) && ( abs( ( nodeVar1051.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar1051.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1051.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar1091 = 0.0;
				

			}

			nodeVar1094 = nodeVar1091;

			if ( ( nodeVar1094 > 1.0 ) ) {

				nodeVar1095 = nodeVar1094;

			} else {

				nodeVar1095 = -3.5;

			}

			nodeVar1096 = vec2<f32>( ( ( nodeVar1051.y - nodeVar1095 ) * 0.58 ), 1.0 );
			nodeVar1097 = floor( ( ( nodeVar1051.xz + vec2<f32>( 2.0, 1.0 ) ) / vec2<f32>( 10.5 ) ) );
			nodeVar1098 = fract( ( vec3<f32>( ( nodeVar1097 + vec2<f32>( 17.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1098 = ( nodeVar1098 + vec3<f32>( dot( nodeVar1098, ( nodeVar1098.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1099 = fract( ( ( nodeVar1098.x + nodeVar1098.y ) * nodeVar1098.z ) );
			nodeVar1100 = fract( ( vec3<f32>( ( nodeVar1097 + vec2<f32>( 3.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1100 = ( nodeVar1100 + vec3<f32>( dot( nodeVar1100, ( nodeVar1100.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1101 = fract( ( vec3<f32>( ( nodeVar1097 + vec2<f32>( 7.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1101 = ( nodeVar1101 + vec3<f32>( dot( nodeVar1101, ( nodeVar1101.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1102 = ( ( ( ( ( nodeVar1097 + vec2<f32>( 0.5 ) ) * vec2<f32>( 10.5 ) ) - vec2<f32>( 2.0, 1.0 ) ) + ( vec2<f32>( fract( ( ( nodeVar1100.x + nodeVar1100.y ) * nodeVar1100.z ) ), fract( ( ( nodeVar1101.x + nodeVar1101.y ) * nodeVar1101.z ) ) ) * vec2<f32>( 0.9 ) ) ) - vec2<f32>( 0.45 ) );
			nodeVar1103 = ( ( nodeVar1102 * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar1104 = floor( nodeVar1103 );
			nodeVar1105 = fract( nodeVar1103 );
			nodeVar1105 = ( ( nodeVar1105 * nodeVar1105 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1105 ) ) );
			nodeVar1106 = fract( ( vec3<f32>( nodeVar1104, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1106 = ( nodeVar1106 + vec3<f32>( dot( nodeVar1106, ( nodeVar1106.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1107 = fract( ( vec3<f32>( ( nodeVar1104 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1107 = ( nodeVar1107 + vec3<f32>( dot( nodeVar1107, ( nodeVar1107.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1108 = fract( ( vec3<f32>( ( nodeVar1104 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1108 = ( nodeVar1108 + vec3<f32>( dot( nodeVar1108, ( nodeVar1108.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1109 = fract( ( vec3<f32>( ( nodeVar1104 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1109 = ( nodeVar1109 + vec3<f32>( dot( nodeVar1109, ( nodeVar1109.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1110 = ( 0.5 * mix( mix( fract( ( ( nodeVar1106.x + nodeVar1106.y ) * nodeVar1106.z ) ), fract( ( ( nodeVar1107.x + nodeVar1107.y ) * nodeVar1107.z ) ), nodeVar1105.x ), mix( fract( ( ( nodeVar1108.x + nodeVar1108.y ) * nodeVar1108.z ) ), fract( ( ( nodeVar1109.x + nodeVar1109.y ) * nodeVar1109.z ) ), nodeVar1105.x ), nodeVar1105.y ) );
			nodeVar1103 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar1103 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar1111 = floor( nodeVar1103 );
			nodeVar1112 = fract( nodeVar1103 );
			nodeVar1112 = ( ( nodeVar1112 * nodeVar1112 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1112 ) ) );
			nodeVar1113 = fract( ( vec3<f32>( nodeVar1111, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1113 = ( nodeVar1113 + vec3<f32>( dot( nodeVar1113, ( nodeVar1113.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1114 = fract( ( vec3<f32>( ( nodeVar1111 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1114 = ( nodeVar1114 + vec3<f32>( dot( nodeVar1114, ( nodeVar1114.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1115 = fract( ( vec3<f32>( ( nodeVar1111 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1115 = ( nodeVar1115 + vec3<f32>( dot( nodeVar1115, ( nodeVar1115.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1116 = fract( ( vec3<f32>( ( nodeVar1111 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1116 = ( nodeVar1116 + vec3<f32>( dot( nodeVar1116, ( nodeVar1116.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1110 = ( nodeVar1110 + ( 0.25 * mix( mix( fract( ( ( nodeVar1113.x + nodeVar1113.y ) * nodeVar1113.z ) ), fract( ( ( nodeVar1114.x + nodeVar1114.y ) * nodeVar1114.z ) ), nodeVar1112.x ), mix( fract( ( ( nodeVar1115.x + nodeVar1115.y ) * nodeVar1115.z ) ), fract( ( ( nodeVar1116.x + nodeVar1116.y ) * nodeVar1116.z ) ), nodeVar1112.x ), nodeVar1112.y ) ) );
			nodeVar1103 = ( ( nodeVar1103 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar1117 = floor( nodeVar1103 );
			nodeVar1118 = fract( nodeVar1103 );
			nodeVar1118 = ( ( nodeVar1118 * nodeVar1118 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1118 ) ) );
			nodeVar1119 = fract( ( vec3<f32>( nodeVar1117, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1119 = ( nodeVar1119 + vec3<f32>( dot( nodeVar1119, ( nodeVar1119.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1120 = fract( ( vec3<f32>( ( nodeVar1117 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1120 = ( nodeVar1120 + vec3<f32>( dot( nodeVar1120, ( nodeVar1120.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1121 = fract( ( vec3<f32>( ( nodeVar1117 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1121 = ( nodeVar1121 + vec3<f32>( dot( nodeVar1121, ( nodeVar1121.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1122 = fract( ( vec3<f32>( ( nodeVar1117 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1122 = ( nodeVar1122 + vec3<f32>( dot( nodeVar1122, ( nodeVar1122.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1110 = ( nodeVar1110 + ( 0.125 * mix( mix( fract( ( ( nodeVar1119.x + nodeVar1119.y ) * nodeVar1119.z ) ), fract( ( ( nodeVar1120.x + nodeVar1120.y ) * nodeVar1120.z ) ), nodeVar1118.x ), mix( fract( ( ( nodeVar1121.x + nodeVar1121.y ) * nodeVar1121.z ) ), fract( ( ( nodeVar1122.x + nodeVar1122.y ) * nodeVar1122.z ) ), nodeVar1118.x ), nodeVar1118.y ) ) );
			nodeVar1123 = ( ( nodeVar1103 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar1124 = floor( nodeVar1123 );
			nodeVar1125 = fract( nodeVar1123 );
			nodeVar1125 = ( ( nodeVar1125 * nodeVar1125 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1125 ) ) );
			nodeVar1126 = fract( ( vec3<f32>( nodeVar1124, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1126 = ( nodeVar1126 + vec3<f32>( dot( nodeVar1126, ( nodeVar1126.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1127 = fract( ( vec3<f32>( ( nodeVar1124 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1127 = ( nodeVar1127 + vec3<f32>( dot( nodeVar1127, ( nodeVar1127.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1128 = fract( ( vec3<f32>( ( nodeVar1124 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1128 = ( nodeVar1128 + vec3<f32>( dot( nodeVar1128, ( nodeVar1128.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1129 = fract( ( vec3<f32>( ( nodeVar1124 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1129 = ( nodeVar1129 + vec3<f32>( dot( nodeVar1129, ( nodeVar1129.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1130 = ( nodeVar1110 + ( 0.0625 * mix( mix( fract( ( ( nodeVar1126.x + nodeVar1126.y ) * nodeVar1126.z ) ), fract( ( ( nodeVar1127.x + nodeVar1127.y ) * nodeVar1127.z ) ), nodeVar1125.x ), mix( fract( ( ( nodeVar1128.x + nodeVar1128.y ) * nodeVar1128.z ) ), fract( ( ( nodeVar1129.x + nodeVar1129.y ) * nodeVar1129.z ) ), nodeVar1125.x ), nodeVar1125.y ) ) );
			nodeVar1131 = ( nodeVar1102 * vec2<f32>( 0.018 ) );
			nodeVar1132 = floor( nodeVar1131 );
			nodeVar1133 = fract( nodeVar1131 );
			nodeVar1133 = ( ( nodeVar1133 * nodeVar1133 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1133 ) ) );
			nodeVar1134 = fract( ( vec3<f32>( nodeVar1132, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1134 = ( nodeVar1134 + vec3<f32>( dot( nodeVar1134, ( nodeVar1134.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1135 = fract( ( vec3<f32>( ( nodeVar1132 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1135 = ( nodeVar1135 + vec3<f32>( dot( nodeVar1135, ( nodeVar1135.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1136 = fract( ( vec3<f32>( ( nodeVar1132 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1136 = ( nodeVar1136 + vec3<f32>( dot( nodeVar1136, ( nodeVar1136.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1137 = fract( ( vec3<f32>( ( nodeVar1132 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1137 = ( nodeVar1137 + vec3<f32>( dot( nodeVar1137, ( nodeVar1137.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1138 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar1134.x + nodeVar1134.y ) * nodeVar1134.z ) ), fract( ( ( nodeVar1135.x + nodeVar1135.y ) * nodeVar1135.z ) ), nodeVar1133.x ), mix( fract( ( ( nodeVar1136.x + nodeVar1136.y ) * nodeVar1136.z ) ), fract( ( ( nodeVar1137.x + nodeVar1137.y ) * nodeVar1137.z ) ), nodeVar1133.x ), nodeVar1133.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar1139 = ( smoothstep( 13.0, 155.0, ( - nodeVar1102.x ) ) * ( ( 28.0 + ( nodeVar1130 * 135.0 ) ) + ( nodeVar1138 * 20.0 ) ) );
			nodeVar1140 = ( smoothstep( 280.0, 670.0, ( - nodeVar1102.y ) ) * ( ( 46.0 + ( nodeVar1130 * 155.0 ) ) + ( nodeVar1138 * 22.0 ) ) );
			nodeVar1141 = ( smoothstep( 190.0, 430.0, nodeVar1102.x ) * ( 30.0 + ( nodeVar1130 * 95.0 ) ) );
			nodeVar1142 = max( max( nodeVar1139, nodeVar1140 ), nodeVar1141 );
			nodeVar1143 = ( exp( ( - dot( ( ( nodeVar1102 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar1102 - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar1130 * 10.0 ) ) );
			nodeVar1142 = max( nodeVar1142, nodeVar1143 );

			if ( ( nodeVar1142 < 1.5 ) ) {


				if ( ( nodeVar1102.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1102.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1102.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar1102.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar1144 = -1.2;

				} else {

					nodeVar1144 = ( 0.1 + ( nodeVar1130 * 0.2 ) );

				}

				nodeVar1142 = nodeVar1144;
				

			}


			if ( ( ( nodeVar1102.y > -175.0 ) && ( abs( ( nodeVar1102.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar1102.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1102.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar1142 = 0.0;
				

			}

			nodeVar1145 = nodeVar1142;
			nodeVar1146 = ( nodeVar1102.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar1102.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1102.y ) ) ) ) );
			nodeVar1147 = ( ( ( ( ( ( nodeVar1146 < -9.0 ) || ( nodeVar1102.y < -175.0 ) ) && ( nodeVar1145 > -0.2 ) ) && ( nodeVar1145 < 115.0 ) ) && ( nodeVar1099 > 0.15 ) ) && ( ( nodeVar1102.y < -12.0 ) || ( nodeVar1102.x < -45.0 ) ) );

			if ( nodeVar1147 ) {

				nodeVar1148 = ( nodeVar1051 - vec3<f32>( nodeVar1102.x, nodeVar1145, nodeVar1102.y ) );
				nodeVar1149 = ( 6.0 + ( nodeVar1099 * 13.0 ) );
				nodeVar1150 = clamp( ( nodeVar1148.y / nodeVar1149 ), 0.0, 1.0 );
				nodeVar1151 = atan2( nodeVar1148.z, nodeVar1148.x );
				nodeVar1152 = ( 0.77 + ( 0.23 * sin( ( ( nodeVar1148.y * 3.5 ) + ( nodeVar1099 * 13.0 ) ) ) ) );
				nodeVar1153 = ( ( ( 1.0 - nodeVar1150 ) * ( 2.0 + ( nodeVar1099 * 1.45 ) ) ) * nodeVar1152 );
				nodeVar1153 = ( nodeVar1153 * ( ( 0.88 + ( 0.12 * sin( ( ( nodeVar1151 * 9.0 ) + ( nodeVar1148.y * 2.7 ) ) ) ) ) + ( 0.07 * sin( ( ( nodeVar1151 * 19.0 ) - ( nodeVar1148.y * 6.0 ) ) ) ) ) );
				nodeVar1154 = ( ( nodeVar1148.xz * vec2<f32>( 6.0 ) ) + vec2<f32>( ( nodeVar1148.y * 2.0 ) ) );
				nodeVar1155 = floor( nodeVar1154 );
				nodeVar1156 = fract( nodeVar1154 );
				nodeVar1156 = ( ( nodeVar1156 * nodeVar1156 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1156 ) ) );
				nodeVar1157 = fract( ( vec3<f32>( nodeVar1155, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1157 = ( nodeVar1157 + vec3<f32>( dot( nodeVar1157, ( nodeVar1157.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1158 = fract( ( vec3<f32>( ( nodeVar1155 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1158 = ( nodeVar1158 + vec3<f32>( dot( nodeVar1158, ( nodeVar1158.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1159 = fract( ( vec3<f32>( ( nodeVar1155 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1159 = ( nodeVar1159 + vec3<f32>( dot( nodeVar1159, ( nodeVar1159.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1160 = fract( ( vec3<f32>( ( nodeVar1155 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1160 = ( nodeVar1160 + vec3<f32>( dot( nodeVar1160, ( nodeVar1160.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1161 = ( ( ( mix( mix( fract( ( ( nodeVar1157.x + nodeVar1157.y ) * nodeVar1157.z ) ), fract( ( ( nodeVar1158.x + nodeVar1158.y ) * nodeVar1158.z ) ), nodeVar1156.x ), mix( fract( ( ( nodeVar1159.x + nodeVar1159.y ) * nodeVar1159.z ) ), fract( ( ( nodeVar1160.x + nodeVar1160.y ) * nodeVar1160.z ) ), nodeVar1156.x ), nodeVar1156.y ) - 0.5 ) * 0.18 ) * ( 1.0 - nodeVar1150 ) );
				nodeVar1162 = ( max( ( ( length( nodeVar1148.xz ) - nodeVar1153 ) + nodeVar1161 ), max( ( 0.8 - nodeVar1148.y ), ( nodeVar1148.y - nodeVar1149 ) ) ) * 0.67 );
				nodeVar1164 = vec2<f32>( nodeVar1162, 2.0 );

				if ( ( nodeVar1096.x < nodeVar1164.x ) ) {

					nodeVar1163 = nodeVar1096;

				} else {

					nodeVar1163 = nodeVar1164;

				}

				nodeVar1096 = nodeVar1163;
				nodeVar1166 = vec2<f32>( max( ( length( nodeVar1148.xz ) - ( 0.13 * ( 1.0 - ( nodeVar1150 * 0.65 ) ) ) ), max( ( - nodeVar1148.y ), ( nodeVar1148.y - nodeVar1149 ) ) ), 3.0 );

				if ( ( nodeVar1096.x < nodeVar1166.x ) ) {

					nodeVar1165 = nodeVar1096;

				} else {

					nodeVar1165 = nodeVar1166;

				}

				nodeVar1096 = nodeVar1165;
				

			}

			nodeVar1167 = clamp( floor( ( ( ( ( - nodeVar1051.z ) - 10.0 ) / 38.0 ) + 0.5 ) ), 0.0, 5.0 );
			nodeVar1168 = ( -10.0 - ( nodeVar1167 * 38.0 ) );
			nodeVar1169 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1168 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1168 ) ) ) ) - 6.35 );
			nodeVar1170 = ( nodeVar1051 - vec3<f32>( nodeVar1169, 0.0, nodeVar1168 ) );
			nodeVar1171 = ( nodeVar1170 - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar1172 = ( vec3<f32>( 0.0, 7.65, 0.0 ) - vec3<f32>( 0.0, 0.0, 0.0 ) );
			nodeVar1173 = ( length( ( nodeVar1171 - ( nodeVar1172 * vec3<f32>( clamp( ( dot( nodeVar1171, nodeVar1172 ) / dot( nodeVar1172, nodeVar1172 ) ), 0.0, 1.0 ) ) ) ) ) - 0.075 );
			nodeVar1174 = ( nodeVar1170 - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar1175 = ( vec3<f32>( 1.6, 8.05, 0.0 ) - vec3<f32>( 0.0, 7.6, 0.0 ) );
			nodeVar1173 = min( nodeVar1173, ( length( ( nodeVar1174 - ( nodeVar1175 * vec3<f32>( clamp( ( dot( nodeVar1174, nodeVar1175 ) / dot( nodeVar1175, nodeVar1175 ) ), 0.0, 1.0 ) ) ) ) ) - 0.065 ) );
			nodeVar1176 = ( nodeVar1170 - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar1177 = ( vec3<f32>( 2.5, 8.05, 0.0 ) - vec3<f32>( 1.6, 8.05, 0.0 ) );
			nodeVar1173 = min( nodeVar1173, ( length( ( nodeVar1176 - ( nodeVar1177 * vec3<f32>( clamp( ( dot( nodeVar1176, nodeVar1177 ) / dot( nodeVar1177, nodeVar1177 ) ), 0.0, 1.0 ) ) ) ) ) - 0.055 ) );
			nodeVar1178 = ( abs( ( nodeVar1170 - vec3<f32>( 2.43, 8.0, 0.0 ) ) ) - vec3<f32>( 0.4, 0.1, 0.23 ) );
			nodeVar1173 = min( nodeVar1173, ( length( max( nodeVar1178, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1178.x, max( nodeVar1178.y, nodeVar1178.z ) ), 0.0 ) ) );
			nodeVar1180 = vec2<f32>( nodeVar1173, 4.0 );

			if ( ( nodeVar1096.x < nodeVar1180.x ) ) {

				nodeVar1179 = nodeVar1096;

			} else {

				nodeVar1179 = nodeVar1180;

			}

			nodeVar1096 = nodeVar1179;
			nodeVar1182 = ( abs( ( nodeVar1170 - vec3<f32>( 2.45, 7.885, 0.0 ) ) ) - vec3<f32>( 0.32, 0.021, 0.175 ) );
			nodeVar1183 = vec2<f32>( ( length( max( nodeVar1182, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1182.x, max( nodeVar1182.y, nodeVar1182.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar1096.x < nodeVar1183.x ) ) {

				nodeVar1181 = nodeVar1096;

			} else {

				nodeVar1181 = nodeVar1183;

			}

			nodeVar1096 = nodeVar1181;

			if ( ( ( nodeVar1051.z < 28.0 ) && ( nodeVar1051.z > -176.0 ) ) ) {

				nodeVar1184 = ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1051.z * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1051.z ) ) ) ) + 6.3 );
				nodeVar1185 = ( abs( vec3<f32>( ( nodeVar1051.x - nodeVar1184 ), ( nodeVar1051.y - 0.84 ), 0.0 ) ) - vec3<f32>( 0.065, 0.13, 1000.0 ) );
				nodeVar1186 = ( length( max( nodeVar1185, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1185.x, max( nodeVar1185.y, nodeVar1185.z ) ), 0.0 ) );
				nodeVar1187 = ( floor( ( ( nodeVar1051.z / 5.0 ) + 0.5 ) ) * 5.0 );
				nodeVar1188 = ( abs( ( nodeVar1051 - vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1187 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1187 ) ) ) ) + 6.3 ), 0.45, nodeVar1187 ) ) ) - vec3<f32>( 0.055, 0.45, 0.055 ) );
				nodeVar1186 = min( nodeVar1186, ( length( max( nodeVar1188, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1188.x, max( nodeVar1188.y, nodeVar1188.z ) ), 0.0 ) ) );
				nodeVar1190 = vec2<f32>( nodeVar1186, 4.0 );

				if ( ( nodeVar1096.x < nodeVar1190.x ) ) {

					nodeVar1189 = nodeVar1096;

				} else {

					nodeVar1189 = nodeVar1190;

				}

				nodeVar1096 = nodeVar1189;
				

			}

			nodeVar1191 = ( nodeVar1051 - vec3<f32>( -17.0, 1.85, -73.0 ) );
			nodeVar1192 = ( abs( nodeVar1191 ) - vec3<f32>( 3.3, 1.85, 2.65 ) );
			nodeVar1193 = ( length( max( nodeVar1192, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1192.x, max( nodeVar1192.y, nodeVar1192.z ) ), 0.0 ) );
			nodeVar1195 = vec2<f32>( nodeVar1193, 9.0 );

			if ( ( nodeVar1096.x < nodeVar1195.x ) ) {

				nodeVar1194 = nodeVar1096;

			} else {

				nodeVar1194 = nodeVar1195;

			}

			nodeVar1096 = nodeVar1194;
			nodeVar1197 = ( abs( ( nodeVar1051 - vec3<f32>( -17.0, 3.85, -73.0 ) ) ) - vec3<f32>( 3.6, 0.14, 2.9 ) );
			nodeVar1198 = vec2<f32>( ( length( max( nodeVar1197, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1197.x, max( nodeVar1197.y, nodeVar1197.z ) ), 0.0 ) ), 4.0 );

			if ( ( nodeVar1096.x < nodeVar1198.x ) ) {

				nodeVar1196 = nodeVar1096;

			} else {

				nodeVar1196 = nodeVar1198;

			}

			nodeVar1096 = nodeVar1196;
			nodeVar1200 = ( abs( ( nodeVar1051 - vec3<f32>( -17.8, 2.1, -70.325 ) ) ) - vec3<f32>( 0.84, 0.48, 0.028 ) );
			nodeVar1201 = vec2<f32>( ( length( max( nodeVar1200, vec3<f32>( 0.0 ) ) ) + min( max( nodeVar1200.x, max( nodeVar1200.y, nodeVar1200.z ) ), 0.0 ) ), 6.0 );

			if ( ( nodeVar1096.x < nodeVar1201.x ) ) {

				nodeVar1199 = nodeVar1096;

			} else {

				nodeVar1199 = nodeVar1201;

			}

			nodeVar1096 = nodeVar1199;
			nodeVar1203 = ( nodeVar1051 - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar1204 = ( vec3<f32>( -19.0, 13.0, -74.0 ) - vec3<f32>( -19.0, 3.9, -74.0 ) );
			nodeVar1205 = vec2<f32>( ( length( ( nodeVar1203 - ( nodeVar1204 * vec3<f32>( clamp( ( dot( nodeVar1203, nodeVar1204 ) / dot( nodeVar1204, nodeVar1204 ) ), 0.0, 1.0 ) ) ) ) ) - 0.045 ), 4.0 );

			if ( ( nodeVar1096.x < nodeVar1205.x ) ) {

				nodeVar1202 = nodeVar1096;

			} else {

				nodeVar1202 = nodeVar1205;

			}

			nodeVar1096 = nodeVar1202;
			nodeVar216 = normalize( ( ( ( ( vec3<f32>( nodeVar585, 0.0 ).xyy * vec3<f32>( nodeVar631.x ) ) + ( vec3<f32>( nodeVar585, 0.0 ).yyx * vec3<f32>( nodeVar786.x ) ) ) + ( vec3<f32>( nodeVar585, 0.0 ).yxy * vec3<f32>( nodeVar941.x ) ) ) + ( vec3<f32>( nodeVar585, 0.0 ).xxx * vec3<f32>( nodeVar1096.x ) ) ) );

			if ( ( ( nodeVar213 > 5.5 ) && ( nodeVar213 < 6.5 ) ) ) {

				nodeVar217 = frame.nodeUniform21;
				

			} else {

				nodeVar1206 = ( 0.45 + ( 0.55 * max( nodeVar216.y, 0.0 ) ) );
				nodeVar1207 = ( ( nodeVar214.xz * vec2<f32>( 4.3 ) ) + vec2<f32>( nodeVar214.y ) );
				nodeVar1208 = floor( nodeVar1207 );
				nodeVar1209 = fract( nodeVar1207 );
				nodeVar1209 = ( ( nodeVar1209 * nodeVar1209 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1209 ) ) );
				nodeVar1210 = fract( ( vec3<f32>( nodeVar1208, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1210 = ( nodeVar1210 + vec3<f32>( dot( nodeVar1210, ( nodeVar1210.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1211 = fract( ( vec3<f32>( ( nodeVar1208 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1211 = ( nodeVar1211 + vec3<f32>( dot( nodeVar1211, ( nodeVar1211.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1212 = fract( ( vec3<f32>( ( nodeVar1208 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1212 = ( nodeVar1212 + vec3<f32>( dot( nodeVar1212, ( nodeVar1212.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1213 = fract( ( vec3<f32>( ( nodeVar1208 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1213 = ( nodeVar1213 + vec3<f32>( dot( nodeVar1213, ( nodeVar1213.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1214 = ( nodeVar214.xz * vec2<f32>( 31.0 ) );
				nodeVar1215 = floor( nodeVar1214 );
				nodeVar1216 = fract( nodeVar1214 );
				nodeVar1216 = ( ( nodeVar1216 * nodeVar1216 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1216 ) ) );
				nodeVar1217 = fract( ( vec3<f32>( nodeVar1215, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1217 = ( nodeVar1217 + vec3<f32>( dot( nodeVar1217, ( nodeVar1217.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1218 = fract( ( vec3<f32>( ( nodeVar1215 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1218 = ( nodeVar1218 + vec3<f32>( dot( nodeVar1218, ( nodeVar1218.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1219 = fract( ( vec3<f32>( ( nodeVar1215 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1219 = ( nodeVar1219 + vec3<f32>( dot( nodeVar1219, ( nodeVar1219.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1220 = fract( ( vec3<f32>( ( nodeVar1215 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
				nodeVar1220 = ( nodeVar1220 + vec3<f32>( dot( nodeVar1220, ( nodeVar1220.yzx + vec3<f32>( 33.33 ) ) ) ) );
				nodeVar1221 = ( ( mix( mix( fract( ( ( nodeVar1210.x + nodeVar1210.y ) * nodeVar1210.z ) ), fract( ( ( nodeVar1211.x + nodeVar1211.y ) * nodeVar1211.z ) ), nodeVar1209.x ), mix( fract( ( ( nodeVar1212.x + nodeVar1212.y ) * nodeVar1212.z ) ), fract( ( ( nodeVar1213.x + nodeVar1213.y ) * nodeVar1213.z ) ), nodeVar1209.x ), nodeVar1209.y ) * 0.2 ) + ( mix( mix( fract( ( ( nodeVar1217.x + nodeVar1217.y ) * nodeVar1217.z ) ), fract( ( ( nodeVar1218.x + nodeVar1218.y ) * nodeVar1218.z ) ), nodeVar1216.x ), mix( fract( ( ( nodeVar1219.x + nodeVar1219.y ) * nodeVar1219.z ) ), fract( ( ( nodeVar1220.x + nodeVar1220.y ) * nodeVar1220.z ) ), nodeVar1216.x ), nodeVar1216.y ) * 0.09 ) );
				nodeVar1222 = vec3<f32>( 0.1, 0.1, 0.1 );

				if ( ( nodeVar213 < 1.5 ) ) {

					nodeVar1223 = ( ( nodeVar214.xz * vec2<f32>( 0.3 ) ) + vec2<f32>( ( nodeVar214.y * 0.4 ) ) );
					nodeVar1224 = floor( nodeVar1223 );
					nodeVar1225 = fract( nodeVar1223 );
					nodeVar1225 = ( ( nodeVar1225 * nodeVar1225 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1225 ) ) );
					nodeVar1226 = fract( ( vec3<f32>( nodeVar1224, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1226 = ( nodeVar1226 + vec3<f32>( dot( nodeVar1226, ( nodeVar1226.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1227 = fract( ( vec3<f32>( ( nodeVar1224 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1227 = ( nodeVar1227 + vec3<f32>( dot( nodeVar1227, ( nodeVar1227.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1228 = fract( ( vec3<f32>( ( nodeVar1224 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1228 = ( nodeVar1228 + vec3<f32>( dot( nodeVar1228, ( nodeVar1228.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1229 = fract( ( vec3<f32>( ( nodeVar1224 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1229 = ( nodeVar1229 + vec3<f32>( dot( nodeVar1229, ( nodeVar1229.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1230 = ( 0.5 * mix( mix( fract( ( ( nodeVar1226.x + nodeVar1226.y ) * nodeVar1226.z ) ), fract( ( ( nodeVar1227.x + nodeVar1227.y ) * nodeVar1227.z ) ), nodeVar1225.x ), mix( fract( ( ( nodeVar1228.x + nodeVar1228.y ) * nodeVar1228.z ) ), fract( ( ( nodeVar1229.x + nodeVar1229.y ) * nodeVar1229.z ) ), nodeVar1225.x ), nodeVar1225.y ) );
					nodeVar1223 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar1223 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
					nodeVar1231 = floor( nodeVar1223 );
					nodeVar1232 = fract( nodeVar1223 );
					nodeVar1232 = ( ( nodeVar1232 * nodeVar1232 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1232 ) ) );
					nodeVar1233 = fract( ( vec3<f32>( nodeVar1231, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1233 = ( nodeVar1233 + vec3<f32>( dot( nodeVar1233, ( nodeVar1233.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1234 = fract( ( vec3<f32>( ( nodeVar1231 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1234 = ( nodeVar1234 + vec3<f32>( dot( nodeVar1234, ( nodeVar1234.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1235 = fract( ( vec3<f32>( ( nodeVar1231 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1235 = ( nodeVar1235 + vec3<f32>( dot( nodeVar1235, ( nodeVar1235.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1236 = fract( ( vec3<f32>( ( nodeVar1231 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1236 = ( nodeVar1236 + vec3<f32>( dot( nodeVar1236, ( nodeVar1236.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1230 = ( nodeVar1230 + ( 0.25 * mix( mix( fract( ( ( nodeVar1233.x + nodeVar1233.y ) * nodeVar1233.z ) ), fract( ( ( nodeVar1234.x + nodeVar1234.y ) * nodeVar1234.z ) ), nodeVar1232.x ), mix( fract( ( ( nodeVar1235.x + nodeVar1235.y ) * nodeVar1235.z ) ), fract( ( ( nodeVar1236.x + nodeVar1236.y ) * nodeVar1236.z ) ), nodeVar1232.x ), nodeVar1232.y ) ) );
					nodeVar1223 = ( ( nodeVar1223 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
					nodeVar1237 = floor( nodeVar1223 );
					nodeVar1238 = fract( nodeVar1223 );
					nodeVar1238 = ( ( nodeVar1238 * nodeVar1238 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1238 ) ) );
					nodeVar1239 = fract( ( vec3<f32>( nodeVar1237, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1239 = ( nodeVar1239 + vec3<f32>( dot( nodeVar1239, ( nodeVar1239.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1240 = fract( ( vec3<f32>( ( nodeVar1237 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1240 = ( nodeVar1240 + vec3<f32>( dot( nodeVar1240, ( nodeVar1240.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1241 = fract( ( vec3<f32>( ( nodeVar1237 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1241 = ( nodeVar1241 + vec3<f32>( dot( nodeVar1241, ( nodeVar1241.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1242 = fract( ( vec3<f32>( ( nodeVar1237 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1242 = ( nodeVar1242 + vec3<f32>( dot( nodeVar1242, ( nodeVar1242.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1230 = ( nodeVar1230 + ( 0.125 * mix( mix( fract( ( ( nodeVar1239.x + nodeVar1239.y ) * nodeVar1239.z ) ), fract( ( ( nodeVar1240.x + nodeVar1240.y ) * nodeVar1240.z ) ), nodeVar1238.x ), mix( fract( ( ( nodeVar1241.x + nodeVar1241.y ) * nodeVar1241.z ) ), fract( ( ( nodeVar1242.x + nodeVar1242.y ) * nodeVar1242.z ) ), nodeVar1238.x ), nodeVar1238.y ) ) );
					nodeVar1243 = ( ( nodeVar1223 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
					nodeVar1244 = floor( nodeVar1243 );
					nodeVar1245 = fract( nodeVar1243 );
					nodeVar1245 = ( ( nodeVar1245 * nodeVar1245 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1245 ) ) );
					nodeVar1246 = fract( ( vec3<f32>( nodeVar1244, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1246 = ( nodeVar1246 + vec3<f32>( dot( nodeVar1246, ( nodeVar1246.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1247 = fract( ( vec3<f32>( ( nodeVar1244 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1247 = ( nodeVar1247 + vec3<f32>( dot( nodeVar1247, ( nodeVar1247.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1248 = fract( ( vec3<f32>( ( nodeVar1244 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1248 = ( nodeVar1248 + vec3<f32>( dot( nodeVar1248, ( nodeVar1248.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1249 = fract( ( vec3<f32>( ( nodeVar1244 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
					nodeVar1249 = ( nodeVar1249 + vec3<f32>( dot( nodeVar1249, ( nodeVar1249.yzx + vec3<f32>( 33.33 ) ) ) ) );
					nodeVar1250 = ( smoothstep( 0.46, 0.66, ( nodeVar1230 + ( 0.0625 * mix( mix( fract( ( ( nodeVar1246.x + nodeVar1246.y ) * nodeVar1246.z ) ), fract( ( ( nodeVar1247.x + nodeVar1247.y ) * nodeVar1247.z ) ), nodeVar1245.x ), mix( fract( ( ( nodeVar1248.x + nodeVar1248.y ) * nodeVar1248.z ) ), fract( ( ( nodeVar1249.x + nodeVar1249.y ) * nodeVar1249.z ) ), nodeVar1245.x ), nodeVar1245.y ) ) ) ) * smoothstep( 0.4, 0.9, nodeVar216.y ) );
					nodeVar1222 = ( mix( vec3<f32>( 0.075, 0.091, 0.09 ), vec3<f32>( 0.038, 0.068, 0.042 ), nodeVar1250 ) * vec3<f32>( ( 0.7 + nodeVar1221 ) ) );
					

				} else {


					if ( ( nodeVar213 < 2.5 ) ) {

						nodeVar1251 = ( ( nodeVar214.xz * vec2<f32>( 5.0 ) ) + vec2<f32>( nodeVar214.y ) );
						nodeVar1252 = floor( nodeVar1251 );
						nodeVar1253 = fract( nodeVar1251 );
						nodeVar1253 = ( ( nodeVar1253 * nodeVar1253 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1253 ) ) );
						nodeVar1254 = fract( ( vec3<f32>( nodeVar1252, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar1254 = ( nodeVar1254 + vec3<f32>( dot( nodeVar1254, ( nodeVar1254.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar1255 = fract( ( vec3<f32>( ( nodeVar1252 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar1255 = ( nodeVar1255 + vec3<f32>( dot( nodeVar1255, ( nodeVar1255.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar1256 = fract( ( vec3<f32>( ( nodeVar1252 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar1256 = ( nodeVar1256 + vec3<f32>( dot( nodeVar1256, ( nodeVar1256.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar1257 = fract( ( vec3<f32>( ( nodeVar1252 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
						nodeVar1257 = ( nodeVar1257 + vec3<f32>( dot( nodeVar1257, ( nodeVar1257.yzx + vec3<f32>( 33.33 ) ) ) ) );
						nodeVar1222 = ( mix( vec3<f32>( 0.017, 0.034, 0.027 ), vec3<f32>( 0.045, 0.071, 0.047 ), mix( mix( fract( ( ( nodeVar1254.x + nodeVar1254.y ) * nodeVar1254.z ) ), fract( ( ( nodeVar1255.x + nodeVar1255.y ) * nodeVar1255.z ) ), nodeVar1253.x ), mix( fract( ( ( nodeVar1256.x + nodeVar1256.y ) * nodeVar1256.z ) ), fract( ( ( nodeVar1257.x + nodeVar1257.y ) * nodeVar1257.z ) ), nodeVar1253.x ), nodeVar1253.y ) ) * vec3<f32>( ( 0.8 + ( max( nodeVar216.y, 0.0 ) * 0.35 ) ) ) );
						

					} else {


						if ( ( nodeVar213 < 3.5 ) ) {

							nodeVar1222 = vec3<f32>( 0.06, 0.047, 0.036 );
							

						} else {


							if ( ( nodeVar213 < 4.5 ) ) {

								nodeVar1222 = ( vec3<f32>( 0.12, 0.155, 0.17 ) * vec3<f32>( ( 0.8 + nodeVar1221 ) ) );
								

							} else {


								if ( ( nodeVar213 > 8.5 ) ) {

									nodeVar1258 = ( 0.75 + ( 0.25 * smoothstep( 0.01, 0.1, abs( ( fract( ( nodeVar214.x * 3.0 ) ) - 0.5 ) ) ) ) );
									nodeVar1222 = ( vec3<f32>( 0.09, 0.13, 0.14 ) * vec3<f32>( nodeVar1258 ) );
									

								}

								

							}

							

						}

						

					}

					

				}

				nodeVar1259 = ( nodeVar1222 * ( ( frame.nodeUniform13 * vec3<f32>( nodeVar1206 ) ) + ( frame.nodeUniform14 * vec3<f32>( max( dot( nodeVar216, frame.nodeUniform15 ), 0.0 ) ) ) ) );
				nodeVar1259 = ( nodeVar1259 + ( ( ( nodeVar1222 * vec3<f32>( frame.nodeUniform16 ) ) * vec3<f32>( ( 0.6 + ( max( dot( nodeVar216, normalize( ( frame.nodeUniform17 - nodeVar214 ) ) ), 0.0 ) * 2.5 ) ) ) ) * frame.nodeUniform18 ) );

				for ( var i : i32 = 0; i < 6; i ++ ) {

					nodeVar1260 = ( -10.0 - ( f32( i ) * 38.0 ) );
					nodeVar1261 = vec3<f32>( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar1260 * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar1260 ) ) ) ) - 3.9 ), 7.87, nodeVar1260 );
					nodeVar1262 = ( nodeVar1261 - nodeVar214 );
					nodeVar1263 = dot( nodeVar1262, nodeVar1262 );
					nodeVar1262 = normalize( nodeVar1262 );
					nodeVar1264 = max( dot( nodeVar216, nodeVar1262 ), 0.0 );
					nodeVar1265 = ( smoothstep( 0.1, 0.62, ( - nodeVar1262.y ) ) * smoothstep( -0.1, 0.1, nodeVar1262.y ) );
					nodeVar1266 = ( 48.0 / ( 1.0 + nodeVar1263 ) );
					nodeVar1267 = frame.nodeUniform19;
					nodeVar1259 = ( nodeVar1259 + ( ( ( ( nodeVar1222 * nodeVar1267 ) * vec3<f32>( nodeVar1266 ) ) * vec3<f32>( nodeVar1264 ) ) * vec3<f32>( 2.0 ) ) );
					nodeVar1268 = normalize( ( nodeVar1262 + ( - nodeVar2 ) ) );

					if ( ( nodeVar213 > 3.5 ) ) {

						nodeVar1269 = 0.28;

					} else {

						nodeVar1269 = 0.88;

					}

					nodeVar1270 = mix( 20.0, 900.0, ( 1.0 - nodeVar1269 ) );
					nodeVar1271 = ( ( pow( max( dot( nodeVar216, nodeVar1268 ), 0.0 ), nodeVar1270 ) * ( nodeVar1270 + 2.0 ) ) * 0.018 );

					if ( ( nodeVar1269 > 0.55 ) ) {

						nodeVar1272 = 0.022;

					} else {

						nodeVar1272 = 1.0;

					}

					nodeVar1259 = ( nodeVar1259 + ( ( ( ( nodeVar1267 * vec3<f32>( nodeVar1271 ) ) * vec3<f32>( nodeVar1266 ) ) * vec3<f32>( nodeVar1264 ) ) * vec3<f32>( nodeVar1272 ) ) );

				}

				nodeVar217 = nodeVar1259;
				

			}

			nodeVar1273 = ( ( nodeVar214.xz * vec2<f32>( 0.009 ) ) + vec2<f32>( 4.0, 9.0 ) );
			nodeVar1274 = floor( nodeVar1273 );
			nodeVar1275 = fract( nodeVar1273 );
			nodeVar1275 = ( ( nodeVar1275 * nodeVar1275 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1275 ) ) );
			nodeVar1276 = fract( ( vec3<f32>( nodeVar1274, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1276 = ( nodeVar1276 + vec3<f32>( dot( nodeVar1276, ( nodeVar1276.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1277 = fract( ( vec3<f32>( ( nodeVar1274 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1277 = ( nodeVar1277 + vec3<f32>( dot( nodeVar1277, ( nodeVar1277.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1278 = fract( ( vec3<f32>( ( nodeVar1274 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1278 = ( nodeVar1278 + vec3<f32>( dot( nodeVar1278, ( nodeVar1278.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1279 = fract( ( vec3<f32>( ( nodeVar1274 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1279 = ( nodeVar1279 + vec3<f32>( dot( nodeVar1279, ( nodeVar1279.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1280 = ( 0.5 * mix( mix( fract( ( ( nodeVar1276.x + nodeVar1276.y ) * nodeVar1276.z ) ), fract( ( ( nodeVar1277.x + nodeVar1277.y ) * nodeVar1277.z ) ), nodeVar1275.x ), mix( fract( ( ( nodeVar1278.x + nodeVar1278.y ) * nodeVar1278.z ) ), fract( ( ( nodeVar1279.x + nodeVar1279.y ) * nodeVar1279.z ) ), nodeVar1275.x ), nodeVar1275.y ) );
			nodeVar1273 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar1273 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
			nodeVar1281 = floor( nodeVar1273 );
			nodeVar1282 = fract( nodeVar1273 );
			nodeVar1282 = ( ( nodeVar1282 * nodeVar1282 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1282 ) ) );
			nodeVar1283 = fract( ( vec3<f32>( nodeVar1281, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1283 = ( nodeVar1283 + vec3<f32>( dot( nodeVar1283, ( nodeVar1283.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1284 = fract( ( vec3<f32>( ( nodeVar1281 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1284 = ( nodeVar1284 + vec3<f32>( dot( nodeVar1284, ( nodeVar1284.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1285 = fract( ( vec3<f32>( ( nodeVar1281 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1285 = ( nodeVar1285 + vec3<f32>( dot( nodeVar1285, ( nodeVar1285.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1286 = fract( ( vec3<f32>( ( nodeVar1281 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1286 = ( nodeVar1286 + vec3<f32>( dot( nodeVar1286, ( nodeVar1286.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1280 = ( nodeVar1280 + ( 0.25 * mix( mix( fract( ( ( nodeVar1283.x + nodeVar1283.y ) * nodeVar1283.z ) ), fract( ( ( nodeVar1284.x + nodeVar1284.y ) * nodeVar1284.z ) ), nodeVar1282.x ), mix( fract( ( ( nodeVar1285.x + nodeVar1285.y ) * nodeVar1285.z ) ), fract( ( ( nodeVar1286.x + nodeVar1286.y ) * nodeVar1286.z ) ), nodeVar1282.x ), nodeVar1282.y ) ) );
			nodeVar1273 = ( ( nodeVar1273 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
			nodeVar1287 = floor( nodeVar1273 );
			nodeVar1288 = fract( nodeVar1273 );
			nodeVar1288 = ( ( nodeVar1288 * nodeVar1288 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1288 ) ) );
			nodeVar1289 = fract( ( vec3<f32>( nodeVar1287, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1289 = ( nodeVar1289 + vec3<f32>( dot( nodeVar1289, ( nodeVar1289.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1290 = fract( ( vec3<f32>( ( nodeVar1287 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1290 = ( nodeVar1290 + vec3<f32>( dot( nodeVar1290, ( nodeVar1290.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1291 = fract( ( vec3<f32>( ( nodeVar1287 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1291 = ( nodeVar1291 + vec3<f32>( dot( nodeVar1291, ( nodeVar1291.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1292 = fract( ( vec3<f32>( ( nodeVar1287 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1292 = ( nodeVar1292 + vec3<f32>( dot( nodeVar1292, ( nodeVar1292.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1280 = ( nodeVar1280 + ( 0.125 * mix( mix( fract( ( ( nodeVar1289.x + nodeVar1289.y ) * nodeVar1289.z ) ), fract( ( ( nodeVar1290.x + nodeVar1290.y ) * nodeVar1290.z ) ), nodeVar1288.x ), mix( fract( ( ( nodeVar1291.x + nodeVar1291.y ) * nodeVar1291.z ) ), fract( ( ( nodeVar1292.x + nodeVar1292.y ) * nodeVar1292.z ) ), nodeVar1288.x ), nodeVar1288.y ) ) );
			nodeVar1293 = ( ( nodeVar1273 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
			nodeVar1294 = floor( nodeVar1293 );
			nodeVar1295 = fract( nodeVar1293 );
			nodeVar1295 = ( ( nodeVar1295 * nodeVar1295 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1295 ) ) );
			nodeVar1296 = fract( ( vec3<f32>( nodeVar1294, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1296 = ( nodeVar1296 + vec3<f32>( dot( nodeVar1296, ( nodeVar1296.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1297 = fract( ( vec3<f32>( ( nodeVar1294 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1297 = ( nodeVar1297 + vec3<f32>( dot( nodeVar1297, ( nodeVar1297.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1298 = fract( ( vec3<f32>( ( nodeVar1294 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1298 = ( nodeVar1298 + vec3<f32>( dot( nodeVar1298, ( nodeVar1298.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1299 = fract( ( vec3<f32>( ( nodeVar1294 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1299 = ( nodeVar1299 + vec3<f32>( dot( nodeVar1299, ( nodeVar1299.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1300 = ( nodeVar1280 + ( 0.0625 * mix( mix( fract( ( ( nodeVar1296.x + nodeVar1296.y ) * nodeVar1296.z ) ), fract( ( ( nodeVar1297.x + nodeVar1297.y ) * nodeVar1297.z ) ), nodeVar1295.x ), mix( fract( ( ( nodeVar1298.x + nodeVar1298.y ) * nodeVar1298.z ) ), fract( ( ( nodeVar1299.x + nodeVar1299.y ) * nodeVar1299.z ) ), nodeVar1295.x ), nodeVar1295.y ) ) );
			nodeVar1301 = ( nodeVar214.xz * vec2<f32>( 0.018 ) );
			nodeVar1302 = floor( nodeVar1301 );
			nodeVar1303 = fract( nodeVar1301 );
			nodeVar1303 = ( ( nodeVar1303 * nodeVar1303 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1303 ) ) );
			nodeVar1304 = fract( ( vec3<f32>( nodeVar1302, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1304 = ( nodeVar1304 + vec3<f32>( dot( nodeVar1304, ( nodeVar1304.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1305 = fract( ( vec3<f32>( ( nodeVar1302 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1305 = ( nodeVar1305 + vec3<f32>( dot( nodeVar1305, ( nodeVar1305.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1306 = fract( ( vec3<f32>( ( nodeVar1302 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1306 = ( nodeVar1306 + vec3<f32>( dot( nodeVar1306, ( nodeVar1306.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1307 = fract( ( vec3<f32>( ( nodeVar1302 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
			nodeVar1307 = ( nodeVar1307 + vec3<f32>( dot( nodeVar1307, ( nodeVar1307.yzx + vec3<f32>( 33.33 ) ) ) ) );
			nodeVar1308 = ( 1.0 - abs( ( ( mix( mix( fract( ( ( nodeVar1304.x + nodeVar1304.y ) * nodeVar1304.z ) ), fract( ( ( nodeVar1305.x + nodeVar1305.y ) * nodeVar1305.z ) ), nodeVar1303.x ), mix( fract( ( ( nodeVar1306.x + nodeVar1306.y ) * nodeVar1306.z ) ), fract( ( ( nodeVar1307.x + nodeVar1307.y ) * nodeVar1307.z ) ), nodeVar1303.x ), nodeVar1303.y ) * 2.0 ) - 1.0 ) ) );
			nodeVar1309 = ( smoothstep( 13.0, 155.0, ( - nodeVar214.xz.x ) ) * ( ( 28.0 + ( nodeVar1300 * 135.0 ) ) + ( nodeVar1308 * 20.0 ) ) );
			nodeVar1310 = ( smoothstep( 280.0, 670.0, ( - nodeVar214.xz.y ) ) * ( ( 46.0 + ( nodeVar1300 * 155.0 ) ) + ( nodeVar1308 * 22.0 ) ) );
			nodeVar1311 = ( smoothstep( 190.0, 430.0, nodeVar214.xz.x ) * ( 30.0 + ( nodeVar1300 * 95.0 ) ) );
			nodeVar1312 = max( max( nodeVar1309, nodeVar1310 ), nodeVar1311 );
			nodeVar1313 = ( exp( ( - dot( ( ( nodeVar214.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ), ( ( nodeVar214.xz - vec2<f32>( 94.0, -205.0 ) ) / vec2<f32>( 39.0, 48.0 ) ) ) ) ) * ( 18.0 + ( nodeVar1300 * 10.0 ) ) );
			nodeVar1312 = max( nodeVar1312, nodeVar1313 );

			if ( ( nodeVar1312 < 1.5 ) ) {


				if ( ( nodeVar214.xz.x > ( ( ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.xz.y ) ) ) ) + 9.2 ) + ( sin( ( nodeVar214.xz.y * 0.023 ) ) * 1.8 ) ) ) ) {

					nodeVar1314 = -1.2;

				} else {

					nodeVar1314 = ( 0.1 + ( nodeVar1300 * 0.2 ) );

				}

				nodeVar1312 = nodeVar1314;
				

			}


			if ( ( ( nodeVar214.xz.y > -175.0 ) && ( abs( ( nodeVar214.xz.x - ( ( -1.6 + ( 2.1 * sin( ( nodeVar214.xz.y * 0.012 ) ) ) ) + ( 15.0 * ( 1.0 - smoothstep( -420.0, -150.0, nodeVar214.xz.y ) ) ) ) ) ) < 7.3 ) ) ) {

				nodeVar1312 = 0.0;
				

			}

			nodeVar1315 = clamp( ( ( ( nodeVar214.y - nodeVar1312 ) * 0.09 ) + 0.5 ), 0.4, 1.0 );

			if ( ( nodeVar213 != 6.0 ) ) {

				nodeVar217 = ( nodeVar217 * vec3<f32>( nodeVar1315 ) );
				

			}

			

		}

		

	}


	if ( ( ( nodeVar213 > 0.0 ) || nodeVar218 ) ) {

		nodeVar1316 = ( ( nodeVar214.xz * vec2<f32>( 0.012 ) ) + vec2<f32>( ( frame.nodeUniform9 * 0.014 ), 0.0 ) );
		nodeVar1317 = floor( nodeVar1316 );
		nodeVar1318 = fract( nodeVar1316 );
		nodeVar1318 = ( ( nodeVar1318 * nodeVar1318 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1318 ) ) );
		nodeVar1319 = fract( ( vec3<f32>( nodeVar1317, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1319 = ( nodeVar1319 + vec3<f32>( dot( nodeVar1319, ( nodeVar1319.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1320 = fract( ( vec3<f32>( ( nodeVar1317 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1320 = ( nodeVar1320 + vec3<f32>( dot( nodeVar1320, ( nodeVar1320.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1321 = fract( ( vec3<f32>( ( nodeVar1317 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1321 = ( nodeVar1321 + vec3<f32>( dot( nodeVar1321, ( nodeVar1321.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1322 = fract( ( vec3<f32>( ( nodeVar1317 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1322 = ( nodeVar1322 + vec3<f32>( dot( nodeVar1322, ( nodeVar1322.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1323 = ( 0.5 * mix( mix( fract( ( ( nodeVar1319.x + nodeVar1319.y ) * nodeVar1319.z ) ), fract( ( ( nodeVar1320.x + nodeVar1320.y ) * nodeVar1320.z ) ), nodeVar1318.x ), mix( fract( ( ( nodeVar1321.x + nodeVar1321.y ) * nodeVar1321.z ) ), fract( ( ( nodeVar1322.x + nodeVar1322.y ) * nodeVar1322.z ) ), nodeVar1318.x ), nodeVar1318.y ) );
		nodeVar1316 = ( ( ( mat2x2<f32>( 0.8, -0.6, 0.6, 0.8 ) * nodeVar1316 ) * vec2<f32>( 2.03 ) ) + vec2<f32>( 19.1 ) );
		nodeVar1324 = floor( nodeVar1316 );
		nodeVar1325 = fract( nodeVar1316 );
		nodeVar1325 = ( ( nodeVar1325 * nodeVar1325 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1325 ) ) );
		nodeVar1326 = fract( ( vec3<f32>( nodeVar1324, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1326 = ( nodeVar1326 + vec3<f32>( dot( nodeVar1326, ( nodeVar1326.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1327 = fract( ( vec3<f32>( ( nodeVar1324 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1327 = ( nodeVar1327 + vec3<f32>( dot( nodeVar1327, ( nodeVar1327.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1328 = fract( ( vec3<f32>( ( nodeVar1324 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1328 = ( nodeVar1328 + vec3<f32>( dot( nodeVar1328, ( nodeVar1328.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1329 = fract( ( vec3<f32>( ( nodeVar1324 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1329 = ( nodeVar1329 + vec3<f32>( dot( nodeVar1329, ( nodeVar1329.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1323 = ( nodeVar1323 + ( 0.25 * mix( mix( fract( ( ( nodeVar1326.x + nodeVar1326.y ) * nodeVar1326.z ) ), fract( ( ( nodeVar1327.x + nodeVar1327.y ) * nodeVar1327.z ) ), nodeVar1325.x ), mix( fract( ( ( nodeVar1328.x + nodeVar1328.y ) * nodeVar1328.z ) ), fract( ( ( nodeVar1329.x + nodeVar1329.y ) * nodeVar1329.z ) ), nodeVar1325.x ), nodeVar1325.y ) ) );
		nodeVar1316 = ( ( nodeVar1316 * vec2<f32>( 2.02 ) ) + vec2<f32>( 9.3 ) );
		nodeVar1330 = floor( nodeVar1316 );
		nodeVar1331 = fract( nodeVar1316 );
		nodeVar1331 = ( ( nodeVar1331 * nodeVar1331 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1331 ) ) );
		nodeVar1332 = fract( ( vec3<f32>( nodeVar1330, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1332 = ( nodeVar1332 + vec3<f32>( dot( nodeVar1332, ( nodeVar1332.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1333 = fract( ( vec3<f32>( ( nodeVar1330 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1333 = ( nodeVar1333 + vec3<f32>( dot( nodeVar1333, ( nodeVar1333.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1334 = fract( ( vec3<f32>( ( nodeVar1330 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1334 = ( nodeVar1334 + vec3<f32>( dot( nodeVar1334, ( nodeVar1334.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1335 = fract( ( vec3<f32>( ( nodeVar1330 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1335 = ( nodeVar1335 + vec3<f32>( dot( nodeVar1335, ( nodeVar1335.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1323 = ( nodeVar1323 + ( 0.125 * mix( mix( fract( ( ( nodeVar1332.x + nodeVar1332.y ) * nodeVar1332.z ) ), fract( ( ( nodeVar1333.x + nodeVar1333.y ) * nodeVar1333.z ) ), nodeVar1331.x ), mix( fract( ( ( nodeVar1334.x + nodeVar1334.y ) * nodeVar1334.z ) ), fract( ( ( nodeVar1335.x + nodeVar1335.y ) * nodeVar1335.z ) ), nodeVar1331.x ), nodeVar1331.y ) ) );
		nodeVar1336 = ( ( nodeVar1316 * vec2<f32>( 2.01 ) ) + vec2<f32>( 17.0 ) );
		nodeVar1337 = floor( nodeVar1336 );
		nodeVar1338 = fract( nodeVar1336 );
		nodeVar1338 = ( ( nodeVar1338 * nodeVar1338 ) * ( vec2<f32>( 3.0 ) - ( vec2<f32>( 2.0 ) * nodeVar1338 ) ) );
		nodeVar1339 = fract( ( vec3<f32>( nodeVar1337, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1339 = ( nodeVar1339 + vec3<f32>( dot( nodeVar1339, ( nodeVar1339.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1340 = fract( ( vec3<f32>( ( nodeVar1337 + vec2<f32>( 1.0, 0.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1340 = ( nodeVar1340 + vec3<f32>( dot( nodeVar1340, ( nodeVar1340.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1341 = fract( ( vec3<f32>( ( nodeVar1337 + vec2<f32>( 0.0, 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1341 = ( nodeVar1341 + vec3<f32>( dot( nodeVar1341, ( nodeVar1341.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1342 = fract( ( vec3<f32>( ( nodeVar1337 + vec2<f32>( 1.0 ) ), 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar1342 = ( nodeVar1342 + vec3<f32>( dot( nodeVar1342, ( nodeVar1342.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar1343 = ( 0.8 + ( 0.4 * ( nodeVar1323 + ( 0.0625 * mix( mix( fract( ( ( nodeVar1339.x + nodeVar1339.y ) * nodeVar1339.z ) ), fract( ( ( nodeVar1340.x + nodeVar1340.y ) * nodeVar1340.z ) ), nodeVar1338.x ), mix( fract( ( ( nodeVar1341.x + nodeVar1341.y ) * nodeVar1341.z ) ), fract( ( ( nodeVar1342.x + nodeVar1342.y ) * nodeVar1342.z ) ), nodeVar1338.x ), nodeVar1338.y ) ) ) ) );
		nodeVar1344 = ( 1.0 - exp( ( ( ( ( - nodeVar212 ) * ( 0.0011 + ( frame.nodeUniform24 * 0.0048 ) ) ) * nodeVar1343 ) * exp( ( ( - max( nodeVar214.y, 0.0 ) ) * 0.008 ) ) ) ) );
		nodeVar217 = mix( nodeVar217, ( mix( frame.nodeUniform22, frame.nodeUniform23, smoothstep( 0.0, 0.7, abs( nodeVar2.y ) ) ) + ( vec3<f32>( frame.nodeUniform16 ) * vec3<f32>( 0.11, 0.16, 0.24 ) ) ), clamp( nodeVar1344, 0.0, 0.98 ) );
		nodeVar1345 = max( 0.15, ( nodeVar212 * dot( nodeVar2, frame.nodeUniform2 ) ) );
		nodeVar0 = clamp( ( 1.00006 - ( 0.150009 / nodeVar1345 ) ), 0.0, 0.999999 );
		

	} else {

		nodeVar0 = 1.0;
		

	}

	nodeVar1346 = vec4<f32>( max( nodeVar217, vec3<f32>( 0.0, 0.0, 0.0 ) ), nodeVar0 );
	output.depth = clamp( ( ( ( ( ( render.cameraNear + render.cameraFar ) - ( ( ( render.cameraNear * render.cameraFar ) * 2.0 ) / ( 0.150009 / ( 1.00006 - nodeVar1346.w ) ) ) ) / ( render.cameraFar - render.cameraNear ) ) + 1.0 ) * 0.5 ), 0.0, 1.0 );

	// result

	output.color = vec4<f32>( nodeVar1346.xyz, 1.0 );

	return output;

}
