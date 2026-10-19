#pragma once

// MaterialX noise as three@0.185.1 compiles it: the WGSL functions three's WGSLNodeBuilder emits for
// mx_noise_float and mx_worley_noise_vec2 (src/nodes/materialx/lib/mx_noise.js), copied as emitted
// so a pixel matches three's (three's mx_hash_int_3 drops its mx_bjmix call, and this keeps that).
// `_0` takes a vec2 coordinate and `_1` a vec3, the overload numbers three gives them. A program
// that calls one gets the whole library once, ahead of its entry point. One literal per function
// keeps each under MSVC's string-literal limit. three.js, MIT License, Copyright © 2010-2026 three.js
// authors.

#include <string_view>

namespace tn::engine::shader {

inline constexpr std::string_view kMaterialXNoise =
R"WGSL(
fn mx_rotl32 ( x : u32, k : i32 ) -> u32 {

	var nodeVar0 : i32;
	var nodeVar1 : u32;

	nodeVar0 = k;
	nodeVar1 = x;

	return ( ( nodeVar1 << u32( nodeVar0 ) ) | ( nodeVar1 >> u32( ( 32 - nodeVar0 ) ) ) );

}
)WGSL"
R"WGSL(
fn mx_bjfinal ( a : u32, b : u32, c : u32 ) -> u32 {

	var nodeVar0 : u32;
	var nodeVar1 : u32;
	var nodeVar2 : u32;

	nodeVar0 = c;
	nodeVar1 = b;
	nodeVar2 = a;
	nodeVar0 = ( nodeVar0 ^ nodeVar1 );
	nodeVar0 = ( nodeVar0 - mx_rotl32( nodeVar1, 14 ) );
	nodeVar2 = ( nodeVar2 ^ nodeVar0 );
	nodeVar2 = ( nodeVar2 - mx_rotl32( nodeVar0, 11 ) );
	nodeVar1 = ( nodeVar1 ^ nodeVar2 );
	nodeVar1 = ( nodeVar1 - mx_rotl32( nodeVar2, 25 ) );
	nodeVar0 = ( nodeVar0 ^ nodeVar1 );
	nodeVar0 = ( nodeVar0 - mx_rotl32( nodeVar1, 16 ) );
	nodeVar2 = ( nodeVar2 ^ nodeVar0 );
	nodeVar2 = ( nodeVar2 - mx_rotl32( nodeVar0, 4 ) );
	nodeVar1 = ( nodeVar1 ^ nodeVar2 );
	nodeVar1 = ( nodeVar1 - mx_rotl32( nodeVar2, 14 ) );
	nodeVar0 = ( nodeVar0 ^ nodeVar1 );
	nodeVar0 = ( nodeVar0 - mx_rotl32( nodeVar1, 24 ) );

	return nodeVar0;

}
)WGSL"
R"WGSL(
fn mx_select ( b : bool, t : f32, f : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : bool;
	var nodeVar3 : f32;

	nodeVar0 = f;
	nodeVar1 = t;
	nodeVar2 = b;

	return select( nodeVar0, nodeVar1, nodeVar2 );

}
)WGSL"
R"WGSL(
fn mx_negate_if ( val : f32, b : bool ) -> f32 {

	var nodeVar0 : bool;
	var nodeVar1 : f32;
	var nodeVar2 : f32;

	nodeVar0 = b;
	nodeVar1 = val;

	return select( nodeVar1, ( - nodeVar1 ), nodeVar0 );

}
)WGSL"
R"WGSL(
fn mx_floor ( x : f32 ) -> i32 {

	var nodeVar0 : f32;

	nodeVar0 = x;

	return i32( floor( nodeVar0 ) );

}
)WGSL"
R"WGSL(
fn mx_fade ( t : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = t;

	return ( ( ( nodeVar0 * nodeVar0 ) * nodeVar0 ) * ( ( nodeVar0 * ( ( nodeVar0 * 6.0 ) - 15.0 ) ) + 10.0 ) );

}
)WGSL"
R"WGSL(
fn mx_hash_int_2 ( x : i32, y : i32, z : i32 ) -> u32 {

	var nodeVar0 : i32;
	var nodeVar1 : i32;
	var nodeVar2 : i32;
	var nodeVar3 : u32;
	var nodeVar4 : u32;
	var nodeVar5 : u32;
	var nodeVar6 : u32;

	nodeVar0 = z;
	nodeVar1 = y;
	nodeVar2 = x;
	nodeVar3 = 3u;
	nodeVar4 = 0u;
	nodeVar5 = 0u;
	nodeVar6 = 0u;
	nodeVar6 = ( ( 3735928559u + ( nodeVar3 << 2u ) ) + 13u );
	nodeVar5 = nodeVar6;
	nodeVar4 = nodeVar5;
	nodeVar4 = ( nodeVar4 + u32( nodeVar2 ) );
	nodeVar5 = ( nodeVar5 + u32( nodeVar1 ) );
	nodeVar6 = ( nodeVar6 + u32( nodeVar0 ) );

	return mx_bjfinal( nodeVar4, nodeVar5, nodeVar6 );

}
)WGSL"
R"WGSL(
fn mx_gradient_float_1 ( hash : u32, x : f32, y : f32, z : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : f32;
	var nodeVar3 : u32;
	var nodeVar4 : u32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;

	nodeVar0 = z;
	nodeVar1 = y;
	nodeVar2 = x;
	nodeVar3 = hash;
	nodeVar4 = ( nodeVar3 & 15u );
	nodeVar5 = mx_select( ( nodeVar4 < 8u ), nodeVar2, nodeVar1 );
	nodeVar6 = mx_select( ( nodeVar4 < 4u ), nodeVar1, mx_select( ( ( nodeVar4 == 12u ) || ( nodeVar4 == 14u ) ), nodeVar2, nodeVar0 ) );

	return ( mx_negate_if( nodeVar5, bool( ( nodeVar4 & 1u ) ) ) + mx_negate_if( nodeVar6, bool( ( nodeVar4 & 2u ) ) ) );

}
)WGSL"
R"WGSL(
fn mx_trilerp_0 ( v0 : f32, v1 : f32, v2 : f32, v3 : f32, v4 : f32, v5 : f32, v6 : f32, v7 : f32, s : f32, t : f32, r : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : f32;
	var nodeVar3 : f32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;
	var nodeVar7 : f32;
	var nodeVar8 : f32;
	var nodeVar9 : f32;
	var nodeVar10 : f32;
	var nodeVar11 : f32;
	var nodeVar12 : f32;
	var nodeVar13 : f32;

	nodeVar0 = r;
	nodeVar1 = t;
	nodeVar2 = s;
	nodeVar3 = v7;
	nodeVar4 = v6;
	nodeVar5 = v5;
	nodeVar6 = v4;
	nodeVar7 = v3;
	nodeVar8 = v2;
	nodeVar9 = v1;
	nodeVar10 = v0;
	nodeVar11 = ( 1.0 - nodeVar2 );
	nodeVar12 = ( 1.0 - nodeVar1 );
	nodeVar13 = ( 1.0 - nodeVar0 );

	return ( ( nodeVar13 * ( ( nodeVar12 * ( ( nodeVar10 * nodeVar11 ) + ( nodeVar9 * nodeVar2 ) ) ) + ( nodeVar1 * ( ( nodeVar8 * nodeVar11 ) + ( nodeVar7 * nodeVar2 ) ) ) ) ) + ( nodeVar0 * ( ( nodeVar12 * ( ( nodeVar6 * nodeVar11 ) + ( nodeVar5 * nodeVar2 ) ) ) + ( nodeVar1 * ( ( nodeVar4 * nodeVar11 ) + ( nodeVar3 * nodeVar2 ) ) ) ) ) );

}
)WGSL"
R"WGSL(
fn mx_gradient_scale3d_0 ( v : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = v;

	return ( 0.982 * nodeVar0 );

}
)WGSL"
R"WGSL(
fn mx_hash_int_1 ( x : i32, y : i32 ) -> u32 {

	var nodeVar0 : i32;
	var nodeVar1 : i32;
	var nodeVar2 : u32;
	var nodeVar3 : u32;
	var nodeVar4 : u32;
	var nodeVar5 : u32;

	nodeVar0 = y;
	nodeVar1 = x;
	nodeVar2 = 2u;
	nodeVar3 = 0u;
	nodeVar4 = 0u;
	nodeVar5 = 0u;
	nodeVar5 = ( ( 3735928559u + ( nodeVar2 << 2u ) ) + 13u );
	nodeVar4 = nodeVar5;
	nodeVar3 = nodeVar4;
	nodeVar3 = ( nodeVar3 + u32( nodeVar1 ) );
	nodeVar4 = ( nodeVar4 + u32( nodeVar0 ) );

	return mx_bjfinal( nodeVar3, nodeVar4, nodeVar5 );

}
)WGSL"
R"WGSL(
fn mx_gradient_float_0 ( hash : u32, x : f32, y : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : u32;
	var nodeVar3 : u32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;

	nodeVar0 = y;
	nodeVar1 = x;
	nodeVar2 = hash;
	nodeVar3 = ( nodeVar2 & 7u );
	nodeVar4 = mx_select( ( nodeVar3 < 4u ), nodeVar1, nodeVar0 );
	nodeVar5 = ( 2.0 * mx_select( ( nodeVar3 < 4u ), nodeVar0, nodeVar1 ) );

	return ( mx_negate_if( nodeVar4, bool( ( nodeVar3 & 1u ) ) ) + mx_negate_if( nodeVar5, bool( ( nodeVar3 & 2u ) ) ) );

}
)WGSL"
R"WGSL(
fn mx_bilerp_0 ( v0 : f32, v1 : f32, v2 : f32, v3 : f32, s : f32, t : f32 ) -> f32 {

	var nodeVar0 : f32;
	var nodeVar1 : f32;
	var nodeVar2 : f32;
	var nodeVar3 : f32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;

	nodeVar0 = t;
	nodeVar1 = s;
	nodeVar2 = v3;
	nodeVar3 = v2;
	nodeVar4 = v1;
	nodeVar5 = v0;
	nodeVar6 = ( 1.0 - nodeVar1 );

	return ( ( ( 1.0 - nodeVar0 ) * ( ( nodeVar5 * nodeVar6 ) + ( nodeVar4 * nodeVar1 ) ) ) + ( nodeVar0 * ( ( nodeVar3 * nodeVar6 ) + ( nodeVar2 * nodeVar1 ) ) ) );

}
)WGSL"
R"WGSL(
fn mx_gradient_scale2d_0 ( v : f32 ) -> f32 {

	var nodeVar0 : f32;

	nodeVar0 = v;

	return ( 0.6616 * nodeVar0 );

}
)WGSL"
R"WGSL(
fn mx_bits_to_01 ( bits : u32 ) -> f32 {

	var nodeVar0 : u32;

	nodeVar0 = bits;

	return ( f32( nodeVar0 ) / f32( 4294967295u ) );

}
)WGSL"
R"WGSL(
fn mx_cell_noise_vec3_1 ( p : vec2<f32> ) -> vec3<f32> {

	var nodeVar0 : vec2<f32>;
	var nodeVar1 : i32;
	var nodeVar2 : i32;

	nodeVar0 = p;
	nodeVar1 = mx_floor( nodeVar0.x );
	nodeVar2 = mx_floor( nodeVar0.y );

	return vec3<f32>( mx_bits_to_01( mx_hash_int_2( nodeVar1, nodeVar2, 0 ) ), mx_bits_to_01( mx_hash_int_2( nodeVar1, nodeVar2, 1 ) ), mx_bits_to_01( mx_hash_int_2( nodeVar1, nodeVar2, 2 ) ) );

}
)WGSL"
R"WGSL(
fn mx_worley_distance_0 ( p : vec2<f32>, x : i32, y : i32, xoff : i32, yoff : i32, jitter : f32, metric : i32 ) -> f32 {

	var nodeVar0 : i32;
	var nodeVar1 : f32;
	var nodeVar2 : i32;
	var nodeVar3 : i32;
	var nodeVar4 : i32;
	var nodeVar5 : i32;
	var nodeVar6 : vec2<f32>;
	var nodeVar7 : vec3<f32>;
	var nodeVar8 : vec2<f32>;
	var nodeVar9 : vec2<f32>;
	var nodeVar10 : vec2<f32>;

	nodeVar0 = metric;
	nodeVar1 = jitter;
	nodeVar2 = yoff;
	nodeVar3 = xoff;
	nodeVar4 = y;
	nodeVar5 = x;
	nodeVar6 = p;
	nodeVar7 = mx_cell_noise_vec3_1( vec2<f32>( f32( ( nodeVar5 + nodeVar3 ) ), f32( ( nodeVar4 + nodeVar2 ) ) ) );
	nodeVar8 = vec2<f32>( nodeVar7.x, nodeVar7.y );
	nodeVar8 = ( nodeVar8 - vec2<f32>( 0.5 ) );
	nodeVar8 = ( nodeVar8 * vec2<f32>( nodeVar1 ) );
	nodeVar8 = ( nodeVar8 + vec2<f32>( 0.5 ) );
	nodeVar9 = ( vec2<f32>( f32( nodeVar5 ), f32( nodeVar4 ) ) + nodeVar8 );
	nodeVar10 = ( nodeVar9 - nodeVar6 );

	if ( ( nodeVar0 == 2 ) ) {

		return ( abs( nodeVar10.x ) + abs( nodeVar10.y ) );

	}


	if ( ( nodeVar0 == 3 ) ) {

		return max( abs( nodeVar10.x ), abs( nodeVar10.y ) );

	}


	return dot( nodeVar10, nodeVar10 );

}
)WGSL"
R"WGSL(
fn mx_hash_int_3 ( x : i32, y : i32, z : i32, xx : i32 ) -> u32 {

	var nodeVar0 : i32;
	var nodeVar1 : i32;
	var nodeVar2 : i32;
	var nodeVar3 : i32;
	var nodeVar4 : u32;
	var nodeVar5 : u32;
	var nodeVar6 : u32;
	var nodeVar7 : u32;

	nodeVar0 = xx;
	nodeVar1 = z;
	nodeVar2 = y;
	nodeVar3 = x;
	nodeVar4 = 4u;
	nodeVar5 = 0u;
	nodeVar6 = 0u;
	nodeVar7 = 0u;
	nodeVar7 = ( ( 3735928559u + ( nodeVar4 << 2u ) ) + 13u );
	nodeVar6 = nodeVar7;
	nodeVar5 = nodeVar6;
	nodeVar5 = ( nodeVar5 + u32( nodeVar3 ) );
	nodeVar6 = ( nodeVar6 + u32( nodeVar2 ) );
	nodeVar7 = ( nodeVar7 + u32( nodeVar1 ) );
	nodeVar5 = ( nodeVar5 + u32( nodeVar0 ) );

	return mx_bjfinal( nodeVar5, nodeVar6, nodeVar7 );

}
)WGSL"
R"WGSL(
fn mx_cell_noise_vec3_2 ( p : vec3<f32> ) -> vec3<f32> {

	var nodeVar0 : vec3<f32>;
	var nodeVar1 : i32;
	var nodeVar2 : i32;
	var nodeVar3 : i32;

	nodeVar0 = p;
	nodeVar1 = mx_floor( nodeVar0.x );
	nodeVar2 = mx_floor( nodeVar0.y );
	nodeVar3 = mx_floor( nodeVar0.z );

	return vec3<f32>( mx_bits_to_01( mx_hash_int_3( nodeVar1, nodeVar2, nodeVar3, 0 ) ), mx_bits_to_01( mx_hash_int_3( nodeVar1, nodeVar2, nodeVar3, 1 ) ), mx_bits_to_01( mx_hash_int_3( nodeVar1, nodeVar2, nodeVar3, 2 ) ) );

}
)WGSL"
R"WGSL(
fn mx_worley_distance_1 ( p : vec3<f32>, x : i32, y : i32, z : i32, xoff : i32, yoff : i32, zoff : i32, jitter : f32, metric : i32 ) -> f32 {

	var nodeVar0 : i32;
	var nodeVar1 : f32;
	var nodeVar2 : i32;
	var nodeVar3 : i32;
	var nodeVar4 : i32;
	var nodeVar5 : i32;
	var nodeVar6 : i32;
	var nodeVar7 : i32;
	var nodeVar8 : vec3<f32>;
	var nodeVar9 : vec3<f32>;
	var nodeVar10 : vec3<f32>;
	var nodeVar11 : vec3<f32>;

	nodeVar0 = metric;
	nodeVar1 = jitter;
	nodeVar2 = zoff;
	nodeVar3 = yoff;
	nodeVar4 = xoff;
	nodeVar5 = z;
	nodeVar6 = y;
	nodeVar7 = x;
	nodeVar8 = p;
	nodeVar9 = mx_cell_noise_vec3_2( vec3<f32>( f32( ( nodeVar7 + nodeVar4 ) ), f32( ( nodeVar6 + nodeVar3 ) ), f32( ( nodeVar5 + nodeVar2 ) ) ) );
	nodeVar9 = ( nodeVar9 - vec3<f32>( 0.5 ) );
	nodeVar9 = ( nodeVar9 * vec3<f32>( nodeVar1 ) );
	nodeVar9 = ( nodeVar9 + vec3<f32>( 0.5 ) );
	nodeVar10 = ( vec3<f32>( f32( nodeVar7 ), f32( nodeVar6 ), f32( nodeVar5 ) ) + nodeVar9 );
	nodeVar11 = ( nodeVar10 - nodeVar8 );

	if ( ( nodeVar0 == 2 ) ) {

		return ( ( abs( nodeVar11.x ) + abs( nodeVar11.y ) ) + abs( nodeVar11.z ) );

	}


	if ( ( nodeVar0 == 3 ) ) {

		return max( max( abs( nodeVar11.x ), abs( nodeVar11.y ) ), abs( nodeVar11.z ) );

	}


	return dot( nodeVar11, nodeVar11 );

}
)WGSL"
R"WGSL(
fn mx_perlin_noise_float_1 ( p : vec3<f32> ) -> f32 {

	var nodeVar0 : vec3<f32>;
	var nodeVar1 : i32;
	var nodeVar2 : i32;
	var nodeVar3 : i32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;
	var nodeVar7 : f32;
	var nodeVar8 : f32;
	var nodeVar9 : f32;
	var nodeVar10 : f32;
	var nodeVar11 : f32;
	var nodeVar12 : f32;
	var nodeVar13 : f32;

	nodeVar0 = p;
	nodeVar1 = 0;
	nodeVar2 = 0;
	nodeVar3 = 0;
	nodeVar4 = nodeVar0.x;
	nodeVar1 = mx_floor( nodeVar4 );
	nodeVar5 = ( nodeVar4 - f32( nodeVar1 ) );
	nodeVar6 = nodeVar0.y;
	nodeVar2 = mx_floor( nodeVar6 );
	nodeVar7 = ( nodeVar6 - f32( nodeVar2 ) );
	nodeVar8 = nodeVar0.z;
	nodeVar3 = mx_floor( nodeVar8 );
	nodeVar9 = ( nodeVar8 - f32( nodeVar3 ) );
	nodeVar10 = mx_fade( nodeVar5 );
	nodeVar11 = mx_fade( nodeVar7 );
	nodeVar12 = mx_fade( nodeVar9 );
	nodeVar13 = mx_trilerp_0( mx_gradient_float_1( mx_hash_int_2( nodeVar1, nodeVar2, nodeVar3 ), nodeVar5, nodeVar7, nodeVar9 ), mx_gradient_float_1( mx_hash_int_2( ( nodeVar1 + 1 ), nodeVar2, nodeVar3 ), ( nodeVar5 - 1.0 ), nodeVar7, nodeVar9 ), mx_gradient_float_1( mx_hash_int_2( nodeVar1, ( nodeVar2 + 1 ), nodeVar3 ), nodeVar5, ( nodeVar7 - 1.0 ), nodeVar9 ), mx_gradient_float_1( mx_hash_int_2( ( nodeVar1 + 1 ), ( nodeVar2 + 1 ), nodeVar3 ), ( nodeVar5 - 1.0 ), ( nodeVar7 - 1.0 ), nodeVar9 ), mx_gradient_float_1( mx_hash_int_2( nodeVar1, nodeVar2, ( nodeVar3 + 1 ) ), nodeVar5, nodeVar7, ( nodeVar9 - 1.0 ) ), mx_gradient_float_1( mx_hash_int_2( ( nodeVar1 + 1 ), nodeVar2, ( nodeVar3 + 1 ) ), ( nodeVar5 - 1.0 ), nodeVar7, ( nodeVar9 - 1.0 ) ), mx_gradient_float_1( mx_hash_int_2( nodeVar1, ( nodeVar2 + 1 ), ( nodeVar3 + 1 ) ), nodeVar5, ( nodeVar7 - 1.0 ), ( nodeVar9 - 1.0 ) ), mx_gradient_float_1( mx_hash_int_2( ( nodeVar1 + 1 ), ( nodeVar2 + 1 ), ( nodeVar3 + 1 ) ), ( nodeVar5 - 1.0 ), ( nodeVar7 - 1.0 ), ( nodeVar9 - 1.0 ) ), nodeVar10, nodeVar11, nodeVar12 );

	return mx_gradient_scale3d_0( nodeVar13 );

}
)WGSL"
R"WGSL(
fn mx_perlin_noise_float_0 ( p : vec2<f32> ) -> f32 {

	var nodeVar0 : vec2<f32>;
	var nodeVar1 : i32;
	var nodeVar2 : i32;
	var nodeVar3 : f32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;
	var nodeVar7 : f32;
	var nodeVar8 : f32;
	var nodeVar9 : f32;

	nodeVar0 = p;
	nodeVar1 = 0;
	nodeVar2 = 0;
	nodeVar3 = nodeVar0.x;
	nodeVar1 = mx_floor( nodeVar3 );
	nodeVar4 = ( nodeVar3 - f32( nodeVar1 ) );
	nodeVar5 = nodeVar0.y;
	nodeVar2 = mx_floor( nodeVar5 );
	nodeVar6 = ( nodeVar5 - f32( nodeVar2 ) );
	nodeVar7 = mx_fade( nodeVar4 );
	nodeVar8 = mx_fade( nodeVar6 );
	nodeVar9 = mx_bilerp_0( mx_gradient_float_0( mx_hash_int_1( nodeVar1, nodeVar2 ), nodeVar4, nodeVar6 ), mx_gradient_float_0( mx_hash_int_1( ( nodeVar1 + 1 ), nodeVar2 ), ( nodeVar4 - 1.0 ), nodeVar6 ), mx_gradient_float_0( mx_hash_int_1( nodeVar1, ( nodeVar2 + 1 ) ), nodeVar4, ( nodeVar6 - 1.0 ) ), mx_gradient_float_0( mx_hash_int_1( ( nodeVar1 + 1 ), ( nodeVar2 + 1 ) ), ( nodeVar4 - 1.0 ), ( nodeVar6 - 1.0 ) ), nodeVar7, nodeVar8 );

	return mx_gradient_scale2d_0( nodeVar9 );

}
)WGSL"
R"WGSL(
fn mx_worley_noise_vec2_0 ( p : vec2<f32>, jitter : f32, metric : i32 ) -> vec2<f32> {

	var nodeVar0 : i32;
	var nodeVar1 : f32;
	var nodeVar2 : vec2<f32>;
	var nodeVar3 : i32;
	var nodeVar4 : i32;
	var nodeVar5 : f32;
	var nodeVar6 : f32;
	var nodeVar7 : vec2<f32>;
	var nodeVar8 : vec2<f32>;
	var nodeVar9 : f32;

	nodeVar0 = metric;
	nodeVar1 = jitter;
	nodeVar2 = p;
	nodeVar3 = 0;
	nodeVar4 = 0;
	nodeVar5 = nodeVar2.x;
	nodeVar3 = mx_floor( nodeVar5 );
	nodeVar6 = nodeVar2.y;
	nodeVar4 = mx_floor( nodeVar6 );
	nodeVar7 = vec2<f32>( ( nodeVar5 - f32( nodeVar3 ) ), ( nodeVar6 - f32( nodeVar4 ) ) );
	nodeVar8 = vec2<f32>( 1000000.0, 1000000.0 );

	for ( var x : i32 = -1; x <= 1; x ++ ) {


		for ( var y : i32 = -1; y <= 1; y ++ ) {

			nodeVar9 = mx_worley_distance_0( nodeVar7, x, y, nodeVar3, nodeVar4, nodeVar1, nodeVar0 );

			if ( ( nodeVar9 < nodeVar8.x ) ) {

				nodeVar8.y = nodeVar8.x;
				nodeVar8.x = nodeVar9;
				

			} else {


				if ( ( nodeVar9 < nodeVar8.y ) ) {

					nodeVar8.y = nodeVar9;
					

				}

				

			}


		}


	}


	if ( ( nodeVar0 == 0 ) ) {

		nodeVar8 = sqrt( nodeVar8 );
		

	}


	return nodeVar8;

}
)WGSL"
R"WGSL(
fn mx_worley_noise_vec2_1 ( p : vec3<f32>, jitter : f32, metric : i32 ) -> vec2<f32> {

	var nodeVar0 : i32;
	var nodeVar1 : f32;
	var nodeVar2 : vec3<f32>;
	var nodeVar3 : i32;
	var nodeVar4 : i32;
	var nodeVar5 : i32;
	var nodeVar6 : f32;
	var nodeVar7 : f32;
	var nodeVar8 : f32;
	var nodeVar9 : vec3<f32>;
	var nodeVar10 : vec2<f32>;
	var nodeVar11 : f32;

	nodeVar0 = metric;
	nodeVar1 = jitter;
	nodeVar2 = p;
	nodeVar3 = 0;
	nodeVar4 = 0;
	nodeVar5 = 0;
	nodeVar6 = nodeVar2.x;
	nodeVar3 = mx_floor( nodeVar6 );
	nodeVar7 = nodeVar2.y;
	nodeVar4 = mx_floor( nodeVar7 );
	nodeVar8 = nodeVar2.z;
	nodeVar5 = mx_floor( nodeVar8 );
	nodeVar9 = vec3<f32>( ( nodeVar6 - f32( nodeVar3 ) ), ( nodeVar7 - f32( nodeVar4 ) ), ( nodeVar8 - f32( nodeVar5 ) ) );
	nodeVar10 = vec2<f32>( 1000000.0, 1000000.0 );

	for ( var x : i32 = -1; x <= 1; x ++ ) {


		for ( var y : i32 = -1; y <= 1; y ++ ) {


			for ( var z : i32 = -1; z <= 1; z ++ ) {

				nodeVar11 = mx_worley_distance_1( nodeVar9, x, y, z, nodeVar3, nodeVar4, nodeVar5, nodeVar1, nodeVar0 );

				if ( ( nodeVar11 < nodeVar10.x ) ) {

					nodeVar10.y = nodeVar10.x;
					nodeVar10.x = nodeVar11;
					

				} else {


					if ( ( nodeVar11 < nodeVar10.y ) ) {

						nodeVar10.y = nodeVar11;
						

					}

					

				}


			}


		}


	}


	if ( ( nodeVar0 == 0 ) ) {

		nodeVar10 = sqrt( nodeVar10 );
		

	}


	return nodeVar10;

}
)WGSL";

}  // namespace tn::engine::shader
