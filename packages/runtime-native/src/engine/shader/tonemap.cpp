// Ported from three@0.185.1 src/nodes/display/ToneMappingFunctions.js. Two matrix spellings there:
// mat3(vec3, vec3, vec3) takes columns, but mat3(9 scalars) becomes `new Matrix3(...)`, whose set()
// takes ROWS (NodeUtils.getValueFromType). mat3() below takes columns, mat3Rows() rows.

#include "tonemap.h"

#include <array>

namespace tn::engine::shader {

namespace {

ExprId mat3(Program& p, const std::array<float, 9>& m) {
    auto column = [&](int c) {
        return p.construct(Type::vec(3), {p.constant(m[c * 3]), p.constant(m[c * 3 + 1]), p.constant(m[c * 3 + 2])});
    };
    return p.construct(Type::mat(3, 3), {column(0), column(1), column(2)});
}

ExprId mat3Rows(Program& p, const std::array<float, 9>& r) {
    return mat3(p, {r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]});
}

ExprId f(Program& p, float v) { return p.constant(v); }
ExprId saturate(Program& p, ExprId x) { return p.call("clamp", {x, f(p, 0), f(p, 1)}); }

ExprId rrtAndOdtFit(Program& p, ExprId color) {
    const ExprId a = p.sub(p.mul(color, p.add(color, f(p, 0.0245786f))), f(p, 0.000090537f));
    const ExprId b = p.add(p.mul(color, p.mul(p.add(color, f(p, 0.4329510f)), f(p, 0.983729f))), f(p, 0.238081f));
    return p.div(a, b);
}

ExprId agxDefaultContrastApprox(Program& p, ExprId x) {
    const ExprId x2 = p.mul(x, x);
    const ExprId x4 = p.mul(x2, x2);
    return p.add(p.sub(p.mul(f(p, 15.5f), p.mul(x4, x2)), p.mul(f(p, 40.14f), p.mul(x4, x))),
                 p.add(p.sub(p.mul(f(p, 31.96f), x4), p.mul(f(p, 6.868f), p.mul(x2, x))),
                       p.add(p.mul(f(p, 0.4298f), x2), p.sub(p.mul(f(p, 0.1191f), x), f(p, 0.00232f)))));
}

}  // namespace

ExprId toneMap(Program& p, ToneMapping mapping, ExprId color, ExprId exposure) {
    switch (mapping) {
        case ToneMapping::Linear:
            return saturate(p, p.mul(color, exposure));
        case ToneMapping::Reinhard: {
            const ExprId c = p.mul(color, exposure);
            return saturate(p, p.div(c, p.add(c, f(p, 1))));
        }
        case ToneMapping::Cineon: {
            ExprId c = p.mul(color, exposure);
            c = p.call("max", {p.sub(c, f(p, 0.004f)), p.construct(Type::vec(3), {f(p, 0)})});
            const ExprId a = p.mul(c, p.add(p.mul(c, f(p, 6.2f)), f(p, 0.5f)));
            const ExprId b = p.add(p.mul(c, p.add(p.mul(c, f(p, 6.2f)), f(p, 1.7f))), f(p, 0.06f));
            return p.call("pow", {p.div(a, b), p.construct(Type::vec(3), {f(p, 2.2f)})});
        }
        case ToneMapping::ACESFilmic: {
            const ExprId input = mat3Rows(p, {0.59719f, 0.35458f, 0.04823f, 0.07600f, 0.90834f, 0.01566f, 0.02840f, 0.13383f, 0.83777f});
            const ExprId output = mat3Rows(p, {1.60475f, -0.53108f, -0.07367f, -0.10208f, 1.10813f, -0.00605f, -0.00327f, -0.07276f, 1.07602f});
            ExprId c = p.div(p.mul(color, exposure), f(p, 0.6f));
            c = p.mul(input, c);
            c = rrtAndOdtFit(p, c);
            c = p.mul(output, c);
            return saturate(p, c);
        }
        case ToneMapping::AgX: {
            const ExprId srgbToRec2020 = mat3(p, {0.6274f, 0.0691f, 0.0164f, 0.3293f, 0.9195f, 0.0880f, 0.0433f, 0.0113f, 0.8956f});
            const ExprId rec2020ToSrgb = mat3(p, {1.6605f, -0.1246f, -0.0182f, -0.5876f, 1.1329f, -0.1006f, -0.0728f, -0.0083f, 1.1187f});
            const ExprId inset = mat3(p, {0.856627153315983f, 0.137318972929847f, 0.11189821299995f, 0.0951212405381588f,
                                          0.761241990602591f, 0.0767994186031903f, 0.0482516061458583f, 0.101439036467562f,
                                          0.811302368396859f});
            const ExprId outset = mat3(p, {1.1271005818144368f, -0.1413297634984383f, -0.14132976349843826f,
                                           -0.11060664309660323f, 1.157823702216272f, -0.11060664309660294f,
                                           -0.016493938717834573f, -0.016493938717834257f, 1.2519364065950405f});
            const ExprId minEv = f(p, -12.47393f);
            const ExprId maxEv = f(p, 4.026069f);
            ExprId c = p.mul(color, exposure);
            c = p.mul(srgbToRec2020, c);
            c = p.mul(inset, c);
            c = p.call("max", {c, p.construct(Type::vec(3), {f(p, 1e-10f)})});
            c = p.call("log2", {c});
            c = p.div(p.sub(c, minEv), p.sub(maxEv, minEv));
            c = saturate(p, c);
            c = agxDefaultContrastApprox(p, c);
            c = p.mul(outset, c);
            c = p.call("pow", {p.call("max", {p.construct(Type::vec(3), {f(p, 0)}), c}), p.construct(Type::vec(3), {f(p, 2.2f)})});
            c = p.mul(rec2020ToSrgb, c);
            return saturate(p, c);
        }
        case ToneMapping::Neutral: {
            const ExprId startCompression = f(p, 0.8f - 0.04f);
            const ExprId desaturation = f(p, 0.15f);
            ExprId c = p.mul(color, exposure);
            const ExprId x = p.call("min", {p.swizzle(c, "r"), p.call("min", {p.swizzle(c, "g"), p.swizzle(c, "b")})});
            const ExprId offset = p.select(p.less(x, f(p, 0.08f)), p.sub(x, p.mul(f(p, 6.25f), p.mul(x, x))), f(p, 0.04f));
            c = p.sub(c, offset);
            const ExprId peak = p.call("max", {p.swizzle(c, "r"), p.call("max", {p.swizzle(c, "g"), p.swizzle(c, "b")})});
            const ExprId d = p.sub(f(p, 1), startCompression);
            const ExprId newPeak = p.sub(f(p, 1), p.div(p.mul(d, d), p.add(peak, p.sub(d, startCompression))));
            const ExprId compressed = p.mul(c, p.div(newPeak, peak));
            const ExprId g = p.sub(f(p, 1), p.div(f(p, 1), p.add(p.mul(desaturation, p.sub(peak, newPeak)), f(p, 1))));
            const ExprId mixed = p.call("mix", {compressed, p.construct(Type::vec(3), {newPeak}), g});
            // TSL's early `return color` when peak < StartCompression, as one pure select.
            return p.select(p.less(peak, startCompression), c, mixed);
        }
    }
    return color;
}

}  // namespace tn::engine::shader
