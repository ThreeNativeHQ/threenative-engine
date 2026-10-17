WGSLDUMP fragment
// Three.js r185 - Node System

// global
diagnostic( off, derivative_uniformity );


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 2 ) var nodeUniform17_sampler : sampler;
@binding( 1 ) @group( 2 ) var nodeUniform17 : texture_3d<f32>;

struct frameStruct {
	nodeUniform15 : f32,
	nodeUniform14 : f32,
	nodeUniform16 : f32,
	nodeUniform8 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform9 : vec3<f32>,
	nodeUniform0 : vec3<f32>,
	nodeUniform1 : vec3<f32>,
	nodeUniform4 : vec3<f32>,
	nodeUniform18 : vec3<f32>,
	nodeUniform5 : vec3<f32>,
	nodeUniform6 : vec3<f32>,
	nodeUniform7 : vec3<f32>,
	nodeUniform10 : i32
};
@binding( 0 ) @group( 0 )
var<uniform> frame : frameStruct;

struct renderStruct {
	cameraNear : f32,
	cameraFar : f32,
	cameraProjectionMatrixInverse : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> render : renderStruct;

// vars
var<private> nodeVar0 : vec2<f32>;
var<private> nodeVar1 : vec3<f32>;
var<private> nodeVar2 : vec3<f32>;
var<private> nodeVar3 : f32;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : f32;
var<private> nodeVar6 : f32;
var<private> nodeVar7 : vec4<f32>;
var<private> nodeVar8 : f32;
var<private> nodeVar10 : vec4<f32>;
var<private> positionView : vec3<f32>;
var<private> nodeVar11 : vec3<f32>;
var<private> nodeVar12 : f32;
var<private> nodeVar13 : vec3<f32>;
var<private> nodeVar14 : f32;
var<private> nodeVar15 : f32;
var<private> nodeVar16 : f32;
var<private> nodeVar17 : vec3<f32>;
var<private> nodeVar18 : f32;
var<private> nodeVar19 : vec3<f32>;
var<private> nodeVar20 : vec3<f32>;
var<private> nodeVar21 : vec4<f32>;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec4<f32>;
var<private> nodeVar24 : f32;
var<private> nodeVar25 : f32;
var<private> nodeVar26 : f32;
var<private> nodeVar27 : f32;
var<private> nodeVar28 : vec4<f32>;
var<private> nodeVar29 : f32;
var<private> nodeVar30 : f32;
var<private> nodeVar31 : vec3<f32>;
var<private> nodeVar32 : f32;
var<private> nodeVar33 : f32;
var<private> nodeVar34 : f32;
var<private> nodeVar35 : vec3<f32>;
var<private> nodeVar36 : vec3<f32>;
var<private> nodeVar37 : vec4<f32>;
var<private> nodeVar38 : vec4<f32>;
var<private> nodeVar39 : vec4<f32>;
var<private> nodeVar40 : f32;
var<private> nodeVar41 : f32;
var<private> nodeVar42 : f32;
var<private> nodeVar43 : f32;
var<private> nodeVar44 : vec4<f32>;
var<private> nodeVar45 : f32;
var<private> nodeVar46 : f32;
var<private> nodeVar47 : f32;
var<private> nodeVar48 : vec3<f32>;
var<private> nodeVar49 : vec3<f32>;
var<private> nodeVar50 : f32;
var<private> nodeVar51 : f32;
var<private> nodeVar52 : vec3<f32>;
var<private> nodeVar53 : f32;

// codes


@fragment
fn main( @location( 0 ) v_clipSpace : vec4<f32>,
	@location( 1 ) nodeVarying1 : vec2<f32>,
	@builtin( position ) fragCoord : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = ( ( nodeVarying1 * vec2<f32>( 2.0 ) ) - vec2<f32>( 1.0 ) );
	nodeVar1 = normalize( ( ( frame.nodeUniform0 + ( ( ( frame.nodeUniform1 * vec3<f32>( nodeVar0.x ) ) * vec3<f32>( frame.nodeUniform2 ) ) * vec3<f32>( frame.nodeUniform3 ) ) ) + ( ( frame.nodeUniform4 * vec3<f32>( nodeVar0.y ) ) * vec3<f32>( frame.nodeUniform3 ) ) ) );
	nodeVar1.y = abs( nodeVar1.y );
	nodeVar1 = normalize( nodeVar1 );
	nodeVar2 = frame.nodeUniform5;
	nodeVar3 = dot( nodeVar1, nodeVar2 );
	nodeVar4 = mix( frame.nodeUniform6, frame.nodeUniform7, pow( clamp( nodeVar1.y, 0.0, 1.0 ), 0.62 ) );
	nodeVar4 = ( nodeVar4 + ( vec3<f32>( 0.31, 0.27, 0.205 ) * vec3<f32>( pow( max( nodeVar3, 0.0 ), 14.0 ) ) ) );
	nodeVar4 = ( nodeVar4 + ( vec3<f32>( 0.7, 0.57, 0.37 ) * vec3<f32>( pow( max( nodeVar3, 0.0 ), 140.0 ) ) ) );
	nodeVar4 = ( nodeVar4 + ( vec3<f32>( frame.nodeUniform8 ) * vec3<f32>( 0.14, 0.22, 0.36 ) ) );
	nodeVar5 = max( 0.0, ( ( 145.0 - frame.nodeUniform9.y ) / max( nodeVar1.y, 0.008 ) ) );
	nodeVar6 = min( 10500.0, ( ( 815.0 - frame.nodeUniform9.y ) / max( nodeVar1.y, 0.008 ) ) );
	nodeVar7 = vec4<f32>( nodeVar4, 1.0 );

	if ( ( nodeVar5 < nodeVar6 ) ) {

		nodeVar8 = ( ( nodeVar6 - nodeVar5 ) / f32( frame.nodeUniform10 ) );
		nodeVar10 = ( render.cameraProjectionMatrixInverse * v_clipSpace );
		positionView = ( nodeVar10.xyz / vec3<f32>( nodeVar10.w ) );
		nodeVar11 = fract( ( vec3<f32>( vec3<f32>( fragCoord.xy.x, ( 1.0 - fragCoord.xy.y ), ( ( positionView.z + render.cameraNear ) / ( render.cameraNear - render.cameraFar ) ) ).xy, 0.0 ).xyx * vec3<f32>( 0.1031 ) ) );
		nodeVar11 = ( nodeVar11 + vec3<f32>( dot( nodeVar11, ( nodeVar11.yzx + vec3<f32>( 33.33 ) ) ) ) );
		nodeVar12 = ( ( fract( ( ( nodeVar11.x + nodeVar11.y ) * nodeVar11.z ) ) * 0.75 ) + 0.12 );
		nodeVar13 = vec3<f32>( 0.0, 0.0, 0.0 );
		nodeVar14 = 1.0;
		nodeVar15 = ( 0.45 + ( 0.65 * pow( max( nodeVar3, 0.0 ), 5.0 ) ) );

		for ( var i : i32 = 0; i < 96; i ++ ) {


			if ( ( ( i >= frame.nodeUniform10 ) || ( nodeVar14 < 0.008 ) ) ) {

				break;
				

			}

			nodeVar16 = ( nodeVar5 + ( ( f32( i ) + nodeVar12 ) * nodeVar8 ) );
			nodeVar17 = ( frame.nodeUniform9 + ( nodeVar1 * vec3<f32>( nodeVar16 ) ) );
			nodeVar18 = 0.0;

			if ( ( frame.nodeUniform14 >= 0.005 ) ) {

				nodeVar19 = vec3<f32>( ( frame.nodeUniform15 * ( 2.0 + ( frame.nodeUniform16 * 13.0 ) ) ), 0.0, ( frame.nodeUniform15 * 1.2 ) );
				nodeVar20 = ( ( nodeVar17 + nodeVar19 ) * vec3<f32>( 0.00105 ) );
				nodeVar20.y = ( nodeVar20.y * 1.4 );
				nodeVar21 = textureSample( nodeUniform17, nodeUniform17_sampler, nodeVar20 );
				nodeVar22 = nodeVar21;
				nodeVar23 = textureSample( nodeUniform17, nodeUniform17_sampler, ( ( nodeVar20 * vec3<f32>( 2.07 ) ) + vec3<f32>( 0.1, 0.3, 0.7 ) ) );
				nodeVar24 = ( ( nodeVar22.x * 0.76 ) + ( nodeVar23.x * 0.24 ) );
				nodeVar25 = ( ( nodeVar17.y - 145.0 ) / 670.0 );
				nodeVar26 = ( smoothstep( 0.0, 0.09, nodeVar25 ) * ( 1.0 - smoothstep( 0.68, 1.0, nodeVar25 ) ) );
				nodeVar27 = ( ( nodeVar24 + ( frame.nodeUniform14 * 0.3 ) ) - 0.72 );
				nodeVar28 = textureSample( nodeUniform17, nodeUniform17_sampler, ( nodeVar20 * vec3<f32>( 3.81 ) ) );
				nodeVar29 = ( ( nodeVar28.z - 0.5 ) * 0.12 );
				nodeVar18 = ( clamp( ( ( nodeVar27 - nodeVar29 ) * 5.1 ), 0.0, 1.0 ) * nodeVar26 );
				

			}

			nodeVar30 = nodeVar18;

			if ( ( nodeVar30 > 0.002 ) ) {

				nodeVar31 = nodeVar17;
				nodeVar32 = 0.0;
				nodeVar33 = 28.0;

				for ( var i : i32 = 0; i < 5; i ++ ) {

					nodeVar31 = ( nodeVar31 + ( nodeVar2 * vec3<f32>( nodeVar33 ) ) );
					nodeVar34 = 0.0;

					if ( ( frame.nodeUniform14 >= 0.005 ) ) {

						nodeVar35 = vec3<f32>( ( frame.nodeUniform15 * ( 2.0 + ( frame.nodeUniform16 * 13.0 ) ) ), 0.0, ( frame.nodeUniform15 * 1.2 ) );
						nodeVar36 = ( ( nodeVar31 + nodeVar35 ) * vec3<f32>( 0.00105 ) );
						nodeVar36.y = ( nodeVar36.y * 1.4 );
						nodeVar37 = textureSample( nodeUniform17, nodeUniform17_sampler, nodeVar36 );
						nodeVar38 = nodeVar37;
						nodeVar39 = textureSample( nodeUniform17, nodeUniform17_sampler, ( ( nodeVar36 * vec3<f32>( 2.07 ) ) + vec3<f32>( 0.1, 0.3, 0.7 ) ) );
						nodeVar40 = ( ( nodeVar38.x * 0.76 ) + ( nodeVar39.x * 0.24 ) );
						nodeVar41 = ( ( nodeVar31.y - 145.0 ) / 670.0 );
						nodeVar42 = ( smoothstep( 0.0, 0.09, nodeVar41 ) * ( 1.0 - smoothstep( 0.68, 1.0, nodeVar41 ) ) );
						nodeVar43 = ( ( nodeVar40 + ( frame.nodeUniform14 * 0.3 ) ) - 0.72 );
						nodeVar44 = textureSample( nodeUniform17, nodeUniform17_sampler, ( nodeVar36 * vec3<f32>( 3.81 ) ) );
						nodeVar45 = ( ( nodeVar44.z - 0.5 ) * 0.12 );
						nodeVar34 = ( clamp( ( ( nodeVar43 - nodeVar45 ) * 5.1 ), 0.0, 1.0 ) * nodeVar42 );
						

					}

					nodeVar32 = ( nodeVar32 + ( nodeVar34 * nodeVar33 ) );
					nodeVar33 = ( nodeVar33 * 1.7 );

				}

				nodeVar46 = exp( ( ( - nodeVar32 ) * 0.015 ) );
				nodeVar47 = clamp( ( ( nodeVar17.y - 145.0 ) / 670.0 ), 0.0, 1.0 );
				nodeVar48 = mix( vec3<f32>( 0.035, 0.061, 0.079 ), vec3<f32>( 0.19, 0.25, 0.28 ), nodeVar47 );
				nodeVar49 = ( ( nodeVar48 * vec3<f32>( ( 0.7 + ( 0.45 * ( 1.0 - exp( ( ( - nodeVar30 ) * 3.0 ) ) ) ) ) ) ) + ( ( ( vec3<f32>( 0.97, 0.94, 0.85 ) * vec3<f32>( nodeVar46 ) ) * vec3<f32>( nodeVar15 ) ) * vec3<f32>( 0.7 ) ) );
				nodeVar50 = exp( ( ( - length( ( ( nodeVar17 - frame.nodeUniform18 ) * vec3<f32>( 1.0, 0.5, 1.0 ) ) ) ) * 0.0022 ) );
				nodeVar49 = ( nodeVar49 + ( ( ( vec3<f32>( 0.85, 1.18, 1.9 ) * vec3<f32>( frame.nodeUniform8 ) ) * vec3<f32>( nodeVar50 ) ) * vec3<f32>( 1.2 ) ) );
				nodeVar51 = ( 1.0 - exp( ( ( ( - nodeVar30 ) * nodeVar8 ) * 0.02 ) ) );
				nodeVar13 = ( nodeVar13 + ( vec3<f32>( ( nodeVar14 * nodeVar51 ) ) * nodeVar49 ) );
				nodeVar14 = ( nodeVar14 * ( 1.0 - nodeVar51 ) );
				

			}


		}

		nodeVar52 = ( nodeVar13 + ( vec3<f32>( nodeVar14 ) * nodeVar4 ) );
		nodeVar53 = ( 1.0 - exp( ( ( - nodeVar5 ) * 0.000075 ) ) );
		nodeVar52 = mix( nodeVar52, nodeVar4, ( nodeVar53 * 0.66 ) );
		nodeVar7 = vec4<f32>( nodeVar52, ( 1.0 - nodeVar14 ) );
		

	}


	// result

	output.color = nodeVar7;

	return output;

}
