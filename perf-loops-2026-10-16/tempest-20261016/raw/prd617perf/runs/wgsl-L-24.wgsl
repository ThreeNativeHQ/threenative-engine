WGSLDUMP fragment_RenderPipeline
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 2 ) var nodeUniform4_sampler : sampler;
@binding( 1 ) @group( 2 ) var nodeUniform4 : texture_2d<f32>;
@binding( 2 ) @group( 2 ) var nodeUniform5_sampler : sampler;
@binding( 3 ) @group( 2 ) var nodeUniform5 : texture_2d<f32>;

struct frameStruct {
	nodeUniform2 : vec2<f32>,
	nodeUniform1 : f32,
	nodeUniform6 : f32,
	nodeUniform3 : f32,
	nodeUniform0 : f32
};
@binding( 0 ) @group( 0 )
var<uniform> frame : frameStruct;

struct renderStruct {
	cameraNear : f32,
	cameraFar : f32,
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> render : renderStruct;

// vars
var<private> nodeVar0 : vec2<f32>;
var<private> nodeVar1 : vec2<f32>;
var<private> nodeVar2 : f32;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : vec2<f32>;
var<private> nodeVar5 : vec2<f32>;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : f32;
var<private> nodeVar8 : f32;
var<private> nodeVar9 : vec2<f32>;
var<private> nodeVar10 : vec2<f32>;
var<private> nodeVar11 : vec4<f32>;
var<private> nodeVar12 : vec3<f32>;
var<private> nodeVar13 : vec4<f32>;
var<private> nodeVar14 : vec3<f32>;
var<private> nodeVar15 : vec4<f32>;
var<private> nodeVar16 : vec3<f32>;
var<private> nodeVar17 : vec4<f32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec4<f32>;
var<private> nodeVar20 : vec3<f32>;
var<private> nodeVar21 : vec3<f32>;
var<private> nodeVar22 : f32;
var<private> nodeVar23 : f32;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : vec2<f32>;
var<private> nodeVar28 : f32;
var<private> nodeVar29 : f32;
var<private> nodeVar30 : vec4<f32>;
var<private> nodeVar31 : vec4<f32>;
var<private> nodeVar32 : vec3<f32>;
var<private> nodeVar33 : vec4<f32>;
var<private> nodeVar34 : vec4<f32>;
var<private> nodeVar35 : vec3<f32>;
var<private> nodeVar36 : f32;
var<private> nodeVar37 : f32;
var<private> nodeVar38 : f32;
var<private> nodeVar39 : vec3<f32>;
var<private> nodeVar40 : vec3<f32>;
var<private> nodeVar41 : vec3<f32>;
var<private> nodeVar42 : f32;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : vec4<f32>;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec4<f32>;

// codes
fn fn1 ( color : vec4<f32> ) -> vec4<f32> {

	var nodeVar0 : vec4<f32>;


	if ( ( color.w == 0.0 ) ) {

		nodeVar0 = vec4<f32>( 0.0, 0.0, 0.0, 0.0 );

	} else {

		nodeVar0 = vec4<f32>( ( color.xyz / vec3<f32>( color.w ) ), color.w );

	}


	return nodeVar0;

}

fn fn0 ( color : vec4<f32> ) -> vec4<f32> {

	


	return vec4<f32>( ( color.xyz * vec3<f32>( color.w ) ), color.w );

}



@fragment
fn main( @location( 0 ) v_positionView : vec3<f32>,
	@location( 1 ) nodeVarying4 : vec2<f32>,
	@builtin( position ) fragCoord : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = nodeVarying4;
	nodeVar1 = vec2<f32>( 0.0, 0.0 );
	nodeVar2 = 0.0;

	if ( ( frame.nodeUniform0 > 0.5 ) ) {


		for ( var i : i32 = 0; i < 12; i ++ ) {

			nodeVar3 = f32( i );
			nodeVar4 = vec2<f32>( fract( ( sin( dot( vec2<f32>( nodeVar3, 3.0 ), vec2<f32>( 127.1, 311.7 ) ) ) * 43758.5453123 ) ), fract( ( sin( dot( vec2<f32>( nodeVar3, 7.0 ), vec2<f32>( 127.1, 311.7 ) ) ) * 43758.5453123 ) ) );
			nodeVar4.y = fract( ( nodeVar4.y - ( frame.nodeUniform1 * ( 0.008 + ( fract( ( sin( dot( vec2<f32>( nodeVar3, 11.0 ), vec2<f32>( 127.1, 311.7 ) ) ) * 43758.5453123 ) ) * 0.01 ) ) ) ) );

			if ( ( ( nodeVar4.x > 0.18 ) && ( nodeVar4.x < 0.82 ) ) ) {

				continue;
				

			}

			nodeVar5 = ( ( nodeVar0 - nodeVar4 ) * vec2<f32>( ( frame.nodeUniform2.x / frame.nodeUniform2.y ), 1.0 ) );
			nodeVar6 = ( 0.008 + ( fract( ( sin( dot( vec2<f32>( nodeVar3, 9.0 ), vec2<f32>( 127.1, 311.7 ) ) ) * 43758.5453123 ) ) * 0.006 ) );
			nodeVar7 = length( ( nodeVar5 * vec2<f32>( 1.0, 0.75 ) ) );
			nodeVar8 = ( 1.0 - smoothstep( ( nodeVar6 * 0.7 ), nodeVar6, nodeVar7 ) );
			nodeVar1 = ( nodeVar1 + ( ( ( nodeVar5 * vec2<f32>( nodeVar8 ) ) * vec2<f32>( frame.nodeUniform3 ) ) * vec2<f32>( 0.5 ) ) );
			nodeVar2 = ( nodeVar2 + ( ( pow( max( 0.0, ( 1.0 - ( abs( ( nodeVar7 - ( nodeVar6 * 0.8 ) ) ) / ( nodeVar6 * 0.1 ) ) ) ), 4.0 ) * 0.017 ) * frame.nodeUniform3 ) );

		}

		

	}

	nodeVar9 = ( vec2<f32>( 1.0 ) / frame.nodeUniform2 );
	nodeVar10 = clamp( ( nodeVar0 + nodeVar1 ), vec2<f32>( 0.0 ), vec2<f32>( 1.0 ) );
	nodeVar11 = textureSample( nodeUniform4, nodeUniform4_sampler, nodeVar10 );
	nodeVar12 = nodeVar11.xyz;
	nodeVar13 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( vec2<f32>( -1.0, -1.0 ) * nodeVar9 ) ) );
	nodeVar14 = nodeVar13.xyz;
	nodeVar15 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( vec2<f32>( 1.0, -1.0 ) * nodeVar9 ) ) );
	nodeVar16 = nodeVar15.xyz;
	nodeVar17 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( vec2<f32>( -1.0, 1.0 ) * nodeVar9 ) ) );
	nodeVar18 = nodeVar17.xyz;
	nodeVar19 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( vec2<f32>( 1.0, 1.0 ) * nodeVar9 ) ) );
	nodeVar20 = nodeVar19.xyz;
	nodeVar21 = vec3<f32>( 0.299, 0.587, 0.114 );
	nodeVar22 = dot( nodeVar12, nodeVar21 );
	nodeVar23 = dot( nodeVar14, nodeVar21 );
	nodeVar24 = dot( nodeVar16, nodeVar21 );
	nodeVar25 = dot( nodeVar18, nodeVar21 );
	nodeVar26 = dot( nodeVar20, nodeVar21 );
	nodeVar27 = vec2<f32>( ( - ( ( nodeVar23 + nodeVar24 ) - ( nodeVar25 + nodeVar26 ) ) ), ( ( nodeVar23 + nodeVar25 ) - ( nodeVar24 + nodeVar26 ) ) );
	nodeVar28 = max( ( ( ( ( nodeVar23 + nodeVar24 ) + nodeVar25 ) + nodeVar26 ) * 0.03125 ), 0.0078125 );
	nodeVar29 = ( 1.0 / ( min( abs( nodeVar27.x ), abs( nodeVar27.y ) ) + nodeVar28 ) );
	nodeVar27 = ( clamp( ( nodeVar27 * vec2<f32>( nodeVar29 ) ), vec2<f32>( -6.0, -6.0 ), vec2<f32>( 6.0, 6.0 ) ) * nodeVar9 );
	nodeVar30 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( nodeVar27 * vec2<f32>( -0.166667 ) ) ) );
	nodeVar31 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( nodeVar27 * vec2<f32>( 0.166667 ) ) ) );
	nodeVar32 = ( vec3<f32>( 0.5 ) * ( nodeVar30.xyz + nodeVar31.xyz ) );
	nodeVar33 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 - ( nodeVar27 * vec2<f32>( 0.5 ) ) ) );
	nodeVar34 = textureSample( nodeUniform4, nodeUniform4_sampler, ( nodeVar10 + ( nodeVar27 * vec2<f32>( 0.5 ) ) ) );
	nodeVar35 = ( ( nodeVar32 * vec3<f32>( 0.5 ) ) + ( vec3<f32>( 0.25 ) * ( nodeVar33.xyz + nodeVar34.xyz ) ) );
	nodeVar36 = dot( nodeVar35, nodeVar21 );
	nodeVar37 = min( nodeVar22, min( min( nodeVar23, nodeVar24 ), min( nodeVar25, nodeVar26 ) ) );
	nodeVar38 = max( nodeVar22, max( max( nodeVar23, nodeVar24 ), max( nodeVar25, nodeVar26 ) ) );

	if ( ( ( nodeVar36 < nodeVar37 ) || ( nodeVar36 > nodeVar38 ) ) ) {

		nodeVar39 = nodeVar32;

	} else {

		nodeVar39 = nodeVar35;

	}

	nodeVar40 = nodeVar39;
	nodeVar41 = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar42 = 0.0;

	for ( var i : i32 = -3; i <= 3; i ++ ) {

		nodeVar43 = exp( ( ( - f32( ( i * i ) ) ) * 0.26 ) );
		nodeVar44 = textureSample( nodeUniform5, nodeUniform5_sampler, ( nodeVar0 + ( vec2<f32>( 0.0, ( f32( i ) * 3.0 ) ) / frame.nodeUniform2 ) ) );
		nodeVar41 = ( nodeVar41 + ( nodeVar44.xyz * vec3<f32>( nodeVar43 ) ) );
		nodeVar42 = ( nodeVar42 + nodeVar43 );

	}

	nodeVar40 = ( nodeVar40 + ( ( nodeVar41 / vec3<f32>( nodeVar42 ) ) * vec3<f32>( 0.22 ) ) );
	nodeVar40 = ( nodeVar40 * vec3<f32>( frame.nodeUniform6 ) );
	nodeVar40 = clamp( ( ( nodeVar40 * ( ( vec3<f32>( 2.51 ) * nodeVar40 ) + vec3<f32>( 0.03 ) ) ) / ( ( nodeVar40 * ( ( vec3<f32>( 2.43 ) * nodeVar40 ) + vec3<f32>( 0.59 ) ) ) + vec3<f32>( 0.14 ) ) ), vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) );
	nodeVar40 = pow( max( nodeVar40, vec3<f32>( 0.0, 0.0, 0.0 ) ), vec3<f32>( 1.015, 1.0, 0.975 ) );
	nodeVar45 = ( 1.0 - ( 0.28 * pow( length( ( ( nodeVar0 - vec2<f32>( 0.5 ) ) * vec2<f32>( 1.05, 1.0 ) ) ), 1.65 ) ) );
	nodeVar40 = ( nodeVar40 * vec3<f32>( nodeVar45 ) );
	nodeVar40 = pow( nodeVar40, vec3<f32>( 0.45454545454545453, 0.45454545454545453, 0.45454545454545453 ) );
	nodeVar40 = ( nodeVar40 + vec3<f32>( ( ( ( fract( ( sin( dot( ( vec3<f32>( fragCoord.xy.x, ( 1.0 - fragCoord.xy.y ), ( ( v_positionView.z + render.cameraNear ) / ( render.cameraNear - render.cameraFar ) ) ).xy + vec2<f32>( floor( ( frame.nodeUniform1 * 24.0 ) ) ) ), vec2<f32>( 127.1, 311.7 ) ) ) * 43758.5453123 ) ) - 0.5 ) * 0.005 ) + nodeVar2 ) ) );
	nodeVar46 = vec4<f32>( clamp( nodeVar40, vec3<f32>( 0.0 ), vec3<f32>( 1.0 ) ), 1.0 );
	nodeVar47 = fn1( vec4<f32>( nodeVar46.xyz, clamp( nodeVar46.w, 0.0, 1.0 ) ) );

	// result

	output.color = fn0( nodeVar47 );

	return output;

}
