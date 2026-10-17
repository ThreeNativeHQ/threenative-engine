WGSLDUMP vertex
// Three.js r185 - Node System

// directives


// structs


// uniforms

struct frameStruct {
	nodeUniform2 : f32,
	nodeUniform1 : f32,
	nodeUniform3 : f32,
	nodeUniform0 : f32,
	nodeUniform6 : f32,
	nodeUniform7 : f32,
	nodeUniform4 : vec3<f32>,
	nodeUniform11 : vec3<f32>,
	nodeUniform5 : vec3<f32>,
	nodeUniform8 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> frame : frameStruct;

struct renderStruct {
	cameraNear : f32,
	cameraFar : f32
};
@binding( 0 ) @group( 1 )
var<uniform> render : renderStruct;

struct objectStruct {
	nodeUniform12 : vec2<f32>
};
@binding( 0 ) @group( 2 )
var<uniform> object : objectStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) vAcross : f32,
	@location( 1 ) vAlong : f32,
	@location( 2 ) vOpacity : f32,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar0 : f32;
var<private> nodeVar1 : vec3<f32>;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : vec3<f32>;
var<private> nodeVar6 : vec3<f32>;
var<private> nodeVar7 : f32;
var<private> nodeVar8 : vec4<f32>;
var<private> nodeVar9 : vec4<f32>;
var<private> nodeVar10 : vec3<f32>;
var<private> nodeVar11 : f32;
var<private> nodeVar12 : vec4<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : vec2<f32>;
var<private> nodeVar15 : vec2<f32>;

// codes
fn tsl_mod_float( x : f32, y : f32 ) -> f32 { return x - y * floor( x / y ); }


@vertex
fn main( @builtin( instance_index ) instanceIndex : u32,
	@location( 0 ) position : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	varyings.vAcross = position.xy.x;
	varyings.vAlong = position.xy.y;
	nodeVar0 = fract( ( sin( ( ( f32( instanceIndex ) + 1.0 ) * 127.1 ) ) * 43758.5453123 ) );
	nodeVar1 = vec3<f32>( ( ( fract( ( sin( ( ( ( f32( instanceIndex ) * 3.1 ) + 2.0 ) * 127.1 ) ) * 43758.5453123 ) ) * 66.0 ) - 33.0 ), ( fract( ( sin( ( ( ( f32( instanceIndex ) * 7.3 ) + 5.0 ) * 127.1 ) ) * 43758.5453123 ) ) * 30.0 ), ( ( fract( ( sin( ( ( ( f32( instanceIndex ) * 5.7 ) + 8.0 ) * 127.1 ) ) * 43758.5453123 ) ) * 66.0 ) - 33.0 ) );
	nodeVar2 = ( frame.nodeUniform2 + ( nodeVar0 * 10.0 ) );
	nodeVar3 = ( 14.0 + ( nodeVar0 * 8.0 ) );
	nodeVar4 = ( vec3<f32>( ( tsl_mod_float( ( ( nodeVar1.x + ( ( nodeVar2 * frame.nodeUniform3 ) * 20.0 ) ) + 33.0 ), 66.0 ) - 33.0 ), ( tsl_mod_float( ( nodeVar1.y - ( nodeVar2 * nodeVar3 ) ), 30.0 ) - 0.45 ), ( tsl_mod_float( ( ( nodeVar1.z + ( ( nodeVar2 * frame.nodeUniform3 ) * 2.0 ) ) + 33.0 ), 66.0 ) - 33.0 ) ) + vec3<f32>( ( floor( ( frame.nodeUniform4.x / 12.0 ) ) * 12.0 ), 0.0, ( floor( ( frame.nodeUniform4.z / 12.0 ) ) * 12.0 ) ) );
	nodeVar5 = vec3<f32>( nodeVar4.x, ( nodeVar4.y + max( ( frame.nodeUniform4.y - 5.0 ), 0.0 ) ), nodeVar4.z );
	nodeVar6 = ( nodeVar5 - frame.nodeUniform4 );
	nodeVar7 = dot( nodeVar6, frame.nodeUniform11 );
	nodeVar8 = vec4<f32>( ( dot( nodeVar6, frame.nodeUniform5 ) / ( frame.nodeUniform6 * frame.nodeUniform7 ) ), ( dot( nodeVar6, frame.nodeUniform8 ) / frame.nodeUniform7 ), ( clamp( ( ( ( ( ( render.cameraNear + render.cameraFar ) - ( ( ( render.cameraNear * render.cameraFar ) * 2.0 ) / nodeVar7 ) ) / ( render.cameraFar - render.cameraNear ) ) + 1.0 ) * 0.5 ), 0.0, 1.0 ) * nodeVar7 ), nodeVar7 );
	varyings.vOpacity = ( ( ( ( 0.07 + ( nodeVar0 * 0.14 ) ) * frame.nodeUniform1 ) * smoothstep( 0.3, 1.8, nodeVar8.w ) ) * ( 1.0 - smoothstep( 12.0, 43.0, nodeVar8.w ) ) );
	nodeVar10 = ( ( nodeVar5 - ( vec3<f32>( ( frame.nodeUniform3 * 20.0 ), ( - nodeVar3 ), ( frame.nodeUniform3 * 2.0 ) ) * vec3<f32>( ( 0.013 + ( nodeVar0 * 0.011 ) ) ) ) ) - frame.nodeUniform4 );
	nodeVar11 = dot( nodeVar10, frame.nodeUniform11 );
	nodeVar12 = vec4<f32>( ( dot( nodeVar10, frame.nodeUniform5 ) / ( frame.nodeUniform6 * frame.nodeUniform7 ) ), ( dot( nodeVar10, frame.nodeUniform8 ) / frame.nodeUniform7 ), ( clamp( ( ( ( ( ( render.cameraNear + render.cameraFar ) - ( ( ( render.cameraNear * render.cameraFar ) * 2.0 ) / nodeVar11 ) ) / ( render.cameraFar - render.cameraNear ) ) + 1.0 ) * 0.5 ), 0.0, 1.0 ) * nodeVar11 ), nodeVar11 );

	if ( ( ( nodeVar8.w < 0.4 ) || ( nodeVar12.w < 0.4 ) ) ) {

		nodeVar9 = vec4<f32>( 2.0, 2.0, 2.0, 1.0 );

	} else {

		nodeVar13 = mix( nodeVar8, nodeVar12, position.xy.y );
		nodeVar14 = normalize( ( ( ( ( nodeVar12.xy / vec2<f32>( max( nodeVar12.w, 0.1 ) ) ) - ( nodeVar8.xy / vec2<f32>( max( nodeVar8.w, 0.1 ) ) ) ) * object.nodeUniform12 ) + vec2<f32>( 0.0001 ) ) );
		nodeVar15 = ( ( ( ( ( vec2<f32>( ( - nodeVar14.y ), nodeVar14.x ) * vec2<f32>( position.xy.x ) ) * vec2<f32>( mix( 0.42, 0.85, nodeVar0 ) ) ) / object.nodeUniform12 ) * vec2<f32>( nodeVar13.w ) ) * vec2<f32>( 2.0 ) );
		nodeVar9 = ( nodeVar13 + vec4<f32>( nodeVar15.x, nodeVar15.y, 0.0, 0.0 ) );

	}


	// result

	varyings.builtinClipSpace = nodeVar9;

	return varyings;

}
