// The standard materials, ported from three@0.185.1's TSL node chain line by line where order of
// operations is observable: src/nodes/functions/BSDF/{F_Schlick,V_GGX_SmithCorrelated,D_GGX,
// BRDF_GGX,BRDF_GGX_Multiscatter,BRDF_Lambert,DFGLUT}.js, functions/material/getRoughness.js,
// functions/PhysicalLightingModel.js (direct, indirect diffuse), lighting/HemisphereLightNode.js.
// Lambert and Phong come from functions/PhongLightingModel.js (its Blinn-Phong D_BlinnPhong and
// BRDF_BlinnPhong) as materials/nodes/Mesh{Lambert,Phong}NodeMaterial.js wire them.

#include "standard.h"
#include "cube_uv.h"
#include <stdexcept>
#include <algorithm>
#include "engine/shader/tsl/tsl.h"

#include <functional>
#include <numbers>
#include <unordered_set>

namespace tn::engine::shader {

namespace {

constexpr float kPi = std::numbers::pi_v<float>;
constexpr float kEpsilon = 1e-6f;  // MathNode EPSILON

struct Tsl {
    Program& p;
    ExprId f(float v) { return p.constant(v); }
    ExprId pow2(ExprId x) { return p.mul(x, x); }
    ExprId oneMinus(ExprId x) { return p.sub(f(1), x); }
    ExprId saturate(ExprId x) { return p.call("clamp", {x, f(0), f(1)}); }
    ExprId dot(ExprId a, ExprId b) { return p.call("dot", {a, b}); }
};

// F_Schlick( f0, f90, dotVH )
ExprId fSchlick(Tsl& t, ExprId f0, ExprId f90, ExprId dotVH) {
    Program& p = t.p;
    const ExprId fresnel = p.call("exp2", {p.mul(p.sub(p.mul(dotVH, t.f(-5.55473f)), t.f(6.98316f)), dotVH)});
    return p.add(p.mul(f0, t.oneMinus(fresnel)), p.mul(f90, fresnel));
}

// V_GGX_SmithCorrelated( alpha, dotNL, dotNV )
ExprId vGgxSmithCorrelated(Tsl& t, ExprId alpha, ExprId dotNL, ExprId dotNV) {
    Program& p = t.p;
    const ExprId a2 = t.pow2(alpha);
    const ExprId gv = p.mul(dotNL, p.call("sqrt", {p.add(a2, p.mul(t.oneMinus(a2), t.pow2(dotNV)))}));
    const ExprId gl = p.mul(dotNV, p.call("sqrt", {p.add(a2, p.mul(t.oneMinus(a2), t.pow2(dotNL)))}));
    return p.div(t.f(0.5f), p.call("max", {p.add(gv, gl), t.f(kEpsilon)}));
}

// D_GGX( alpha, dotNH )
ExprId dGgx(Tsl& t, ExprId alpha, ExprId dotNH) {
    Program& p = t.p;
    const ExprId a2 = t.pow2(alpha);
    const ExprId denom = t.oneMinus(p.mul(t.pow2(dotNH), t.oneMinus(a2)));  // avoid alpha = 0 with dotNH = 1
    return p.mul(p.div(a2, t.pow2(denom)), t.f(1 / kPi));
}

struct Surface {
    ExprId normal;   // normalView
    ExprId view;     // positionViewDirection
    ExprId roughness;
    ExprId f0;       // specularColorBlended
    ExprId f90;
    uint32_t dfg;
};

// BRDF_GGX( lightDirection, f0, f90, roughness )
ExprId brdfGgx(Tsl& t, const Surface& s, ExprId light) {
    Program& p = t.p;
    const ExprId alpha = t.pow2(s.roughness);  // UE4's roughness
    const ExprId half = p.call("normalize", {p.add(light, s.view)});
    const ExprId dotNL = t.saturate(t.dot(s.normal, light));
    const ExprId dotNV = t.saturate(t.dot(s.normal, s.view));
    const ExprId dotNH = t.saturate(t.dot(s.normal, half));
    const ExprId dotVH = t.saturate(t.dot(s.view, half));
    const ExprId F = fSchlick(t, s.f0, s.f90, dotVH);
    return p.mul(p.mul(F, vGgxSmithCorrelated(t, alpha, dotNL, dotNV)), dGgx(t, alpha, dotNH));
}

// DFGLUT( roughness, dotNV ).rg
ExprId dfgLut(Tsl& t, const Surface& s, ExprId dotNV) {
    Program& p = t.p;
    return p.swizzle(p.sample(s.dfg, p.construct(Type::vec(2), {s.roughness, dotNV})), "xy");
}

// BRDF_GGX_Multiscatter
ExprId brdfGgxMultiscatter(Tsl& t, const Surface& s, ExprId light) {
    Program& p = t.p;
    const ExprId singleScatter = brdfGgx(t, s, light);
    const ExprId dotNL = t.saturate(t.dot(s.normal, light));
    const ExprId dotNV = t.saturate(t.dot(s.normal, s.view));
    const ExprId dfgV = dfgLut(t, s, dotNV);
    const ExprId dfgL = dfgLut(t, s, dotNL);
    const ExprId FssEssV = p.add(p.mul(s.f0, p.swizzle(dfgV, "x")), p.mul(s.f90, p.swizzle(dfgV, "y")));
    const ExprId FssEssL = p.add(p.mul(s.f0, p.swizzle(dfgL, "x")), p.mul(s.f90, p.swizzle(dfgL, "y")));
    const ExprId EssV = p.add(p.swizzle(dfgV, "x"), p.swizzle(dfgV, "y"));
    const ExprId EssL = p.add(p.swizzle(dfgL, "x"), p.swizzle(dfgL, "y"));
    const ExprId EmsV = p.sub(t.f(1), EssV);
    const ExprId EmsL = p.sub(t.f(1), EssL);
    const ExprId Favg = p.add(s.f0, p.mul(t.oneMinus(s.f0), t.f(0.047619f)));  // 1/21
    const ExprId Fms = p.div(p.mul(p.mul(FssEssV, FssEssL), Favg),
                             p.add(p.sub(t.f(1), p.mul(p.mul(p.mul(EmsV, EmsL), Favg), Favg)), t.f(kEpsilon)));
    const ExprId compensationFactor = p.mul(EmsV, EmsL);
    return p.add(singleScatter, p.mul(Fms, compensationFactor));
}

// D_BlinnPhong( dotNH ) = ( shininess * 0.5 + 1.0 ) * (1/pi) * pow( dotNH, shininess )
ExprId dBlinnPhong(Tsl& t, ExprId shininess, ExprId dotNH) {
    Program& p = t.p;
    const ExprId base = p.add(p.mul(shininess, t.f(0.5f)), t.f(1));
    return p.mul(p.mul(base, t.f(1 / kPi)), p.call("pow", {dotNH, shininess}));
}

// BRDF_BlinnPhong( lightDirection ): F_Schlick(specularColor, 1.0, dotVH) * 0.25 * D_BlinnPhong,
// with G_BlinnPhong_Implicit = float(0.25). lightDirection is view space, like normalView.
ExprId brdfBlinnPhong(Tsl& t, ExprId normalView, ExprId positionViewDirection, ExprId lightDirection,
                      ExprId specularColor, ExprId shininess) {
    Program& p = t.p;
    const ExprId halfDir = p.call("normalize", {p.add(lightDirection, positionViewDirection)});
    const ExprId dotNH = t.saturate(t.dot(normalView, halfDir));
    const ExprId dotVH = t.saturate(t.dot(positionViewDirection, halfDir));
    const ExprId F = fSchlick(t, specularColor, t.f(1), dotVH);
    return p.mul(p.mul(F, t.f(0.25f)), dBlinnPhong(t, shininess, dotNH));
}

// ---------------------------------------------------------------------------------------------
// Environment (IBL): three's PMREM cubeUV sampling, nodes/pmrem/PMREMUtils.js ported operation
// for operation. getFace/getUV/roughnessToMip/bilinearCubeUV/textureCubeUV, with the cubeUV layout
// constants the PMREM generator packs (r0=1, r1=0.8, r4=0.4, r5=0.305, r6=0.21 and their mips).

// getFace(direction): PMREM face index, RH/PMREM convention.
ExprId cubeFace(Program& p, ExprId direction) {
    auto f = [&](float v) { return p.constant(v); };
    const ExprId absDir = p.call("abs", {direction});
    const VarId face = p.var(Type::f32(), f(-1));
    auto pick = [&](const char* comp, float positive, float negative) {
        return p.select(p.less(f(0), p.swizzle(direction, comp)), f(positive), f(negative));
    };
    const ExprId x = p.swizzle(absDir, "x"), y = p.swizzle(absDir, "y"), z = p.swizzle(absDir, "z");
    p.If(p.less(z, x),
         [&] {
             p.If(p.less(y, x), [&] { p.assign(face, pick("x", 0, 3)); },
                 [&] { p.assign(face, pick("y", 1, 4)); });
         },
         [&] {
             p.If(p.less(y, z), [&] { p.assign(face, pick("z", 2, 5)); },
                 [&] { p.assign(face, pick("y", 1, 4)); });
         });
    return p.load(face);
}

// getUV(direction, face)
ExprId cubeUv(Program& p, ExprId direction, ExprId face) {
    auto f = [&](float v) { return p.constant(v); };
    auto v2 = [&](ExprId x, ExprId y) { return p.construct(Type::vec(2), {x, y}); };
    auto neg = [&](ExprId v) { return p.neg(v); };
    const ExprId d = direction;
    const ExprId ax = p.swizzle(p.call("abs", {d}), "x"), ay = p.swizzle(p.call("abs", {d}), "y"),
                 az = p.swizzle(p.call("abs", {d}), "z");
    const ExprId dx = p.swizzle(d, "x"), dy = p.swizzle(d, "y"), dz = p.swizzle(d, "z");
    const VarId uv = p.var(Type::vec(2), v2(f(0), f(0)));
    auto set = [&](ExprId value) { p.assign(uv, value); };
    p.If(p.equal(face, f(0)), [&] { set(p.div(v2(dz, dy), ax)); }, [&] {
        p.If(p.equal(face, f(1)), [&] { set(p.div(v2(neg(dx), neg(dz)), ay)); }, [&] {
            p.If(p.equal(face, f(2)), [&] { set(p.div(v2(neg(dx), dy), az)); }, [&] {
                p.If(p.equal(face, f(3)), [&] { set(p.div(v2(neg(dz), dy), ax)); }, [&] {
                    p.If(p.equal(face, f(4)), [&] { set(p.div(v2(neg(dx), dz), ay)); },
                         [&] { set(p.div(v2(dx, dy), az)); });
                });
            });
        });
    });
    return p.mul(f(0.5f), p.add(p.load(uv), v2(f(1), f(1))));
}

// roughnessToMip(roughness)
ExprId roughnessToMip(Program& p, ExprId roughness) {
    auto f = [&](float v) { return p.constant(v); };
    const VarId mip = p.var(Type::f32(), f(0));
    auto segment = [&](double rHigh, double rLow, double mHigh, double mLow) {
        // three emits unsuffixed WGSL literals: these constant subtractions fold as abstract-float,
        // then convert to f32. Subtracting already-rounded f32 breakpoints changes two denominators.
        return p.add(p.div(p.mul(p.sub(f(float(rHigh)), roughness), f(float(mLow - mHigh))),
                           f(float(rHigh - rLow))), f(float(mHigh)));
    };
    p.If(p.call("greaterEqual", {roughness, f(0.8f)}), [&] { p.assign(mip, segment(1.0, 0.8, -2.0, -1.0)); }, [&] {
        p.If(p.call("greaterEqual", {roughness, f(0.4f)}), [&] { p.assign(mip, segment(0.8, 0.4, -1.0, 2.0)); }, [&] {
            p.If(p.call("greaterEqual", {roughness, f(0.305f)}), [&] { p.assign(mip, segment(0.4, 0.305, 2.0, 3.0)); }, [&] {
                p.If(p.call("greaterEqual", {roughness, f(0.21f)}), [&] { p.assign(mip, segment(0.305, 0.21, 3.0, 4.0)); },
                     [&] { p.assign(mip, p.mul(f(-2.0f), p.call("log2", {p.mul(f(1.16f), roughness)}))); });
            });
        });
    });
    return p.load(mip);
}

// bilinearCubeUV(envMap, direction, mipInt)
ExprId bilinearCubeUV(Program& p, uint32_t env, ExprId direction, ExprId mipInt, const std::string& prefix) {
    auto f = [&](float v) { return p.constant(v); };
    auto v2 = [&](ExprId x, ExprId y) { return p.construct(Type::vec(2), {x, y}); };
    const VarId face = p.var(Type::f32(), cubeFace(p, direction));
    const ExprId filterInt = p.call("max", {p.sub(f(4), mipInt), f(0)});
    const ExprId clamped = p.call("max", {mipInt, f(4)});
    const ExprId faceSize = p.call("exp2", {clamped});
    const VarId uv = p.var(Type::vec(2), p.add(p.mul(cubeUv(p, direction, p.load(face)), p.sub(faceSize, f(2))), v2(f(1), f(1))));
    p.If(p.less(f(2), p.load(face)), [&] {
        p.assign(uv, p.add(p.load(uv), v2(f(0), faceSize)));
        p.assign(face, p.sub(p.load(face), f(3)));
    });
    ExprId x = p.add(p.swizzle(p.load(uv), "x"), p.mul(p.load(face), faceSize));
    x = p.add(x, p.mul(filterInt, f(48)));  // 3 * minTileSize(16)
    ExprId y = p.add(p.swizzle(p.load(uv), "y"),
                     p.mul(f(4), p.sub(p.call("exp2", {p.uniform(prefix + "MaxMip", Type::f32())}), faceSize)));
    x = p.mul(x, p.uniform(prefix + "TexelWidth", Type::f32()));
    y = p.mul(y, p.uniform(prefix + "TexelHeight", Type::f32()));
    return p.swizzle(p.sampleLevel(env, v2(x, y), f(0)), "xyz");
}

// textureCubeUV(envMap, sampleDir, roughness)
ExprId textureCubeUV(Program& p, uint32_t env, ExprId direction, ExprId roughness, const std::string& prefix = "envMap") {
    auto f = [&](float v) { return p.constant(v); };
    const ExprId mip = p.call("clamp", {roughnessToMip(p, roughness), f(-2.0f), p.uniform(prefix + "MaxMip", Type::f32())});
    const ExprId mipF = p.call("fract", {mip});
    const ExprId mipInt = p.call("floor", {mip});
    const VarId color = p.var(Type::vec(3), bilinearCubeUV(p, env, direction, mipInt, prefix));
    p.If(p.equal(mipF, f(0)), [] {}, [&] {
        const ExprId next = bilinearCubeUV(p, env, direction, p.add(mipInt, f(1)), prefix);
        p.assign(color, p.call("mix", {p.load(color), next, mipF}));
    });
    return p.load(color);
}

// three's computeMultiscattering, returning (singleScatter, multiScatter) for one f0.
struct Multiscatter {
    ExprId single;
    ExprId multi;
};
Multiscatter computeMultiscattering(Tsl& t, ExprId roughness, ExprId dotNV, ExprId f0, ExprId specularF90, uint32_t dfg) {
    Program& p = t.p;
    auto f = [&](float v) { return p.constant(v); };
    const ExprId fab = p.swizzle(p.sample(dfg, p.construct(Type::vec(2), {roughness, dotNV})), "xy");
    const ExprId FssEss = p.add(p.mul(f0, p.swizzle(fab, "x")), p.mul(specularF90, p.swizzle(fab, "y")));
    const ExprId Ess = p.add(p.swizzle(fab, "x"), p.swizzle(fab, "y"));
    const ExprId Ems = p.sub(f(1), Ess);
    const ExprId Favg = p.add(f0, p.mul(t.oneMinus(f0), f(0.047619f)));
    const ExprId Fms = p.div(p.mul(FssEss, Favg), p.sub(f(1), p.mul(Ems, Favg)));
    return {FssEss, p.mul(Fms, Ems)};
}

// three's `direction.transformDirection(cameraWorldMatrix)`: normalize((mat4 * vec4(v, 0)).xyz).
ExprId transformDirection(Program& p, ExprId m, ExprId v) {
    return p.call("normalize", {p.swizzle(p.mul(m, p.construct(Type::vec(4), {v, p.constant(0.0f)})), "xyz")});
}

}  // namespace

ExprId pmremSample(Program& p, uint32_t texture, ExprId direction, ExprId roughness, std::string_view prefix) {
    return textureCubeUV(p, texture, direction, roughness, std::string(prefix));
}

std::vector<std::string> unsupportedFeatures(const StandardMaterial& m) {
    std::vector<std::string> out;
    auto check = [&](float value, const char* feature) {
        if (value != 0) out.push_back(std::string("TN_MATERIAL_UNSUPPORTED ") + feature);
    };
    check(m.sheen, "sheen");
    check(m.transmission, "transmission");
    check(m.iridescence, "iridescence");
    check(m.anisotropy, "anisotropy");
    check(m.dispersion, "dispersion");
    return out;
}

// three's instance() on the local vertex: positionLocal = (instanceMatrix * positionLocal).xyz and
// normalLocal = transformNormal(normalLocal, instanceMatrix), i.e. normalize(transpose(inverse(
// mat3(instanceMatrix))) * normal). WGSL has no inverse(): for columns a, b, c the inverse transpose is
// mat3(cross(b, c), cross(c, a), cross(a, b)) / dot(a, cross(b, c)), the sign kept for mirrored instances.
struct LocalVertex {
    ExprId position;      // vec4, w = 1
    ExprId normal;        // vec3; kInvalid without one
    ExprId instanceColor; // vec3; kInvalid without one (outputInstanceColor)
    ExprId uv;            // vec2; kInvalid without a map (outputMapUv)
};

// The slot's requested type is three's subBuild/vecN/float conversion, including vector padding.
static ExprId nodeType(Program& p, ExprId id, Type type) {
    if (id == kInvalid) return p.call("invalid NodeMaterial expression", {});
    const Type source = p.expr(id).type;
    if (source.rows > type.rows && !source.isMatrix())
        return p.construct(type, {p.swizzle(id, std::string_view("xyzw").substr(0, type.rows))});
    if (source.isVector() && type.isVector() && source.rows < type.rows) {
        std::vector<ExprId> parts{id};
        for (unsigned lane = source.rows; lane < type.rows; ++lane) parts.push_back(p.constant(lane == 3 ? 1.0f : 0.0f));
        return p.construct(type, parts);
    }
    return p.construct(type, {id});
}

static LocalVertex localVertex(Program& v, const VertexVariant& variant, bool withNormal) {
    ExprId position = v.attribute("position", Type::vec(3));
    ExprId normal = withNormal ? v.attribute("normal", Type::vec(3)) : kInvalid;
    if (variant.morphTargets > 0) {
        // morphReference: scale by the base influence, then add each target times its influence,
        // in target order; texel = vertexIndex * stride + offset inside target i's block.
        const uint32_t data = v.storageBuffer("morphData", Type::vec(4));
        const uint32_t influences = v.storageBuffer("morphInfluences", Type::f32());
        const ExprId dataBase = v.construct(Type::u32(), {v.uniform("morphBase", Type::f32())});
        const ExprId influenceBase = v.construct(Type::u32(), {v.uniform("morphInfluenceBase", Type::f32())});
        const ExprId vertexCount = v.construct(Type::u32(), {v.uniform("morphVertexCount", Type::f32())});
        const ExprId base = v.uniform("morphBaseInfluence", Type::f32());
        const bool normals = variant.morphNormals && withNormal;
        const ExprId stride = v.constant(int32_t(variant.morphNormals ? 2 : 1));
        const ExprId strideU = v.construct(Type::u32(), {stride});
        const ExprId texel = v.mul(v.builtin("vertexIndex"), strideU);
        position = v.mul(position, base);
        if (normals) normal = v.mul(normal, base);
        for (int i = 0; i < variant.morphTargets; ++i) {
            const ExprId target = v.add(dataBase, v.mul(v.mul(v.construct(Type::u32(), {v.constant(i)}), vertexCount), strideU));
            const ExprId influence = v.loadStorage(influences, v.add(influenceBase, v.construct(Type::u32(), {v.constant(i)})));
            const ExprId at = v.add(target, texel);
            position = v.add(position, v.mul(v.swizzle(v.loadStorage(data, at), "xyz"), influence));
            if (normals)
                normal = v.add(normal, v.mul(v.swizzle(v.loadStorage(data, v.add(at, v.construct(Type::u32(), {v.constant(1)}))), "xyz"), influence));
        }
    }
    uint32_t instances = 0;
    ExprId instanceBase = kInvalid;
    if (variant.instanceStorage) {
        instances = v.storageBuffer("instances", Type::vec(4));
        instanceBase = v.add(v.construct(Type::u32(), {v.uniform("instanceBase", Type::f32())}),
                            v.mul(v.builtin("instanceIndex"), v.construct(Type::u32(), {v.constant(5)})));
    }
    if (variant.instanced) {
        const auto column = [&](int index) {
            return variant.instanceStorage
                ? v.loadStorage(instances, v.add(instanceBase, v.construct(Type::u32(), {v.constant(index)})))
                : v.attribute("instanceMatrix" + std::to_string(index), Type::vec(4));
        };
        const ExprId c0 = column(0), c1 = column(1), c2 = column(2), c3 = column(3);
        const ExprId matrix = v.construct(Type::mat(4, 4), {c0, c1, c2, c3});
        position = v.swizzle(v.mul(matrix, v.construct(Type::vec(4), {position, v.constant(1.0f)})), "xyz");
        if (withNormal) {
            const ExprId a = v.swizzle(c0, "xyz"), b = v.swizzle(c1, "xyz"), c = v.swizzle(c2, "xyz");
            const ExprId bc = v.call("cross", {b, c});
            const ExprId inverseTranspose =
                v.construct(Type::mat(3, 3), {bc, v.call("cross", {c, a}), v.call("cross", {a, b})});
            normal = v.call("normalize", {v.div(v.mul(inverseTranspose, normal), v.call("dot", {a, bc}))});
        }
    }
    if (variant.skinned) {
        // getSkinnedPosition and getSkinnedNormalAndTangent, operand for operand.
        const uint32_t bones = v.storageBuffer("boneMatrices", Type::mat(4, 4));
        ExprId base = v.construct(Type::u32(), {v.uniform("boneBase", Type::f32())});
        if (variant.skinnedPalette) {
            const ExprId stride = v.construct(Type::u32(), {v.uniform("boneStride", Type::f32())});
            base = v.add(base, v.mul(v.builtin("instanceIndex"), stride));
        }
        const ExprId index = v.attribute("skinIndex", Type::vec(4, Type::Scalar::U32));
        const ExprId weight = v.attribute("skinWeight", Type::vec(4));
        const ExprId bindMatrix = v.uniform("bindMatrix", Type::mat(4, 4));
        const ExprId bindMatrixInverse = v.uniform("bindMatrixInverse", Type::mat(4, 4));
        ExprId bone[4], w[4];
        for (int k = 0; k < 4; ++k) {
            const char lane[2] = {"xyzw"[k], 0};
            bone[k] = v.loadStorage(bones, v.add(base, v.swizzle(index, lane)));
            w[k] = v.swizzle(weight, lane);
        }
        const ExprId skinVertex = v.mul(bindMatrix, v.construct(Type::vec(4), {position, v.constant(1.0f)}));
        ExprId skinned = kInvalid;
        for (int k = 0; k < 4; ++k) {
            const ExprId term = v.mul(v.mul(bone[k], w[k]), skinVertex);
            skinned = skinned == kInvalid ? term : v.add(skinned, term);
        }
        position = v.swizzle(v.mul(bindMatrixInverse, skinned), "xyz");
        if (withNormal) {
            ExprId skinMatrix = kInvalid;
            for (int k = 0; k < 4; ++k) {
                const ExprId term = v.mul(w[k], bone[k]);
                skinMatrix = skinMatrix == kInvalid ? term : v.add(skinMatrix, term);
            }
            skinMatrix = v.mul(v.mul(bindMatrixInverse, skinMatrix), bindMatrix);
            // transformDirection: normalize((matrix * vec4(direction, 0)).xyz)
            normal = v.call("normalize", {v.swizzle(v.mul(skinMatrix, v.construct(Type::vec(4), {normal, v.constant(0.0f)})), "xyz")});
        }
    }
    // NodeMaterial.setupPosition: `positionLocal.assign(positionNode)` after morph, skinning and instancing.
    if (variant.positionNode) position = variant.positionNode->build(v, position);
    if (variant.nodes.positionNode) {
        tsl::Build build(v);
        position = nodeType(v, graph::lower(variant.nodes.positionNode, v, {{"positionLocal", position}}), Type::vec(3));
    }
    ExprId instanceColor = !variant.instanceColor ? kInvalid : variant.instanceStorage
        ? v.swizzle(v.loadStorage(instances, v.add(instanceBase, v.construct(Type::u32(), {v.constant(4)}))), "xyz")
        : v.attribute("instanceColor", Type::vec(3));
    // setupDiffuseColor: colorNode.mul(vertexColor()), a vec4 whose alpha is 1 for an rgb attribute. The
    // instance colour is constant over a triangle, so their product interpolates as three's two factors.
    if (variant.vertexColors) {
        ExprId vertexColor = v.attribute("color", Type::vec(variant.vertexColors));
        if (variant.vertexColors == 3) vertexColor = v.construct(Type::vec(4), {vertexColor, v.constant(1.0f)});
        instanceColor = instanceColor == kInvalid ? vertexColor
            : v.mul(v.construct(Type::vec(4), {instanceColor, v.constant(1.0f)}), vertexColor);
    }
    const ExprId uv = (variant.map || variant.normalMap || variant.pbrMaps) && !variant.background ? v.attribute("uv", Type::vec(2)) : kInvalid;
    return {v.construct(Type::vec(4), {position, v.constant(1.0f)}), normal, instanceColor, uv};
}

// NodeMaterial.setupVertex: a vertexNode is the clip-space position itself; positionLocal (after
// morph, skinning, instancing and positionNode) is what it reads.
static ExprId clipPosition(Program& v, const VertexVariant& variant, const LocalVertex& local, ExprId clip) {
    if (!variant.nodes.vertexNode) return clip;
    tsl::Build build(v);
    return nodeType(v, graph::lower(variant.nodes.vertexNode, v, {{"positionLocal", v.swizzle(local.position, "xyz")}}),
                    Type::vec(4));
}

static void outputInstanceColor(Program& v, const LocalVertex& local) {
    if (local.instanceColor != kInvalid) v.output("instanceColor", local.instanceColor);
}

// A map's uv varying; linkNodes moves it to the location the fragment reads it at.
static void outputMapUv(Program& v, const LocalVertex& local) {
    if (local.uv != kInvalid) v.output("uv", local.uv);
}

// three's sRGBTransferEOTF (ColorManagement): one sRGB channel to linear-sRGB, its exact constants
// and order: `c <= 0.04045 ? c * 0.0773993808 : pow(c * 0.9478672986 + 0.0521327014, 2.4)`.
// NodeMaterial.setupFog: after lighting/emissive, before tone mapping; alpha is unchanged.
ExprId fogColor(Program& f, const VertexVariant& variant, ExprId outgoing);

// NodeMaterial.setup: `vec4(outgoingLight, diffuseColor.a).max(0)`, which forces unsigned output,
// then setupOutput mixes the fog into the clamped colour.
ExprId materialOutput(Program& f, const VertexVariant& variant, ExprId outgoing, ExprId alpha) {
    const ExprId clamped = f.call("max", {f.construct(Type::vec(4), {outgoing, alpha}),
                                          f.construct(Type::vec(4), {f.constant(0.0f)})});
    if (!variant.fog) return clamped;  // no fog to mix: one clamp expression, not one per lane
    return f.construct(Type::vec(4), {fogColor(f, variant, f.swizzle(clamped, "xyz")), f.swizzle(clamped, "w")});
}

ExprId fogColor(Program& f, const VertexVariant& variant, ExprId outgoing) {
    if (!variant.fog) return outgoing;
    const ExprId viewZ = f.neg(f.swizzle(f.varying("positionView", Type::vec(3)), "z"));
    const ExprId factor = fogFactor(f, variant.fog, viewZ,
        f.uniform(variant.fog == 2 ? "fogDensity" : "fogNear", Type::f32()),
        variant.fog == 2 ? kInvalid : f.uniform("fogFar", Type::f32()));
    return f.call("mix", {outgoing, f.uniform("fogColor", Type::vec(3)), factor});
}

static ExprId srgbDecode(Program& f, ExprId channel) {
    const ExprId a = f.call("pow", {f.add(f.mul(channel, f.constant(0.9478672986f)), f.constant(0.0521327014f)),
                                    f.constant(2.4f)});
    const ExprId b = f.mul(channel, f.constant(0.0773993808f));
    return f.select(f.less(channel, f.constant(0.04045f)), b, a);
}

// NormalMapNode for a tangent-space map on a geometry without tangents: three's perturbNormal2Arb,
// the tangent frame from the screen-space derivatives of the view position and the uv. The map
// is linear data; normalScale scales the xy of the decoded vector. faceDirection flips the frame for a
// back face. Called after the fragment's other varyings exist, so `uv` takes the vertex stage's slot.
static ExprId perturbNormal2Arb(Program& f, ExprId eye, ExprId uv, ExprId surfaceNormal, ExprId mapN);

// The tint varying: the instance colour (vec3), or a vec4 once a vertex colour multiplies it.
static Type tintType(const VertexVariant& variant) { return Type::vec(variant.vertexColors ? 4 : 3); }

static ExprId perturbedNormal(Program& f, const VertexVariant& variant, ExprId surfaceNormal) {
    const ExprId eye = f.varying("positionView", Type::vec(3));
    if (variant.tinted()) f.varying("instanceColor", tintType(variant));
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId transform = f.uniform("normalUvTransform", Type::mat(3, 3));
    const ExprId at = f.swizzle(f.mul(transform, f.construct(Type::vec(3), {uv, f.constant(1.0f)})), "xy");
    const ExprId texel = f.swizzle(f.sample(f.texture2d("normalMap"), at), "xyz");
    const ExprId decoded = f.sub(f.mul(texel, f.constant(2.0f)), f.constant(1.0f));
    const ExprId scaled = f.mul(f.swizzle(decoded, "xy"), f.uniform("normalScale", Type::vec(2)));
    const ExprId mapN = f.construct(Type::vec(3), {scaled, f.swizzle(decoded, "z")});
    return perturbNormal2Arb(f, eye, uv, surfaceNormal, mapN);
}

// perturbNormal2Arb's frame: the tangent and bitangent from the screen-space derivatives of the view
// position `eye` and the geometry `uv`, around `surfaceNormal`, applied to the decoded `mapN`.
static ExprId perturbNormal2Arb(Program& f, ExprId eye, ExprId uv, ExprId surfaceNormal, ExprId mapN) {
    const ExprId q0 = f.call("dFdx", {eye}), q1 = f.call("dFdy", {eye});
    // TangentUtils takes the derivatives of the geometry's uv itself, not of the map's transformed uv.
    const ExprId st0 = f.call("dFdx", {uv}), st1 = f.call("dFdy", {uv});
    const ExprId q1perp = f.call("cross", {q1, surfaceNormal}), q0perp = f.call("cross", {surfaceNormal, q0});
    const ExprId T = f.add(f.mul(q1perp, f.swizzle(st0, "x")), f.mul(q0perp, f.swizzle(st1, "x")));
    const ExprId B = f.add(f.mul(q1perp, f.swizzle(st0, "y")), f.mul(q0perp, f.swizzle(st1, "y")));
    const ExprId det = f.call("max", {f.call("dot", {T, T}), f.call("dot", {B, B})});
    const ExprId faceDirection = f.select(f.builtin("frontFacing"), f.constant(1.0f), f.constant(-1.0f));
    const ExprId scale = f.mul(faceDirection, f.div(f.constant(1.0f), f.call("sqrt", {det})));
    const ExprId result = f.add(f.add(f.mul(T, f.mul(f.swizzle(mapN, "x"), scale)), f.mul(B, f.mul(f.swizzle(mapN, "y"), scale))),
                                f.mul(surfaceNormal, f.swizzle(mapN, "z")));
    // Held in a variable: the derivatives above must run in uniform control flow, and a pure
    // expression is emitted where it is used, which can be inside a later light or environment branch.
    return f.load(f.var(Type::vec(3), f.call("normalize", {result})));
}

// MaterialNode's texture for a PbrMap: its own uv transform over the geometry's uv. Declares
// instanceColor before uv so the fragment's varyings keep the vertex stage's order.
static ExprId pbrTexel(Program& f, const VertexVariant& variant, PbrMap map) {
    const std::string name = kPbrMapNames[map];
    if (variant.tinted()) f.varying("instanceColor", tintType(variant));
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId transform = f.uniform(name + "UvTransform", Type::mat(3, 3));
    return f.sample(f.texture2d(name), f.swizzle(f.mul(transform, f.construct(Type::vec(3), {uv, f.constant(1.0f)})), "xy"));
}

// MaterialNode.NORMAL with a bumpMap and no normalMap: three's BumpMapNode (Mikkelsen's surface
// gradient), its height the map's red channel times bumpScale, sampled at the uv and at the uv
// stepped by its screen derivatives (dHdxy_fwd), then perturbNormalArb around the material normal.
static ExprId bumpedNormal(Program& f, const VertexVariant& variant, ExprId surfaceNormal) {
    const ExprId eye = f.varying("positionView", Type::vec(3));
    if (variant.tinted()) f.varying("instanceColor", tintType(variant));
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId transform = f.uniform(std::string(kPbrMapNames[kBumpMap]) + "UvTransform", Type::mat(3, 3));
    const uint32_t map = f.texture2d(kPbrMapNames[kBumpMap]);
    const auto height = [&](ExprId coordinate) {
        const ExprId at = f.swizzle(f.mul(transform, f.construct(Type::vec(3), {coordinate, f.constant(1.0f)})), "xy");
        return f.swizzle(f.sample(map, at), "x");
    };
    const ExprId scale = f.uniform("bumpScale", Type::f32());
    const ExprId Hll = height(uv);
    const ExprId dHdx = f.mul(f.sub(height(f.add(uv, f.call("dFdx", {uv}))), Hll), scale);
    const ExprId dHdy = f.mul(f.sub(height(f.add(uv, f.call("dFdy", {uv}))), Hll), scale);
    const ExprId vSigmaX = f.call("normalize", {f.call("dFdx", {eye})});
    const ExprId vSigmaY = f.call("normalize", {f.call("dFdy", {eye})});
    const ExprId R1 = f.call("cross", {vSigmaY, surfaceNormal});
    const ExprId R2 = f.call("cross", {surfaceNormal, vSigmaX});
    const ExprId faceDirection = f.select(f.builtin("frontFacing"), f.constant(1.0f), f.constant(-1.0f));
    const ExprId fDet = f.mul(f.call("dot", {vSigmaX, R1}), faceDirection);
    const ExprId vGrad = f.mul(f.call("sign", {fDet}), f.add(f.mul(dHdx, R1), f.mul(dHdy, R2)));
    // Held in a variable: its derivatives must run in uniform control flow, as perturbedNormal's do.
    return f.load(f.var(Type::vec(3), f.call("normalize", {f.sub(f.mul(f.call("abs", {fDet}), surfaceNormal), vGrad)})));
}

// MaterialNode.CLEARCOAT_NORMAL with a clearcoatNormalMap: normalMap(clearcoatNormalMap,
// clearcoatNormalScale), a tangent-space map whose frame surrounds the material's own normal (three's
// normalView outside the NORMAL sub-build). Without the map the clearcoat normal is that normal.
static ExprId clearcoatNormal(Program& f, const VertexVariant& variant, ExprId materialNormal) {
    if (!variant.reads(kClearcoatNormalMap)) return materialNormal;
    const ExprId eye = f.varying("positionView", Type::vec(3));
    const ExprId texel = f.swizzle(pbrTexel(f, variant, kClearcoatNormalMap), "xyz");
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId decoded = f.sub(f.mul(texel, f.constant(2.0f)), f.constant(1.0f));
    const ExprId scaled = f.mul(f.swizzle(decoded, "xy"), f.uniform("clearcoatNormalScale", Type::vec(2)));
    const ExprId mapN = f.construct(Type::vec(3), {scaled, f.swizzle(decoded, "z")});
    return perturbNormal2Arb(f, eye, uv, materialNormal, mapN);
}

// three's setupDiffuseColor: the map texel multiplies the diffuse colour and alpha. It is sampled at
// the texture's uv transform (repeat/offset/rotation/center); an sRGB map is decoded here, as
// upstream's ColorSpaceNode does, so the sample is linear.
static ExprId mapTexel(Program& f, const VertexVariant& variant) {
    if (!variant.map) return kInvalid;
    const ExprId uv = f.varying("uv", Type::vec(2));
    const ExprId transform = f.uniform("uvTransform", Type::mat(3, 3));
    const ExprId at = f.swizzle(f.mul(transform, f.construct(Type::vec(3), {uv, f.constant(1.0f)})), "xy");
    const ExprId texel = f.sample(f.texture2d("map"), at);
    if (!variant.mapSRGB) return texel;
    const ExprId rgb = f.construct(Type::vec(3), {srgbDecode(f, f.swizzle(texel, "x")),
                                                   srgbDecode(f, f.swizzle(texel, "y")),
                                                   srgbDecode(f, f.swizzle(texel, "z"))});
    return f.construct(Type::vec(4), {rgb, f.swizzle(texel, "w")});
}

// setupDiffuseColor: an instanced mesh with instanceColor multiplies the material colour by it.
static ExprId materialColor(Program& f, const VertexVariant& variant, ExprId diffuse) {
    const ExprId color = f.swizzle(diffuse, "xyz");
    if (!variant.tinted()) return color;
    const ExprId tint = f.varying("instanceColor", tintType(variant));
    return f.mul(variant.vertexColors ? f.swizzle(tint, "xyz") : tint, color);
}

// negateOnBackSide for DoubleSide: three's normalView is the geometry normal times faceDirection
// (float(frontFacing) * 2 - 1), so a back face is lit from the side the viewer sees. BackSide is
// negated in the vertex stage; FrontSide never rasterizes a back face.
static ExprId facedNormal(Program& f, const VertexVariant& variant, ExprId normal) {
    if (!variant.doubleSide) return normal;
    const ExprId front = f.select(f.builtin("frontFacing"), f.constant(1.0f), f.constant(0.0f));
    return f.mul(normal, f.sub(f.mul(front, f.constant(2.0f)), f.constant(1.0f)));
}

// The node slots replace upstream's material accessors, not their already-mapped results. `normalView`
// is what a slot's normalView and normalWorld read: three's NodeMaterial.setupNormal, the geometry normal
// flipped on a DoubleSide back face, then the normalNode or the normal map; inside normalNode itself it
// is the flipped geometry normal. Without one the graph reads the interpolated varying.
static ExprId nodeValue(Program& f, const graph::Node& node, Type type, ExprId fallback,
                        ExprId normalView = kInvalid, ExprId geometryNormal = kInvalid) {
    if (!node) return fallback;
    tsl::Build build(f);
    std::unordered_map<std::string, ExprId> inputs;
    if (normalView != kInvalid) inputs.emplace("normalView", normalView);
    if (geometryNormal != kInvalid) inputs.emplace("normalViewGeometry", geometryNormal);
    return nodeType(f, graph::lower(node, f, inputs), type);
}

static ExprId diffuseAlpha(Program& f, const VertexVariant& variant, ExprId diffuse, ExprId texel) {
    ExprId alpha = f.swizzle(diffuse, "w");
    if (variant.vertexColors) alpha = f.mul(alpha, f.swizzle(f.varying("instanceColor", tintType(variant)), "w"));
    if (variant.nodes.colorNode) {
        alpha = f.mul(alpha, nodeValue(f, variant.nodes.opacityNode, Type::f32(),
                                       f.swizzle(f.uniform("diffuse", Type::vec(4)), "w")));
    } else {
        if (texel != kInvalid) alpha = f.mul(alpha, f.swizzle(texel, "w"));
        if (variant.nodes.opacityNode) {
            // material colour's alpha is the map alpha; opacityNode replaces material.opacity.
            alpha = f.mul(texel == kInvalid ? f.constant(1.0f) : f.swizzle(texel, "w"),
                          nodeValue(f, variant.nodes.opacityNode, Type::f32(), kInvalid));
        }
    }
    return alpha;
}

// Graph attributes can be first used in any slot. Link the two stages by name, in fragment order.
static void linkNodes(StandardPrograms& out, const VertexVariant& variant, const LocalVertex& local) {
    bool hasNodes = false;
    for (const auto& node : variant.nodes.graphs()) hasNodes |= bool(node);
    // Every builder ends here: the fragment's read order, not declaration order, fixes the locations.
    if (!hasNodes) return out.vertex.linkVaryings(out.fragment);
    Program& v = out.vertex;
    // varying(node): the vertex stage computes each node the fragment reads by its varying name.
    std::unordered_map<std::string, graph::Node> carried;
    std::unordered_set<const graph::NodeData*> seen;
    const std::function<void(const graph::Node&)> collect = [&](const graph::Node& n) {
        if (!n || !seen.insert(n.get()).second) return;
        if (n->kind == graph::Kind::Varying && !n->args.empty()) {
            const auto [it, fresh] = carried.emplace(n->name, n);
            if (!fresh && graph::key(it->second) != graph::key(n))
                throw std::runtime_error("TN_TSL_VARYING_CONFLICT: " + n->name);
        }
        for (const auto* list : {&n->args, &n->body, &n->otherwise})
            for (const auto& child : *list) collect(child);
    };
    for (const auto& node : variant.nodes.graphs()) collect(node);
    for (const auto& [name, type] : out.fragment.varyings()) {
        if (name == "normalView" || (name == "positionView" && v.hasOutput(name)) ||
            (name == "instanceColor" && variant.tinted()) || (name == "uv" && (variant.map || variant.normalMap || variant.pbrMaps))) continue;
        ExprId value;
        if (const auto found = carried.find(name); found != carried.end()) {
            tsl::Build build(v);
            value = graph::lower(found->second->args[0], v, {{"positionLocal", v.swizzle(local.position, "xyz")}});
        } else if (name == "positionWorld")
            value = v.swizzle(v.mul(v.uniform("modelMatrix", Type::mat(4, 4)), local.position), "xyz");
        else if (name == "positionLocal") value = v.swizzle(local.position, "xyz");
        // positionView for a program that does not light (linearDepth() of the fragment): view * model * position.
        else if (name == "positionView")
            value = v.swizzle(v.mul(v.uniform("viewMatrix", Type::mat(4, 4)),
                                    v.mul(v.uniform("modelMatrix", Type::mat(4, 4)), local.position)), "xyz");
        // r185's positionViewDirection: positionView.negate() carried to the fragment, normalized there.
        else if (name == "positionViewDirection")
            value = v.neg(v.swizzle(v.mul(v.uniform("viewMatrix", Type::mat(4, 4)),
                                          v.mul(v.uniform("modelMatrix", Type::mat(4, 4)), local.position)), "xyz"));
        // r185's normalWorldGeometry: normalViewGeometry (transformNormalToView(normalLocal)) back through
        // the view matrix, which is modelNormalMatrix * normalLocal, the inverse transpose, so a
        // non-uniform scale keeps it perpendicular. Neither a normalNode nor a normal map reaches it.
        else if (name == "normalWorldGeometry" && local.normal != kInvalid)
            value = v.mul(v.uniform("modelNormalMatrix", Type::mat(3, 3)), local.normal);
        else if (name == "positionGeometry") value = v.attribute("position", type);
        else value = v.attribute(name, type);
        v.output(name, value);
    }
    v.linkVaryings(out.fragment);
}

// One direct light's direction and colour, three's setupDirect for DirectionalLightNode,
// PointLightNode (directPointLight with getDistanceAttenuation) and SpotLightNode (that, times
// smoothstep(coneCos, penumbraCos, angleCos)), at the fragment's view-space position.
struct Incoming {
    ExprId direction;
    ExprId color;
};

// interleavedGradientNoise(screenCoordinate.xy) * 2pi, PCF's per-pixel rotation.
static ExprId noisePhi(Program& f, Tsl& t) {
    const ExprId coordinate = f.swizzle(f.builtin("position"), "xy");
    const ExprId noise = f.call("fract", {f.mul(t.f(52.9829189f), f.call("fract", {t.dot(coordinate, f.construct(Type::vec(2), {t.f(0.06711056f), t.f(0.00583715f)}))}))});
    return f.mul(noise, t.f(6.28318530718f));
}

// vogelDiskSample(i, 5, phi): r = sqrt((i + 0.5) / 5), theta = i * goldenAngle + phi.
static ExprId vogelDisk(Program& f, Tsl& t, int i, ExprId phi) {
    const ExprId index = t.f(static_cast<float>(i));
    const ExprId r = f.call("sqrt", {f.div(f.add(index, t.f(0.5f)), t.f(5.0f))});
    const ExprId theta = f.add(f.mul(index, t.f(2.399963229728653f)), phi);
    return f.mul(f.construct(Type::vec(2), {f.call("cos", {theta}), f.call("sin", {theta})}), r);
}

// three's ShadowNode for a light's shadow under PCFShadowMap (the default type, with texture compare):
// shadowPosition = shadowMatrix * (positionWorld + normalWorld * normalBias), divided by w, y flipped,
// z biased; PCFShadowFilter's five Vogel-disk taps rotated by interleaved gradient noise of the
// fragment coordinate; 1 outside the shadow frustum; then mix(1, shadow, intensity).
// three's PCFSoftShadowFilter: the uv snapped to the texel grid, four gathers around it compared with
// z, and the 3x3 texel footprint weighted by the fractional position, over nine.
static ExprId softShadowSamples(Program& f, Tsl& t, uint32_t map, ExprId uv, ExprId z, ExprId mapSize) {
    const ExprId texelSize = f.div(f.construct(Type::vec(2), {t.f(1)}), mapSize);
    const ExprId fr = f.call("fract", {f.add(f.mul(uv, mapSize), f.construct(Type::vec(2), {t.f(0.5f)}))});
    const ExprId snapped = f.sub(uv, f.mul(f.sub(fr, f.construct(Type::vec(2), {t.f(0.5f)})), texelSize));
    const ExprId c1 = f.gatherCompare(map, snapped, z, -1, 1);
    const ExprId c2 = f.gatherCompare(map, snapped, z, 1, 1);
    const ExprId c3 = f.gatherCompare(map, snapped, z, -1, -1);
    const ExprId c4 = f.gatherCompare(map, snapped, z, 1, -1);
    const ExprId fx = f.swizzle(fr, "x"), fy = f.swizzle(fr, "y");
    const auto lane = [&](ExprId v, const char* c) { return f.swizzle(v, c); };
    const ExprId row1 = f.mul(f.add(f.add(f.call("mix", {lane(c1, "x"), lane(c2, "y"), fx}), lane(c1, "y")), lane(c2, "x")), fy);
    const ExprId row2 = f.add(f.add(f.call("mix", {lane(c1, "w"), lane(c2, "z"), fx}), lane(c1, "z")), lane(c2, "w"));
    const ExprId row3 = f.add(f.add(f.call("mix", {lane(c3, "x"), lane(c4, "y"), fx}), lane(c3, "y")), lane(c4, "x"));
    const ExprId row4 = f.mul(f.add(f.add(f.call("mix", {lane(c3, "w"), lane(c4, "z"), fx}), lane(c3, "z")), lane(c4, "w")),
                              t.oneMinus(fy));
    return f.mul(f.add(f.add(f.add(row1, row2), row3), row4), t.f(1.0f / 9.0f));
}

static ExprId shadowFactor(Program& f, Tsl& t, std::size_t index, ExprId positionWorld, ExprId normalWorld, bool soft) {
    const std::string at = "light" + std::to_string(index);
    const uint32_t map = f.textureDepth("shadow" + std::to_string(index));
    const ExprId world = f.add(positionWorld, f.mul(normalWorld, f.uniform(at + "ShadowNormalBias", Type::f32())));
    const ExprId shadowPosition =
        f.mul(f.uniform(at + "ShadowMatrix", Type::mat(4, 4)), f.construct(Type::vec(4), {world, t.f(1)}));
    const ExprId projected = f.div(f.swizzle(shadowPosition, "xyz"), f.swizzle(shadowPosition, "w"));
    const ExprId x = f.swizzle(projected, "x"), y = t.oneMinus(f.swizzle(projected, "y"));
    const ExprId z = f.add(f.swizzle(projected, "z"), f.uniform(at + "ShadowBias", Type::f32()));
    const ExprId uv = f.construct(Type::vec(2), {x, y});
    ExprId shadow = kInvalid;
    if (soft) {
        shadow = softShadowSamples(f, t, map, uv, z, f.uniform(at + "ShadowMapSize", Type::vec(2)));
    } else {
        const ExprId texelSize = f.div(f.construct(Type::vec(2), {t.f(1)}), f.uniform(at + "ShadowMapSize", Type::vec(2)));
        const ExprId radiusScaled = f.mul(f.uniform(at + "ShadowRadius", Type::f32()), f.swizzle(texelSize, "x"));
        const ExprId phi = noisePhi(f, t);
        ExprId sum = kInvalid;
        for (int i = 0; i < 5; ++i) {
            const ExprId disk = vogelDisk(f, t, i, phi);
            const ExprId tap = f.sampleCompare(map, f.add(uv, f.mul(disk, radiusScaled)), z);
            sum = sum == kInvalid ? tap : f.add(sum, tap);
        }
        shadow = f.mul(sum, t.f(1.0f / 5.0f));
    }
    // frustumTest: x and y in [0, 1] and z <= 1, else 1.
    shadow = f.select(f.less(x, t.f(0)), t.f(1), shadow);
    shadow = f.select(f.less(t.f(1), x), t.f(1), shadow);
    shadow = f.select(f.less(y, t.f(0)), t.f(1), shadow);
    shadow = f.select(f.less(t.f(1), y), t.f(1), shadow);
    shadow = f.select(f.less(t.f(1), z), t.f(1), shadow);
    return f.call("mix", {t.f(1), shadow, f.uniform(at + "ShadowIntensity", Type::f32())});
}

// three's PointShadowNode under PCFShadowMap: the shadow position is the world offset from the light
// (shadow.matrix is a translation); viewZ is its largest axis, outside [near, far] the factor is 1;
// the reference depth is viewZToPerspectiveDepth(-viewZ) + bias; PointShadowFilter's five taps lie in
// the plane across the direction, sampled from the cube with y negated (WebGPU), then
// mix(1, shadow, intensity).
static ExprId pointShadowFactor(Program& f, Tsl& t, std::size_t index, ExprId positionWorld, ExprId normalWorld) {
    const std::string at = "light" + std::to_string(index);
    const uint32_t map = f.textureDepth("shadowCube" + std::to_string(index), true);
    const ExprId world = f.add(positionWorld, f.mul(normalWorld, f.uniform(at + "ShadowNormalBias", Type::f32())));
    const ExprId shadowPosition = f.swizzle(
        f.mul(f.uniform(at + "ShadowMatrix", Type::mat(4, 4)), f.construct(Type::vec(4), {world, t.f(1)})), "xyz");
    const ExprId absolute = f.call("abs", {shadowPosition});
    const ExprId viewZ = f.call("max", {f.call("max", {f.swizzle(absolute, "x"), f.swizzle(absolute, "y")}), f.swizzle(absolute, "z")});
    const ExprId near = f.uniform(at + "ShadowNear", Type::f32()), far = f.uniform(at + "ShadowFar", Type::f32());
    const ExprId negated = f.neg(viewZ);
    const ExprId dp = f.add(f.div(f.mul(f.add(near, negated), far), f.mul(f.sub(far, near), negated)),
                            f.uniform(at + "ShadowBias", Type::f32()));
    const ExprId direction = f.call("normalize", {shadowPosition});
    const ExprId texelSize = f.div(f.uniform(at + "ShadowRadius", Type::f32()),
                                   f.swizzle(f.uniform(at + "ShadowMapSize", Type::vec(2)), "x"));
    const ExprId absDir = f.call("abs", {direction});
    const ExprId axis = f.select(f.less(f.swizzle(absDir, "z"), f.swizzle(absDir, "x")),
                                 f.construct(Type::vec(3), {t.f(0), t.f(1), t.f(0)}),
                                 f.construct(Type::vec(3), {t.f(1), t.f(0), t.f(0)}));
    const ExprId tangent = f.call("normalize", {f.call("cross", {direction, axis})});
    const ExprId bitangent = f.call("cross", {direction, tangent});
    const ExprId phi = noisePhi(f, t);
    ExprId sum = kInvalid;
    for (int i = 0; i < 5; ++i) {
        const ExprId disk = vogelDisk(f, t, i, phi);
        const ExprId offset = f.mul(f.add(f.mul(tangent, f.swizzle(disk, "x")), f.mul(bitangent, f.swizzle(disk, "y"))), texelSize);
        const ExprId sample = f.add(direction, offset);
        const ExprId flipped = f.construct(Type::vec(3), {f.swizzle(sample, "x"), f.neg(f.swizzle(sample, "y")), f.swizzle(sample, "z")});
        const ExprId tap = f.sampleCompare(map, flipped, dp);
        sum = sum == kInvalid ? tap : f.add(sum, tap);
    }
    ExprId shadow = f.mul(sum, t.f(1.0f / 5.0f));
    shadow = f.select(f.less(t.f(0), f.sub(viewZ, far)), t.f(1), shadow);
    shadow = f.select(f.less(f.sub(viewZ, near), t.f(0)), t.f(1), shadow);
    return f.call("mix", {t.f(1), shadow, f.uniform(at + "ShadowIntensity", Type::f32())});
}

// VirtualShadowNode's stock PCF filter and coarse-to-fine guarded blending. Physical pages
// replace only the texture addressing; all coordinates and filter operations remain level-local.
static ExprId virtualShadowFactor(Program& f, Tsl& t, std::size_t index, int levels,
                                  ExprId positionWorld, ExprId normalWorld) {
    const std::string at = "light" + std::to_string(index);
    const uint32_t map = f.textureDepth("vsm" + std::to_string(index));
    const uint32_t table = f.storageBuffer("vsmTable" + std::to_string(index), Type::vec(4));
    auto row = [&](int i) { return f.loadStorage(table, f.construct(Type::u32(), {f.constant(int32_t(i))})); };
    const ExprId world = f.add(positionWorld, f.mul(normalWorld, f.uniform(at + "ShadowNormalBias", Type::f32())));
    const ExprId plane = f.call("cross", {f.call("dFdx", {positionWorld}), f.call("dFdy", {positionWorld})});
    const ExprId phi = noisePhi(f, t);
    ExprId result = t.f(1);
    for (int l = levels - 1; l >= 0; --l) {
        const ExprId matrix = f.construct(Type::mat(4, 4), {row(l*9), row(l*9+1), row(l*9+2), row(l*9+3)});
        const ExprId window = row(l*9+4), u = row(l*9+5), v = row(l*9+6), w = row(l*9+7), params = row(l*9+8);
        const ExprId mapSize = f.swizzle(u, "w"), tiles = f.swizzle(v, "w"), span = f.swizzle(w, "w");
        const ExprId axisU = f.swizzle(u, "xyz"), axisV = f.swizzle(v, "xyz"), axisW = f.swizzle(w, "xyz");
        const ExprId extent = f.swizzle(window, "z"), guard = f.swizzle(window, "w");
        const ExprId projected4 = f.mul(matrix, f.construct(Type::vec(4), {world, t.f(1)}));
        const ExprId projected = f.div(f.swizzle(projected4, "xyz"), f.swizzle(projected4, "w"));
        const ExprId uv = f.construct(Type::vec(2), {f.swizzle(projected, "x"), t.oneMinus(f.swizzle(projected, "y"))});
        const ExprId along = f.call("max", {f.call("abs", {t.dot(plane, axisW)}),
            f.call("max", {f.mul(f.call("length", {plane}), t.f(0.0001f)), t.f(1e-12f)})});
        const ExprId slope = f.div(f.add(f.call("abs", {t.dot(plane, axisU)}), f.call("abs", {t.dot(plane, axisV)})), along);
        const ExprId radius = f.uniform(at + "ShadowRadius", Type::f32());
        const ExprId footprint = f.add(f.call("max", {radius, t.f(0)}), t.f(1));
        // table entry.w carries receiverPlaneBias so changing the policy never changes a program.
        const ExprId slopeBias = f.mul(f.div(f.div(f.mul(slope, f.mul(extent, t.f(2))), mapSize), span), footprint);
        const ExprId baseZ = f.add(f.swizzle(projected, "z"), f.uniform(at + "ShadowBias", Type::f32()));
        ExprId sum = kInvalid;
        for (int tap = 0; tap < 5; ++tap) {
            const ExprId sampleUv = f.call("clamp", {f.add(uv, f.mul(vogelDisk(f, t, tap, phi), f.div(radius, mapSize))),
                f.construct(Type::vec(2), {t.f(0)}), f.construct(Type::vec(2), {t.f(1)})});
            const ExprId grid = f.mul(sampleUv, tiles);
            const ExprId tile = f.call("min", {f.call("floor", {grid}), f.construct(Type::vec(2), {f.sub(tiles, t.f(1))})});
            const ExprId pageIndex = f.add(t.f(float(levels*9)), f.add(f.mul(t.f(float(l)), f.mul(tiles, tiles)),
                f.add(f.mul(f.swizzle(tile, "y"), tiles), f.swizzle(tile, "x"))));
            const ExprId entry = f.loadStorage(table, f.construct(Type::u32(), {pageIndex}));
            const ExprId local = f.mul(f.sub(grid, tile), f.swizzle(params, "x"));
            const ExprId atlasUv = f.div(f.add(f.add(f.swizzle(entry, "xy"), f.construct(Type::vec(2), {f.swizzle(params, "y")})), local), f.swizzle(params, "z"));
            const ExprId z = f.sub(baseZ, f.mul(slopeBias, f.swizzle(entry, "w")));
            const ExprId value = f.select(f.less(t.f(0), f.swizzle(entry, "z")), f.sampleCompare(map, atlasUv, z), t.f(1));
            sum = sum == kInvalid ? value : f.add(sum, value);
        }
        ExprId value = f.mul(sum, t.f(1.0f / 5.0f));
        value = f.select(f.less(f.swizzle(uv, "x"), t.f(0)), t.f(1), value);
        value = f.select(f.less(t.f(1), f.swizzle(uv, "x")), t.f(1), value);
        value = f.select(f.less(f.swizzle(uv, "y"), t.f(0)), t.f(1), value);
        value = f.select(f.less(t.f(1), f.swizzle(uv, "y")), t.f(1), value);
        value = f.select(f.less(t.f(1), baseZ), t.f(1), value);
        value = f.call("mix", {t.f(1), value, f.uniform(at + "ShadowIntensity", Type::f32())});
        value = f.select(f.less(t.f(0), f.swizzle(params, "w")), value, t.f(1));
        if (l == levels - 1) { result = value; continue; }
        const ExprId distance = f.call("max", {f.call("abs", {f.sub(t.dot(positionWorld, axisU), f.swizzle(window, "x"))}),
            f.call("abs", {f.sub(t.dot(positionWorld, axisV), f.swizzle(window, "y"))})});
        const ExprId edge = f.mul(extent, guard);
        const ExprId band = f.call("max", {f.sub(extent, edge), f.div(f.mul(extent, t.f(4)), mapSize)});
        const ExprId weight = t.oneMinus(f.call("smoothstep", {f.sub(edge, band), edge, distance}));
        const ExprId blended = f.call("mix", {result, value, weight});
        result = f.select(f.less(edge, distance), result,
            f.select(f.less(t.f(0), f.swizzle(params, "w")), blended, result));
    }
    return result;
}

// `kind` upper case: the light casts a shadow this mesh receives; `positionWorld` is then read.
static Incoming incoming(Program& f, Tsl& t, char kind, std::size_t index, ExprId positionView,
                         ExprId positionWorld = kInvalid, ExprId normalWorld = kInvalid, bool softShadows = false) {
    const std::string at = "light" + std::to_string(index);
    ExprId color = f.uniform(at + "Color", Type::vec(3));
    if (kind >= '1' && kind <= '8') {
        color = f.mul(color, virtualShadowFactor(f, t, index, kind - '0', positionWorld, normalWorld));
        kind = 'd';
    }
    if (kind >= 'A' && kind <= 'Z') {
        const ExprId shadow = kind == 'P' ? pointShadowFactor(f, t, index, positionWorld, normalWorld)
                                          : shadowFactor(f, t, index, positionWorld, normalWorld, softShadows);
        color = f.mul(color, shadow); // colorNode.mul(shadowNode)
        kind = static_cast<char>(kind - 'A' + 'a');
    }
    if (kind == 'd') return {f.call("normalize", {f.uniform(at + "Direction", Type::vec(3))}), color};
    const ExprId lightVector = f.sub(f.uniform(at + "Position", Type::vec(3)), positionView);
    const ExprId direction = f.call("normalize", {lightVector});
    const ExprId distance = f.call("length", {lightVector});
    const ExprId cutoff = f.uniform(at + "Distance", Type::f32());
    const ExprId falloff = f.div(t.f(1), f.call("max", {f.call("pow", {distance, f.uniform(at + "Decay", Type::f32())}), t.f(0.01f)}));
    const ExprId cut = f.mul(falloff, t.pow2(t.saturate(t.oneMinus(t.pow2(t.pow2(f.div(distance, cutoff)))))));
    const ExprId attenuation = f.select(f.less(t.f(0), cutoff), cut, falloff);
    if (kind == 'p') return {direction, f.mul(color, attenuation)};
    const ExprId angleCos = t.dot(direction, f.call("normalize", {f.uniform(at + "Axis", Type::vec(3))}));
    const ExprId spot = f.call("smoothstep", {f.uniform(at + "ConeCos", Type::f32()), f.uniform(at + "PenumbraCos", Type::f32()), angleCos});
    return {direction, f.mul(f.mul(color, spot), attenuation)};
}

// The MeshStandardNodeMaterial / MeshPhysicalNodeMaterial body. `physical` swaps setupSpecular's
// fixed 0.04 F0 / 1 F90 for the physical ior, specularIntensity and specularColor formula; every
// other node is identical, so the standard output stays bit-identical.
static StandardPrograms buildStandardProgram(const StandardMaterial& material, bool physical,
                                             const VertexVariant& variant, const LightLayout& lights) {
    StandardPrograms out;
    out.diagnostics = unsupportedFeatures(material);
    if (!out.diagnostics.empty()) return out;

    Program& v = out.vertex;
    const ExprId model = v.uniform("modelMatrix", Type::mat(4, 4));
    const ExprId view = v.uniform("viewMatrix", Type::mat(4, 4));
    const ExprId normalMatrix = v.uniform("normalMatrix", Type::mat(3, 3));
    const LocalVertex local = localVertex(v, variant, true);
    const ExprId position = local.position, normal = local.normal;
    const ExprId positionView = v.mul(view, v.mul(model, position));
    v.output("position", clipPosition(v, variant, local, v.mul(v.uniform("projectionMatrix", Type::mat(4, 4)), positionView)));
    // transformNormalToView: normalize(view * vec4(modelNormalMatrix * normal, 0)), normalized per
    // vertex before it is interpolated (v_normalViewGeometry); normalMatrix is that product.
    v.output("normalView", v.call("normalize", {v.mul(normalMatrix, variant.backSide ? v.neg(normal) : normal)}));
    v.output("positionView", v.swizzle(positionView, "xyz"));
    // positionWorld, before instanceColor: varyings take locations in creation order in both stages.
    if (lights.shadowed()) v.output("positionWorld", v.swizzle(v.mul(model, position), "xyz"));
    outputInstanceColor(v, local);
    outputMapUv(v, local);

    Program& f = out.fragment;
    Tsl t{f};
    // normalViewGeometry is the varying renormalized (three's .normalize().toVar()); getGeometryRoughness
    // differentiates that, not the raw varying.
    const ExprId normalViewGeometry = f.call("normalize", {f.varying("normalView", Type::vec(3))});
    const ExprId normalViewFaced = facedNormal(f, variant, normalViewGeometry);
    ExprId n = nodeValue(f, variant.nodes.normalNode, Type::vec(3), normalViewFaced, normalViewFaced, normalViewGeometry);
    const ExprId positionViewDirection = f.call("normalize", {f.neg(f.varying("positionView", Type::vec(3)))});
    const ExprId positionWorld = lights.shadowed() ? f.varying("positionWorld", Type::vec(3)) : kInvalid;
    if (variant.normalMap && !variant.nodes.normalNode) n = perturbedNormal(f, variant, normalViewFaced);
    else if (variant.reads(kBumpMap) && !variant.nodes.normalNode) n = bumpedNormal(f, variant, normalViewFaced);
    // normalWorld = normalView.transformNormalByInverseViewMatrix(cameraViewMatrix), in the fragment:
    // normalize((vec4(normalView, 0) * viewMatrix).xyz).
    const ExprId normalWorld = f.call("normalize", {f.swizzle(f.mul(f.construct(Type::vec(4), {n, f.constant(0.0f)}),
                                                                     f.uniform("viewMatrix", Type::mat(4, 4))), "xyz")});
    const ExprId diffuse = nodeValue(f, variant.nodes.colorNode, Type::vec(4), f.uniform("diffuse", Type::vec(4)), n);
    const ExprId texel = variant.nodes.colorNode ? kInvalid : mapTexel(f, variant);
    ExprId diffuseColor = materialColor(f, variant, diffuse);
    if (texel != kInvalid) diffuseColor = f.mul(diffuseColor, f.swizzle(texel, "xyz"));
    // MaterialNode.METALNESS / ROUGHNESS: the factor times the map's blue / green channel.
    ExprId metalnessFactor = variant.nodes.metalnessNode ? kInvalid : f.uniform("metalness", Type::f32());
    if (metalnessFactor != kInvalid && variant.reads(kMetalnessMap))
        metalnessFactor = f.mul(metalnessFactor, f.swizzle(pbrTexel(f, variant, kMetalnessMap), "z"));
    const ExprId metalness = nodeValue(f, variant.nodes.metalnessNode, Type::f32(), metalnessFactor, n);
    ExprId roughnessFactor = variant.nodes.roughnessNode ? kInvalid : f.uniform("roughness", Type::f32());
    if (roughnessFactor != kInvalid && variant.reads(kRoughnessMap))
        roughnessFactor = f.mul(roughnessFactor, f.swizzle(pbrTexel(f, variant, kRoughnessMap), "y"));

    // getRoughness: max(roughness, 0.0525) + getGeometryRoughness, capped at 1.
    const ExprId dxy = f.call("max", {f.call("abs", {f.call("dFdx", {normalViewGeometry})}),
                                      f.call("abs", {f.call("dFdy", {normalViewGeometry})})});
    const ExprId geometryRoughness =
        f.call("max", {f.call("max", {f.swizzle(dxy, "x"), f.swizzle(dxy, "y")}), f.swizzle(dxy, "z")});
    ExprId roughness = f.call("min", {f.add(f.call("max", {nodeValue(f, variant.nodes.roughnessNode, Type::f32(), roughnessFactor, n), t.f(0.0525f)}),
                                                  geometryRoughness), t.f(1)});

    // MeshStandardNodeMaterial.setupSpecular, or MeshPhysicalNodeMaterial's setupSpecular.
    // Derivatives must execute before cubeUV's per-fragment branches (three's roughness variable).
    if (variant.environment) roughness = f.load(f.var(Type::f32(), roughness));
    // specularF90 (mix(specularIntensity, 1, metalness)) feeds only PhysicalLightingModel's indirect
    // specular, which arrives with environment lighting; direct light passes f90: 1 for every material.
    ExprId specularColorBlended;
    ExprId specularF90;
    ExprId f0Dielectric;
    if (physical) {
        const ExprId ior = f.uniform("ior", Type::f32());
        ExprId specularIntensity = f.uniform("specularIntensity", Type::f32());
        if (variant.reads(kSpecularIntensityMap))
            specularIntensity = f.mul(specularIntensity, f.swizzle(pbrTexel(f, variant, kSpecularIntensityMap), "w"));
        ExprId specularColor = f.uniform("specularColor", Type::vec(3));
        if (variant.reads(kSpecularColorMap))
            specularColor = f.mul(specularColor, f.swizzle(pbrTexel(f, variant, kSpecularColorMap), "xyz"));
        const ExprId f0Base =
            f.call("min", {f.mul(t.pow2(f.div(f.sub(ior, t.f(1)), f.add(ior, t.f(1)))), specularColor),
                           f.construct(Type::vec(3), {t.f(1)})});
        f0Dielectric = f.mul(f0Base, specularIntensity);
        specularColorBlended = f.call("mix", {f0Dielectric, diffuseColor, metalness});
        specularF90 = f.call("mix", {specularIntensity, t.f(1), metalness});
    } else {
        f0Dielectric = f.construct(Type::vec(3), {t.f(0.04f)});
        specularColorBlended = f.call("mix", {f0Dielectric, diffuseColor, metalness});
        specularF90 = t.f(1);
    }
    const ExprId diffuseContribution = f.mul(diffuseColor, t.oneMinus(metalness));
    const Surface surface{n, positionViewDirection, roughness, specularColorBlended, t.f(1), f.texture2d("dfg")};

    // MeshPhysicalNodeMaterial.setupVariants with useClearcoat: clearcoat = materialClearcoat (times the
    // clearcoatMap's red), clearcoatRoughness = getRoughness(materialClearcoatRoughness, times the
    // clearcoatRoughnessMap's red). PhysicalLightingModel's clearcoatF0 = vec3(0.04), clearcoatF90 = 1.
    const bool coated = physical && variant.clearcoat;
    ExprId clearcoat = kInvalid, clearcoatNormalView = kInvalid;
    Surface coat{};
    ExprId clearcoatSpecularDirect = kInvalid, clearcoatSpecularIndirect = kInvalid;
    if (coated) {
        clearcoat = f.uniform("clearcoat", Type::f32());
        if (variant.reads(kClearcoatMap)) clearcoat = f.mul(clearcoat, f.swizzle(pbrTexel(f, variant, kClearcoatMap), "x"));
        ExprId clearcoatRoughnessFactor = f.uniform("clearcoatRoughness", Type::f32());
        if (variant.reads(kClearcoatRoughnessMap))
            clearcoatRoughnessFactor =
                f.mul(clearcoatRoughnessFactor, f.swizzle(pbrTexel(f, variant, kClearcoatRoughnessMap), "x"));
        ExprId clearcoatRoughness = f.call("min", {f.add(f.call("max", {clearcoatRoughnessFactor, t.f(0.0525f)}), geometryRoughness), t.f(1)});
        // Its derivatives run before the environment's branches, as roughness's do.
        if (variant.environment) clearcoatRoughness = f.load(f.var(Type::f32(), clearcoatRoughness));
        clearcoatNormalView = clearcoatNormal(f, variant, n);
        coat = Surface{clearcoatNormalView, positionViewDirection, clearcoatRoughness,
                       f.construct(Type::vec(3), {t.f(0.04f)}), t.f(1), f.texture2d("dfg")};
        clearcoatSpecularDirect = f.construct(Type::vec(3), {t.f(0)});
    }

    // PhysicalLightingModel.direct for each light, accumulated in three's order.
    const ExprId brdfLambert = f.mul(diffuseContribution, t.f(1 / kPi));
    const ExprId fragmentView = f.varying("positionView", Type::vec(3));
    ExprId directDiffuse = f.construct(Type::vec(3), {t.f(0)}), directSpecular = directDiffuse;
    for (std::size_t i = 0; i < lights.kinds.size(); ++i) {
        const Incoming light = incoming(f, t, lights.kinds[i], i, fragmentView, positionWorld, normalWorld, lights.softShadows);
        const ExprId irradiance = f.mul(t.saturate(t.dot(n, light.direction)), light.color);
        directDiffuse = f.add(directDiffuse, f.mul(irradiance, brdfLambert));
        directSpecular = f.add(directSpecular, f.mul(irradiance, brdfGgxMultiscatter(t, surface, light.direction)));
        if (coated) {
            // PhysicalLightingModel.direct: BRDF_GGX on the clearcoat normal, with its own irradiance.
            const ExprId ccIrradiance = f.mul(t.saturate(t.dot(clearcoatNormalView, light.direction)), light.color);
            clearcoatSpecularDirect = f.add(clearcoatSpecularDirect, f.mul(ccIrradiance, brdfGgx(t, coat, light.direction)));
        }
    }

    // Hemisphere and ambient irradiance, then PhysicalLightingModel.indirect diffuse.
    const ExprId hemiWeight = f.add(f.mul(t.dot(normalWorld, f.call("normalize", {f.uniform("hemisphereDirection", Type::vec(3))})), t.f(0.5f)), t.f(0.5f));
    const ExprId hemisphere = f.call("mix", {f.uniform("hemisphereGround", Type::vec(3)), f.uniform("hemisphereSky", Type::vec(3)), hemiWeight});
    const ExprId indirectIrradiance = f.add(hemisphere, f.uniform("ambient", Type::vec(3)));
    const ExprId indirectDiffuse = f.mul(indirectIrradiance, brdfLambert);

    // EnvironmentNode: IBL irradiance (normalWorld, level 1) and radiance (the roughness-mixed
    // reflection, level = roughness), then PhysicalLightingModel.indirect. The PMREM texture is a
    // render target, so three negates the sample direction's y before textureCubeUV.
    ExprId environmentDiffuse = kInvalid, environmentSpecular = kInvalid;
    if (variant.environment) {
        const uint32_t env = f.texture2d("env");
        const ExprId envIntensity = f.uniform("envMapIntensity", Type::f32());
        auto flipped = [&](ExprId v) {
            // PMREMNode flips the render target's Y before materialEnvRotation, not after it.
            v = f.construct(Type::vec(3), {f.swizzle(v, "x"), f.neg(f.swizzle(v, "y")), f.swizzle(v, "z")});
            return f.swizzle(f.mul(f.uniform("envRotation", Type::mat(4, 4)), f.construct(Type::vec(4), {v, t.f(0)})), "xyz");
        };
        const ExprId iblIrradiance =
            f.mul(f.mul(textureCubeUV(f, env, flipped(normalWorld), t.f(1)), t.f(kPi)), envIntensity);
        ExprId reflectVec = f.call("reflect", {f.neg(positionViewDirection), n});
        reflectVec = f.call("normalize", {f.call("mix", {reflectVec, n, f.mul(f.mul(t.pow2(roughness), roughness), roughness)})});
        reflectVec = transformDirection(f, f.uniform("cameraWorldMatrix", Type::mat(4, 4)), reflectVec);
        const ExprId radiance = f.mul(textureCubeUV(f, env, flipped(reflectVec), roughness), envIntensity);
        const ExprId dotNV = t.saturate(t.dot(n, positionViewDirection));
        const uint32_t dfg = f.texture2d("dfg");
        const Multiscatter dielectric = computeMultiscattering(t, roughness, dotNV, f0Dielectric, specularF90, dfg);
        const Multiscatter metallic = computeMultiscattering(t, roughness, dotNV, diffuseColor, specularF90, dfg);
        const ExprId single = f.call("mix", {dielectric.single, metallic.single, metalness});
        const ExprId multi = f.call("mix", {dielectric.multi, metallic.multi, metalness});
        const ExprId energyLoss = t.oneMinus(f.add(dielectric.single, dielectric.multi));
        const ExprId cosineWeightedIrradiance = f.mul(iblIrradiance, t.f(1 / kPi));
        environmentSpecular = f.add(f.mul(radiance, single), f.mul(multi, cosineWeightedIrradiance));
        environmentDiffuse = f.mul(f.mul(diffuseContribution, energyLoss), cosineWeightedIrradiance);
        if (coated) {
            // EnvironmentNode's clearcoatRadiance (the radiance context of clearcoatRoughness and the
            // clearcoat normal), then PhysicalLightingModel.indirectSpecular's EnvironmentBRDF.
            ExprId ccReflect = f.call("reflect", {f.neg(positionViewDirection), clearcoatNormalView});
            ccReflect = f.call("normalize", {f.call("mix", {ccReflect, clearcoatNormalView,
                                                            f.mul(f.mul(t.pow2(coat.roughness), coat.roughness), coat.roughness)})});
            ccReflect = transformDirection(f, f.uniform("cameraWorldMatrix", Type::mat(4, 4)), ccReflect);
            const ExprId clearcoatRadiance = f.mul(textureCubeUV(f, env, flipped(ccReflect), coat.roughness), envIntensity);
            const ExprId fab = dfgLut(t, coat, t.saturate(t.dot(clearcoatNormalView, positionViewDirection)));
            const ExprId clearcoatEnv = f.add(f.mul(coat.f0, f.swizzle(fab, "x")), f.mul(coat.f90, f.swizzle(fab, "y")));
            clearcoatSpecularIndirect = f.mul(clearcoatRadiance, clearcoatEnv);
        }
    }

    // MaterialNode.EMISSIVE: emissive * emissiveIntensity (the uniform), times the emissiveMap texel.
    ExprId emissiveFactor = variant.nodes.emissiveNode ? kInvalid : f.uniform("emissive", Type::vec(3));
    if (emissiveFactor != kInvalid && variant.reads(kEmissiveMap))
        emissiveFactor = f.mul(emissiveFactor, f.swizzle(pbrTexel(f, variant, kEmissiveMap), "xyz"));
    const ExprId emissive = nodeValue(f, variant.nodes.emissiveNode, Type::vec(3), emissiveFactor, n);
    // LightsNode: (directDiffuse + indirectDiffuse) + (directSpecular + indirectSpecular),
    // then NodeMaterial adds emissive. Do not regroup the f32 sum by light source.
    ExprId totalIndirectDiffuse = environmentDiffuse == kInvalid ? indirectDiffuse : f.add(indirectDiffuse, environmentDiffuse);
    if (variant.reads(kAoMap)) {
        // MaterialNode.AO, then PhysicalLightingModel.ambientOcclusion: indirect diffuse times the
        // occlusion, indirect specular times its roughness-shaped specular occlusion.
        const ExprId ao = f.add(f.mul(f.sub(f.swizzle(pbrTexel(f, variant, kAoMap), "x"), t.f(1)), f.uniform("aoMapIntensity", Type::f32())), t.f(1));
        totalIndirectDiffuse = f.mul(totalIndirectDiffuse, ao);
        if (clearcoatSpecularIndirect != kInvalid) clearcoatSpecularIndirect = f.mul(clearcoatSpecularIndirect, ao);
        if (environmentSpecular != kInvalid) {
            const ExprId dotNV = t.saturate(t.dot(n, positionViewDirection));
            const ExprId aoExp = f.call("exp2", {f.neg(t.oneMinus(f.mul(roughness, t.f(-16))))});
            const ExprId specularOcclusion = t.saturate(f.sub(ao, t.oneMinus(f.call("pow", {f.add(dotNV, ao), aoExp}))));
            environmentSpecular = f.mul(environmentSpecular, specularOcclusion);
        }
    }
    const ExprId totalSpecular = environmentSpecular == kInvalid ? directSpecular : f.add(directSpecular, environmentSpecular);
    ExprId outgoingLight = f.add(f.add(directDiffuse, totalIndirectDiffuse), totalSpecular);
    if (coated) {
        // PhysicalLightingModel.finish: the base layer through (1 - clearcoat * Fcc), plus the clearcoat's
        // direct and indirect specular scaled by clearcoat; emissive is added after, as NodeMaterial does.
        const ExprId dotNVcc = t.saturate(t.dot(clearcoatNormalView, positionViewDirection));
        const ExprId Fcc = fSchlick(t, coat.f0, coat.f90, dotNVcc);
        const ExprId ccSpecular = clearcoatSpecularIndirect == kInvalid ? clearcoatSpecularDirect
                                                                         : f.add(clearcoatSpecularDirect, clearcoatSpecularIndirect);
        outgoingLight = f.add(f.mul(outgoingLight, t.oneMinus(f.mul(clearcoat, Fcc))), f.mul(ccSpecular, clearcoat));
    }
    const ExprId outgoing = f.add(outgoingLight, emissive);
    const ExprId alpha = diffuseAlpha(f, variant, diffuse, texel);
    // Linear HDR out: tone mapping and the output colour space belong to the output pass (output.h).
    f.output("color", materialOutput(f, variant, outgoing, materialAlpha(f, alpha)));
    linkNodes(out, variant, local);
    for (const Program* stage : {&out.vertex, &out.fragment}) {
        for (const Diagnostic& d : stage->diagnostics()) {
            out.diagnostics.push_back(d.code + " " + d.node + ": " + d.reason + " (" + d.file + ":" + std::to_string(d.line) + ")");
        }
    }
    return out;
}

std::string probeStorageName(std::string_view name) {
    auto letter = [](char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'; };
    if (name.empty() || !letter(name.front()) || !std::all_of(name.begin(), name.end(), [&](char c) {
            return letter(c) || (c >= '0' && c <= '9'); }))
        throw std::invalid_argument("TN_PROBES_BINDING: expected shader identifier");
    return "probe_" + std::string(name);
}

graph::Node probeSample(const probes::ProbePlacement& placement, const std::string& name,
                        graph::Node position, graph::Node normal) {
    namespace g = graph;
    if (!position) position = g::varying("positionWorld", Type::vec(3));
    if (!normal) normal = g::normalize(g::swizzle(g::mul(
        g::vec4({g::normalize(g::varying("normalView", Type::vec(3))), g::float_(0)}),
        g::uniform("viewMatrix", Type::mat(4, 4))), "xyz"));
    auto vector = [](const double* v) { return g::vec3({g::float_(v[0]), g::float_(v[1]), g::float_(v[2])}); };
    const auto local = g::clamp(g::div(g::sub(position, vector(placement.boundsMin)), vector(placement.boundsSize)),
                               g::vec3({g::float_(0)}), g::vec3({g::float_(1)}));
    const auto& r = placement.resolution;
    const auto atlasX = g::div(g::add(g::mul(g::swizzle(local, "x"), g::float_(r[0] - 1)), g::float_(0.5)), g::float_(r[0]));
    const auto atlasY = g::div(g::add(g::mul(g::swizzle(local, "y"), g::float_(r[1] - 1)), g::float_(0.5)), g::float_(r[1]));
    std::array<g::Node, 7> packed;
    for (uint32_t sub = 0; sub < 7; ++sub) {
        const auto atlasZ = g::div(g::add(g::mul(g::swizzle(local, "z"), g::float_(r[2] - 1)),
                                         g::float_(1.5 + sub * placement.paddedSlices)), g::float_(placement.atlasDepth));
        packed[sub] = g::texture(probeStorageName(name), g::vec3({atlasX, atlasY, atlasZ}));
    }
    std::array<g::Node,9> coefficients;
    constexpr const char* lanes[] = {"x","y","z","w"};
    for (uint32_t i=0; i<9; ++i) {
        auto channel = [&](uint32_t c) { const auto flat=i*3+c; return g::swizzle(packed[flat/4], lanes[flat%4]); };
        coefficients[i] = g::vec3({channel(0),channel(1),channel(2)});
    }
    const auto n = g::normalize(normal), x=g::swizzle(n,"x"), y=g::swizzle(n,"y"), z=g::swizzle(n,"z");
    auto irradiance = g::mul(coefficients[0],g::float_(0.886227));
    auto weighted = [&](uint32_t i, g::Node direction, double factor) {
        return g::mul(g::mul(coefficients[i],direction),g::float_(factor));
    };
    const std::array<g::Node,8> terms = {
        weighted(1,y,1.023328), weighted(2,z,1.023328), weighted(3,x,1.023328),
        weighted(4,g::mul(x,y),0.858086), weighted(5,g::mul(y,z),0.858086),
        g::mul(coefficients[6],g::sub(g::mul(g::mul(z,z),g::float_(0.743125)),g::float_(0.247708))),
        weighted(7,g::mul(x,z),0.858086), weighted(8,g::sub(g::mul(x,x),g::mul(y,y)),0.429043)};
    for (const auto& term : terms) irradiance=g::add(irradiance,term);
    return g::max(irradiance,g::vec3({g::float_(0)}));
}

StandardPrograms buildStandard(const StandardMaterial& material, const VertexVariant& variant, const LightLayout& lights) {
    return buildStandardProgram(material, false, variant, lights);
}
StandardPrograms buildPhysical(const StandardMaterial& material, const VertexVariant& variant, const LightLayout& lights) {
    return buildStandardProgram(material, true, variant, lights);
}

namespace {

// The PhongLightingModel chain shared by MeshLambertNodeMaterial (specular off) and
// MeshPhongNodeMaterial (Blinn-Phong specular): direct and indirect Lambert diffuse from the same
// one directional, one hemisphere and one ambient light the standard program reads.
StandardPrograms buildLit(bool phong, const VertexVariant& variant, const LightLayout& lights) {
    StandardPrograms out;
    Program& v = out.vertex;
    const ExprId model = v.uniform("modelMatrix", Type::mat(4, 4));
    const ExprId view = v.uniform("viewMatrix", Type::mat(4, 4));
    const ExprId normalMatrix = v.uniform("normalMatrix", Type::mat(3, 3));
    const LocalVertex local = localVertex(v, variant, true);
    const ExprId position = local.position, normal = local.normal;
    const ExprId positionView = v.mul(view, v.mul(model, position));
    v.output("position", clipPosition(v, variant, local, v.mul(v.uniform("projectionMatrix", Type::mat(4, 4)), positionView)));
    // transformNormalToView: normalize(view * vec4(modelNormalMatrix * normal, 0)), normalized per
    // vertex before it is interpolated (v_normalViewGeometry); normalMatrix is that product.
    v.output("normalView", v.call("normalize", {v.mul(normalMatrix, variant.backSide ? v.neg(normal) : normal)}));
    v.output("positionView", v.swizzle(positionView, "xyz"));
    // positionWorld, before instanceColor: varyings take locations in creation order in both stages.
    if (lights.shadowed()) v.output("positionWorld", v.swizzle(v.mul(model, position), "xyz"));
    outputInstanceColor(v, local);
    outputMapUv(v, local);

    Program& f = out.fragment;
    Tsl t{f};
    ExprId n = facedNormal(f, variant, f.call("normalize", {f.varying("normalView", Type::vec(3))}));
    const ExprId positionViewDirection = f.call("normalize", {f.neg(f.varying("positionView", Type::vec(3)))});
    const ExprId positionWorld = lights.shadowed() ? f.varying("positionWorld", Type::vec(3)) : kInvalid;
    if (variant.normalMap) n = perturbedNormal(f, variant, n);
    // normalWorld = normalView.transformNormalByInverseViewMatrix(cameraViewMatrix), in the fragment:
    // normalize((vec4(normalView, 0) * viewMatrix).xyz).
    const ExprId normalWorld = f.call("normalize", {f.swizzle(f.mul(f.construct(Type::vec(4), {n, f.constant(0.0f)}),
                                                                     f.uniform("viewMatrix", Type::mat(4, 4))), "xyz")});
    const ExprId diffuse = nodeValue(f, variant.nodes.colorNode, Type::vec(4), f.uniform("diffuse", Type::vec(4)), n);
    const ExprId texel = variant.nodes.colorNode ? kInvalid : mapTexel(f, variant);
    ExprId diffuseColor = materialColor(f, variant, diffuse);
    if (texel != kInvalid) diffuseColor = f.mul(diffuseColor, f.swizzle(texel, "xyz"));

    // PhongLightingModel.direct for each light, in three's order: BRDF_Lambert, and with phong the
    // Blinn-Phong specular (shininess clamped to 1e-4, the material's specular colour).
    const ExprId brdfLambert = f.mul(diffuseColor, t.f(1 / kPi));
    const ExprId fragmentView = f.varying("positionView", Type::vec(3));
    const ExprId shininess = phong ? f.call("max", {f.uniform("shininess", Type::f32()), t.f(1e-4f)}) : kInvalid;
    ExprId directDiffuse = f.construct(Type::vec(3), {t.f(0)}), directSpecular = directDiffuse;
    for (std::size_t i = 0; i < lights.kinds.size(); ++i) {
        const Incoming light = incoming(f, t, lights.kinds[i], i, fragmentView, positionWorld, normalWorld, lights.softShadows);
        const ExprId irradiance = f.mul(t.saturate(t.dot(n, light.direction)), light.color);
        directDiffuse = f.add(directDiffuse, f.mul(irradiance, brdfLambert));
        if (phong)
            directSpecular = f.add(directSpecular, f.mul(irradiance, brdfBlinnPhong(t, n, positionViewDirection, light.direction,
                                                                                 f.uniform("specular", Type::vec(3)), shininess)));
    }

    // Hemisphere and ambient irradiance, then PhongLightingModel.indirect diffuse.
    const ExprId hemiWeight = f.add(f.mul(t.dot(normalWorld, f.call("normalize", {f.uniform("hemisphereDirection", Type::vec(3))})), t.f(0.5f)), t.f(0.5f));
    const ExprId hemisphere = f.call("mix", {f.uniform("hemisphereGround", Type::vec(3)), f.uniform("hemisphereSky", Type::vec(3)), hemiWeight});
    const ExprId indirectIrradiance = f.add(hemisphere, f.uniform("ambient", Type::vec(3)));
    const ExprId indirectDiffuse = f.mul(indirectIrradiance, brdfLambert);

    ExprId lighting = f.add(directDiffuse, indirectDiffuse);
    if (phong) lighting = f.add(lighting, directSpecular);
    const ExprId emissive = nodeValue(f, variant.nodes.emissiveNode, Type::vec(3), variant.nodes.emissiveNode ? kInvalid : f.uniform("emissive", Type::vec(3)), n);
    const ExprId outgoing = f.add(lighting, emissive);
    const ExprId alpha = diffuseAlpha(f, variant, diffuse, texel);
    // Linear HDR out: tone mapping and the output colour space belong to the output pass (output.h).
    f.output("color", materialOutput(f, variant, outgoing, materialAlpha(f, alpha)));
    linkNodes(out, variant, local);
    for (const Program* stage : {&out.vertex, &out.fragment}) {
        for (const Diagnostic& d : stage->diagnostics()) {
            out.diagnostics.push_back(d.code + " " + d.node + ": " + d.reason + " (" + d.file + ":" + std::to_string(d.line) + ")");
        }
    }
    return out;
}

}  // namespace

StandardPrograms buildLambert(const VertexVariant& variant, const LightLayout& lights) { return buildLit(false, variant, lights); }
StandardPrograms buildPhong(const VertexVariant& variant, const LightLayout& lights) { return buildLit(true, variant, lights); }

StandardPrograms buildBasic(const VertexVariant& variant) {
    StandardPrograms out;
    Program& v = out.vertex;
    // A graph that reads normalView (normalWorld) gets the lit materials' normal: instanced, skinned
    // and morphed by localVertex, then written as the normalView varying. normalWorldGeometry needs
    // the same local normal, without normalView.
    const auto reads = [&variant](std::string_view varying) {
        std::unordered_set<const graph::NodeData*> seen;
        const std::function<bool(const graph::Node&)> visit = [&](const graph::Node& n) {
            if (!n || !seen.insert(n.get()).second) return false;
            if (n->kind == graph::Kind::Varying && n->args.empty() && n->name == varying) return true;
            for (const auto* list : {&n->args, &n->body, &n->otherwise})
                for (const auto& child : *list) if (visit(child)) return true;
            return false;
        };
        for (const auto& node : variant.nodes.graphs()) if (visit(node)) return true;
        return false;
    };
    const bool needsNormal = reads("normalView");
    const LocalVertex local = localVertex(v, variant, needsNormal || reads("normalWorldGeometry"));
    const ExprId viewPosition = v.mul(v.uniform("viewMatrix", Type::mat(4, 4)), v.mul(v.uniform("modelMatrix", Type::mat(4, 4)), local.position));
    ExprId clip = v.mul(v.uniform("projectionMatrix", Type::mat(4, 4)), viewPosition);
    if (variant.background) {
        // Background.js sphere(1,32,32): orthographic scaling is supplied by RenderDatabase.
        // Model translation cancels camera translation; force z=w, and no depth test/write.
        clip = v.construct(Type::vec(4), {v.swizzle(clip, "xy"), v.swizzle(clip, "w"), v.swizzle(clip, "w")});
    }
    v.output("position", clipPosition(v, variant, local, clip));
    if (needsNormal)
        v.output("normalView", v.call("normalize", {v.mul(v.uniform("normalMatrix", Type::mat(3, 3)),
                                                         variant.backSide ? v.neg(local.normal) : local.normal)}));
    if (variant.fog) v.output("positionView", v.swizzle(viewPosition, "xyz"));
    if (variant.background) {
        const ExprId normalView = v.call("normalize", {v.mul(v.uniform("normalMatrix", Type::mat(3, 3)), v.attribute("normal", Type::vec(3)))});
        const ExprId normalWorld = v.call("normalize", {v.swizzle(v.mul(v.construct(Type::vec(4), {normalView, v.constant(0.0f)}),
            v.uniform("viewMatrix", Type::mat(4, 4))), "xyz")});
        v.output("backgroundDirection", normalWorld);
    }
    outputInstanceColor(v, local);
    if (!variant.background) outputMapUv(v, local);
    Program& f = out.fragment;
    // MeshBasicNodeMaterial.setupNormal: negateOnBackSide(normalViewGeometry); a normalNode is not read.
    const ExprId normalView = needsNormal ? facedNormal(f, variant, f.call("normalize", {f.varying("normalView", Type::vec(3))})) : kInvalid;
    const ExprId diffuse = nodeValue(f, variant.nodes.colorNode, Type::vec(4), f.uniform("diffuse", Type::vec(4)), normalView);
    ExprId texel = kInvalid;
    if (variant.background) {
        const ExprId normal = f.call("normalize", {f.varying("backgroundDirection", Type::vec(3))});
        const ExprId direction = f.swizzle(f.mul(f.uniform("backgroundRotation", Type::mat(4, 4)),
            f.construct(Type::vec(4), {normal, f.constant(0.0f)})), "xyz");
        // CubeTextureNode.setupUV flips x for the WebGPU coordinate system.
        const ExprId cubeDirection = f.construct(Type::vec(3), {f.neg(f.swizzle(direction, "x")), f.swizzle(direction, "yz")});
        texel = f.sampleLevel(f.textureCube("map"), cubeDirection, f.constant(0.0f));
    } else if (!variant.nodes.colorNode) texel = mapTexel(f, variant);
    ExprId diffuseColor = materialColor(f, variant, diffuse);
    if (texel != kInvalid) diffuseColor = f.mul(diffuseColor, f.swizzle(texel, "xyz"));
    const ExprId alpha = diffuseAlpha(f, variant, diffuse, texel);
    const ExprId outgoing = variant.nodes.emissiveNode ? f.add(diffuseColor, nodeValue(f, variant.nodes.emissiveNode, Type::vec(3), kInvalid, normalView)) : diffuseColor;
    // Background.js writes opaque output regardless of the source texture's alpha.
    f.output("color", materialOutput(f, variant, outgoing, variant.background ? f.constant(1.0f) : materialAlpha(f, alpha)));
    linkNodes(out, variant, local);
    return out;
}

StandardPrograms buildEquirectangularCube() {
    StandardPrograms out;
    Program& vertex = out.vertex;
    Program& fragment = out.fragment;
    const auto i = vertex.builtin("vertexIndex");
    const auto zero = vertex.construct(Type::u32(), {vertex.constant(int32_t(0))});
    const auto one = vertex.construct(Type::u32(), {vertex.constant(int32_t(1))});
    const auto x = vertex.select(vertex.equal(i, one), vertex.constant(3.0f), vertex.constant(-1.0f));
    const auto y = vertex.select(vertex.equal(i, zero), vertex.constant(3.0f), vertex.constant(-1.0f));
    const auto xy = vertex.construct(Type::vec(2), {x, y});
    vertex.output("position", vertex.construct(Type::vec(4), {xy, vertex.constant(0.0f), vertex.constant(1.0f)}));
    vertex.output("ndc", xy);
    const auto ndc = fragment.varying("ndc", Type::vec(2));
    const auto ray = fragment.construct(Type::vec(4), {fragment.neg(ndc), fragment.constant(-1.0f), fragment.constant(0.0f)});
    const auto direction = fragment.call("normalize", {fragment.swizzle(fragment.mul(
        fragment.uniform("cubeRotation", Type::mat(4, 4)), ray), "xyz")});
    const auto u = fragment.add(fragment.mul(fragment.call("atan2", {fragment.swizzle(direction, "z"), fragment.swizzle(direction, "x")}),
        fragment.constant(1.0f / (2 * 3.141592653589793f))), fragment.constant(0.5f));
    const auto v = fragment.add(fragment.mul(fragment.call("asin", {fragment.call("clamp", {fragment.swizzle(direction, "y"),
        fragment.constant(-1.0f), fragment.constant(1.0f)})}), fragment.constant(1.0f / 3.141592653589793f)), fragment.constant(0.5f));
    const auto sampled = fragment.sampleLevel(fragment.texture2d("map"), fragment.construct(Type::vec(2), {u, v}), fragment.constant(0.0f));
    fragment.output("color", fragment.construct(Type::vec(4), {fragment.swizzle(sampled, "xyz"), fragment.constant(1.0f)}));
    return out;

}

ExprId fogFactor(Program& f, uint8_t kind, ExprId viewZ, ExprId nearOrDensity, ExprId far) {
    if (kind == 1) return f.call("smoothstep", {nearOrDensity, far, viewZ});
    if (kind == 2) {
        const ExprId squared = f.mul(f.mul(f.mul(nearOrDensity, nearOrDensity), viewZ), viewZ);
        return f.sub(f.constant(1.0f), f.call("exp", {f.neg(squared)}));
    }
    return f.constant(0.0f);
}

ExprId materialAlpha(Program& f, ExprId alpha) {
    const ExprId alphaTest = f.uniform("alphaTest", Type::f32());
    const ExprId no = f.constant(false);
    // alpha <= alphaTest is !(alphaTest < alpha); the test applies only when alphaTest > 0.
    const ExprId atOrBelow = f.select(f.less(alphaTest, alpha), no, f.constant(true));
    f.If(f.select(f.less(f.constant(0.0f), alphaTest), atOrBelow, no), [&] { f.discard(); });
    return f.call("mix", {alpha, f.constant(1.0f), f.uniform("opaque", Type::f32())});
}

}  // namespace tn::engine::shader
