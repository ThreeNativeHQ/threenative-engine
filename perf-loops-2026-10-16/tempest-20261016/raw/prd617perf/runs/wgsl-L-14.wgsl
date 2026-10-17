WGSLDUMP vertex_SMAANode.weights
// Three.js r185 - Node System

// directives


// structs


// uniforms

struct objectStruct {
	nodeUniform1 : mat3x3<f32>,
	nodeUniform2 : mat3x3<f32>,
	nodeUniform3 : vec2<f32>,
	nodeUniform5 : mat3x3<f32>,
	nodeUniform6 : mat3x3<f32>,
	nodeUniform7 : mat3x3<f32>,
	nodeUniform8 : mat3x3<f32>,
	nodeUniform9 : mat3x3<f32>,
	nodeUniform11 : mat3x3<f32>,
	nodeUniform12 : mat3x3<f32>,
	nodeUniform13 : mat3x3<f32>,
	nodeUniform14 : mat3x3<f32>,
	nodeUniform15 : mat3x3<f32>,
	nodeUniform16 : mat3x3<f32>,
	nodeUniform17 : mat3x3<f32>,
	nodeUniform18 : mat3x3<f32>,
	nodeUniform19 : vec2<f32>,
	nodeUniform22 : mat4x4<f32>
};
@binding( 2 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 0 ) nodeVarying4 : vec2<f32>,
	@location( 1 ) vOffset0 : vec4<f32>,
	@location( 2 ) vOffset2 : vec4<f32>,
	@location( 3 ) vOffset1 : vec4<f32>,
	@location( 4 ) vPixcoord : vec2<f32>,
	@builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// vars
var<private> nodeVar46 : vec4<f32>;
var<private> nodeVar47 : vec4<f32>;
var<private> nodeVar48 : vec4<f32>;
var<private> modelViewMatrix : mat4x4<f32>;
var<private> VERTEX_nodeVar49 : vec4<f32>;
var<private> v_modelViewProjection : vec4<f32>;
var<private> v_positionView : vec3<f32>;
var<private> positionLocal : vec3<f32>;
var<private> VERTEX_v_modelViewProjection : vec4<f32>;

// codes


@vertex
fn main( @location( 0 ) uv : vec2<f32>,
	@location( 1 ) position : vec3<f32> ) -> VaryingsStruct {

	// flow
	// code

	varyings.nodeVarying4 = uv;
	nodeVar46 = ( vec4<f32>( uv, uv ) + ( vec4<f32>( object.nodeUniform19, object.nodeUniform19 ) * vec4<f32>( -0.25, -0.125, 1.25, -0.125 ) ) );
	nodeVar47 = ( vec4<f32>( uv, uv ) + ( vec4<f32>( object.nodeUniform19, object.nodeUniform19 ) * vec4<f32>( -0.125, -0.25, -0.125, 1.25 ) ) );
	nodeVar48 = ( vec4<f32>( nodeVar46.xz, nodeVar47.yw ) + ( ( vec4<f32>( -2.0, 2.0, -2.0, 2.0 ) * vec4<f32>( object.nodeUniform19.xx, object.nodeUniform19.yy ) ) * vec4<f32>( 8.0 ) ) );
	varyings.vPixcoord = ( uv / object.nodeUniform19 );
	varyings.vOffset0 = nodeVar46;
	varyings.vOffset1 = nodeVar47;
	varyings.vOffset2 = nodeVar48;
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform22 );
	positionLocal = position;
	v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	VERTEX_nodeVar49 = ( render.cameraProjectionMatrix * vec4<f32>( v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar49;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}
