#include "check.h"
#include "engine/foundation/math/ieee754.h"

#include <bit>
#include <cstdint>
#include <cstdio>
#include <initializer_list>

using namespace tn::engine::ieee754;

// Every expected word here is V8's own answer, read out of node 20.19.6 (V8 11.3.244), which is
// where three runs. The platform libm is one bit off on a few percent of arguments: glibc answers
// 0x3fefd712f9a817c1 for cos(0.1) where V8 answers 0x3fefd712f9a817c0, so this case fails against
// std:: functions and that failure is the reason the port exists.
namespace {

void checkV8(const char* what, double actual, std::uint64_t expected) {
    const std::uint64_t got = std::bit_cast<std::uint64_t>(actual);
    if (got != expected) {
        std::fprintf(stderr, "%s: got 0x%016llx, V8 has 0x%016llx\n", what,
                     static_cast<unsigned long long>(got),
                     static_cast<unsigned long long>(expected));
    }
    CHECK(got == expected);
}

void bits() {
    const auto paired = [](std::uint64_t word) {
        const double x = std::bit_cast<double>(word);
        double s, c;
        tn::engine::ieee754::sincos(x, s, c);
        checkV8("paired sin", s, std::bit_cast<std::uint64_t>(sin(x)));
        checkV8("paired cos", c, std::bit_cast<std::uint64_t>(cos(x)));
    };
    for (const std::uint64_t word : {
             0x0000000000000000ULL, 0x8000000000000000ULL, 0x0000000000000001ULL,
             0x8000000000000001ULL, 0x3fe921fbffffffffULL, 0x3fe921fc00000000ULL,
             0x3ff921fb54442d18ULL, 0x400921fb54442d18ULL, 0x4012d97c7f3321d2ULL,
             0x7fefffffffffffffULL, 0xffefffffffffffffULL, 0x7ff0000000000000ULL,
             0xfff0000000000000ULL, 0x7ff0000000000001ULL, 0xfff0000000001234ULL,
             0x7ff8000000001234ULL, 0xfff8000000004321ULL})
        paired(word);
    std::uint64_t seed = 1337;
    for (int i = 0; i < 10000; ++i) {
        seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
        paired(seed);
    }
    // The reduction range every animated angle lands in (3pi/4 to 2^19*pi/2), its edges and the
    // multiples of pi/2 where the reduction needs its second and third rounds. Words are node 20's.
    static const struct { std::uint64_t x, sin, cos; } medium[] = {
        {0x4002d97c7f3321d1ULL, 0x3fe6a09e667f3bd0ULL, 0xbfe6a09e667f3bc9ULL},
        {0xc002d97c7f3321d1ULL, 0xbfe6a09e667f3bd0ULL, 0xbfe6a09e667f3bc9ULL},
        {0x4002d97c7f3321d2ULL, 0x3fe6a09e667f3bcdULL, 0xbfe6a09e667f3bccULL},
        {0xc002d97c7f3321d2ULL, 0xbfe6a09e667f3bcdULL, 0xbfe6a09e667f3bccULL},
        {0x4002d97c7f3321d3ULL, 0x3fe6a09e667f3bcaULL, 0xbfe6a09e667f3bcfULL},
        {0xc002d97c7f3321d3ULL, 0xbfe6a09e667f3bcaULL, 0xbfe6a09e667f3bcfULL},
        {0x412921fb54442d17ULL, 0xbde469898cc51702ULL, 0x3ff0000000000000ULL},
        {0xc12921fb54442d17ULL, 0x3de469898cc51702ULL, 0x3ff0000000000000ULL},
        {0x412921fb54442d18ULL, 0xbdc1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0xc12921fb54442d18ULL, 0x3dc1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0x412921fb54442d19ULL, 0x3dd72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0xc12921fb54442d19ULL, 0xbdd72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0x400921fb54442d17ULL, 0x3cc469898cc51702ULL, 0xbff0000000000000ULL},
        {0xc00921fb54442d17ULL, 0xbcc469898cc51702ULL, 0xbff0000000000000ULL},
        {0x400921fb54442d18ULL, 0x3ca1a62633145c07ULL, 0xbff0000000000000ULL},
        {0xc00921fb54442d18ULL, 0xbca1a62633145c07ULL, 0xbff0000000000000ULL},
        {0x400921fb54442d19ULL, 0xbcb72cece675d1fdULL, 0xbff0000000000000ULL},
        {0xc00921fb54442d19ULL, 0x3cb72cece675d1fdULL, 0xbff0000000000000ULL},
        {0x401f6a7a2955385dULL, 0x3ff0000000000000ULL, 0x3cd583ebeff65cc2ULL},
        {0xc01f6a7a2955385dULL, 0xbff0000000000000ULL, 0x3cd583ebeff65cc2ULL},
        {0x401f6a7a2955385eULL, 0x3ff0000000000000ULL, 0x3cb60fafbfd97309ULL},
        {0xc01f6a7a2955385eULL, 0xbff0000000000000ULL, 0x3cb60fafbfd97309ULL},
        {0x401f6a7a2955385fULL, 0x3ff0000000000000ULL, 0xbcc4f8282013467cULL},
        {0xc01f6a7a2955385fULL, 0xbff0000000000000ULL, 0xbcc4f8282013467cULL},
        {0x402921fb54442d17ULL, 0xbce469898cc51702ULL, 0x3ff0000000000000ULL},
        {0xc02921fb54442d17ULL, 0x3ce469898cc51702ULL, 0x3ff0000000000000ULL},
        {0x402921fb54442d18ULL, 0xbcc1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0xc02921fb54442d18ULL, 0x3cc1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0x402921fb54442d19ULL, 0x3cd72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0xc02921fb54442d19ULL, 0xbcd72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0x4031475cc9eedeffULL, 0xbff0000000000000ULL, 0xbcfb088e90c77fd1ULL},
        {0xc031475cc9eedeffULL, 0x3ff0000000000000ULL, 0xbcfb088e90c77fd1ULL},
        {0x4031475cc9eedf00ULL, 0xbff0000000000000ULL, 0xbce6111d218effa2ULL},
        {0xc031475cc9eedf00ULL, 0x3ff0000000000000ULL, 0xbce6111d218effa2ULL},
        {0x4031475cc9eedf01ULL, 0xbff0000000000000ULL, 0x3cd3ddc5bce200bbULL},
        {0xc031475cc9eedf01ULL, 0x3ff0000000000000ULL, 0x3cd3ddc5bce200bbULL},
        {0x4035fdbbe9bba774ULL, 0x3cf3dc585b2c7422ULL, 0xbff0000000000000ULL},
        {0xc035fdbbe9bba774ULL, 0xbcf3dc585b2c7422ULL, 0xbff0000000000000ULL},
        {0x4035fdbbe9bba775ULL, 0x3ccee2c2d963a10cULL, 0xbff0000000000000ULL},
        {0xc035fdbbe9bba775ULL, 0xbccee2c2d963a10cULL, 0xbff0000000000000ULL},
        {0x4035fdbbe9bba776ULL, 0xbce8474f49a717bdULL, 0xbff0000000000000ULL},
        {0xc035fdbbe9bba776ULL, 0x3ce8474f49a717bdULL, 0xbff0000000000000ULL},
        {0x403ab41b09886fe9ULL, 0x3ff0000000000000ULL, 0x3ce960444b22d0e4ULL},
        {0xc03ab41b09886fe9ULL, 0xbff0000000000000ULL, 0x3ce960444b22d0e4ULL},
        {0x403ab41b09886feaULL, 0x3ff0000000000000ULL, 0xbcca7eeed374bc71ULL},
        {0xc03ab41b09886feaULL, 0xbff0000000000000ULL, 0xbcca7eeed374bc71ULL},
        {0x403ab41b09886febULL, 0x3ff0000000000000ULL, 0xbcf34fddda6e978eULL},
        {0xc03ab41b09886febULL, 0xbff0000000000000ULL, 0xbcf34fddda6e978eULL},
        {0x403f6a7a2955385dULL, 0xbcf583ebeff65cc2ULL, 0x3ff0000000000000ULL},
        {0xc03f6a7a2955385dULL, 0x3cf583ebeff65cc2ULL, 0x3ff0000000000000ULL},
        {0x403f6a7a2955385eULL, 0xbcd60fafbfd97309ULL, 0x3ff0000000000000ULL},
        {0xc03f6a7a2955385eULL, 0x3cd60fafbfd97309ULL, 0x3ff0000000000000ULL},
        {0x403f6a7a2955385fULL, 0x3ce4f8282013467cULL, 0x3ff0000000000000ULL},
        {0xc03f6a7a2955385fULL, 0xbce4f8282013467cULL, 0x3ff0000000000000ULL},
        {0x4042106ca4910068ULL, 0xbff0000000000000ULL, 0xbd072bdadd2da889ULL},
        {0xc042106ca4910068ULL, 0x3ff0000000000000ULL, 0xbd072bdadd2da889ULL},
        {0x4042106ca4910069ULL, 0xbff0000000000000ULL, 0xbcecaf6b74b6a225ULL},
        {0xc042106ca4910069ULL, 0x3ff0000000000000ULL, 0xbcecaf6b74b6a225ULL},
        {0x4042106ca491006aULL, 0xbff0000000000000ULL, 0x3cf1a84a45a4aeeeULL},
        {0xc042106ca491006aULL, 0x3ff0000000000000ULL, 0x3cf1a84a45a4aeeeULL},
        {0x40446b9c347764a3ULL, 0x3cf72b7f84c04563ULL, 0xbff0000000000000ULL},
        {0xc0446b9c347764a3ULL, 0xbcf72b7f84c04563ULL, 0xbff0000000000000ULL},
        {0x40446b9c347764a4ULL, 0xbce1a900f67f753aULL, 0xbff0000000000000ULL},
        {0xc0446b9c347764a4ULL, 0x3ce1a900f67f753aULL, 0xbff0000000000000ULL},
        {0x40446b9c347764a5ULL, 0xbd046a403d9fdd4fULL, 0xbff0000000000000ULL},
        {0xc0446b9c347764a5ULL, 0x3d046a403d9fdd4fULL, 0xbff0000000000000ULL},
        {0x4046c6cbc45dc8ddULL, 0x3ff0000000000000ULL, 0x3cffff494f2539b3ULL},
        {0xc046c6cbc45dc8ddULL, 0xbff0000000000000ULL, 0x3cffff494f2539b3ULL},
        {0x4046c6cbc45dc8deULL, 0x3ff0000000000000ULL, 0xbc26d61b58c99c43ULL},
        {0xc046c6cbc45dc8deULL, 0xbff0000000000000ULL, 0xbc26d61b58c99c43ULL},
        {0x4046c6cbc45dc8dfULL, 0x3ff0000000000000ULL, 0xbd00005b586d6326ULL},
        {0xc046c6cbc45dc8dfULL, 0xbff0000000000000ULL, 0xbd00005b586d6326ULL},
        {0x404921fb54442d17ULL, 0xbd0469898cc51702ULL, 0x3ff0000000000000ULL},
        {0xc04921fb54442d17ULL, 0x3d0469898cc51702ULL, 0x3ff0000000000000ULL},
        {0x404921fb54442d18ULL, 0xbce1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0xc04921fb54442d18ULL, 0x3ce1a62633145c07ULL, 0x3ff0000000000000ULL},
        {0x404921fb54442d19ULL, 0x3cf72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0xc04921fb54442d19ULL, 0xbcf72cece675d1fdULL, 0x3ff0000000000000ULL},
        {0x3fe999999999999aULL, 0x3fe6f494c2bffecdULL, 0x3fe64b6bde719865ULL},
        {0xbfe999999999999aULL, 0xbfe6f494c2bffecdULL, 0x3fe64b6bde719865ULL},
        {0x3ff0000000000000ULL, 0x3feaed548f090ceeULL, 0x3fe14a280fb5068cULL},
        {0xbff0000000000000ULL, 0xbfeaed548f090ceeULL, 0x3fe14a280fb5068cULL},
        {0x4004000000000000ULL, 0x3fe326af0dcfcab0ULL, 0xbfe9a2f7ef858b7dULL},
        {0xc004000000000000ULL, 0xbfe326af0dcfcab0ULL, 0xbfe9a2f7ef858b7dULL},
        {0x400921f9f01b866eULL, 0x3ec6428a6aa44cd0ULL, 0xbfefffffffff8420ULL},
        {0xc00921f9f01b866eULL, 0xbec6428a6aa44cd0ULL, 0xbfefffffffff8420ULL},
        {0x401d333333333333ULL, 0x3feb36c6dc1d7445ULL, 0x3fe0d5a0848a01cbULL},
        {0xc01d333333333333ULL, 0xbfeb36c6dc1d7445ULL, 0x3fe0d5a0848a01cbULL},
        {0x4029cccccccccccdULL, 0x3fd4f5575997d452ULL, 0x3fee3c4b1e66348aULL},
        {0xc029cccccccccccdULL, 0xbfd4f5575997d452ULL, 0x3fee3c4b1e66348aULL},
        {0x4059000000000000ULL, 0xbfe03425b78c4db8ULL, 0x3feb981dbf665fdfULL},
        {0xc059000000000000ULL, 0x3fe03425b78c4db8ULL, 0x3feb981dbf665fdfULL},
        {0x4076300000000000ULL, 0xbeff9bd0307d1de3ULL, 0xbfefffffffc18e4cULL},
        {0xc076300000000000ULL, 0x3eff9bd0307d1de3ULL, 0xbfefffffffc18e4cULL},
        {0x4091a1b851eb851fULL, 0xbfe205a0623bad13ULL, 0xbfea714ac231588bULL},
        {0xc091a1b851eb851fULL, 0x3fe205a0623bad13ULL, 0xbfea714ac231588bULL},
        {0x40f869fb33333333ULL, 0x3fd51641b9978e8cULL, 0xbfee3691dea69517ULL},
        {0xc0f869fb33333333ULL, 0xbfd51641b9978e8cULL, 0xbfee3691dea69517ULL},
        {0x413921fb1999999aULL, 0xbfcd13bbb59477f3ULL, 0x3fef29d4cbd35cb6ULL},
        {0xc13921fb1999999aULL, 0x3fcd13bbb59477f3ULL, 0x3fef29d4cbd35cb6ULL},
    };
    for (const auto& row : medium) {
        const double x = std::bit_cast<double>(row.x);
        double s, c;
        tn::engine::ieee754::sincos(x, s, c);
        checkV8("medium paired sin", s, row.sin);
        checkV8("medium paired cos", c, row.cos);
        checkV8("medium sin", sin(x), row.sin);
        checkV8("medium cos", cos(x), row.cos);
    }
    // The specials, as node 20's Math.sin/Math.cos answer them: signed zeros keep their sign in sine
    // and give exactly 1 in cosine, infinities and NaNs give NaN in both.
    {
        double s, c;
        tn::engine::ieee754::sincos(0.0, s, c);
        checkV8("sincos(+0) sin", s, 0x0000000000000000ULL);
        checkV8("sincos(+0) cos", c, 0x3ff0000000000000ULL);
        tn::engine::ieee754::sincos(-0.0, s, c);
        checkV8("sincos(-0) sin", s, 0x8000000000000000ULL);
        checkV8("sincos(-0) cos", c, 0x3ff0000000000000ULL);
        for (const std::uint64_t word : {0x7ff0000000000000ULL, 0xfff0000000000000ULL, 0x7ff8000000000000ULL,
                                         0xfff8000000000000ULL, 0x7ff0000000000001ULL}) {
            tn::engine::ieee754::sincos(std::bit_cast<double>(word), s, c);
            CHECK(s != s && c != c);
        }
    }
    // |x| below pi/4 reaches the polynomial kernels; beyond it, argument reduction.
    checkV8("cos(0.1)", cos(0.1), 0x3fefd712f9a817c0ULL);
    checkV8("cos(-0.1)", cos(-0.1), 0x3fefd712f9a817c0ULL);
    checkV8("cos(pi/2)", cos(1.5707963267948966), 0x3c91a62633145c07ULL);
    checkV8("cos(100)", cos(100.0), 0x3feb981dbf665fdfULL);
    checkV8("cos(1e-30)", cos(1e-30), 0x3ff0000000000000ULL);
    checkV8("sin(0.1)", sin(0.1), 0x3fb98eaecb8bcb2cULL);
    checkV8("sin(-0.1)", sin(-0.1), 0xbfb98eaecb8bcb2cULL);
    checkV8("sin(pi/2)", sin(1.5707963267948966), 0x3ff0000000000000ULL);
    checkV8("sin(100)", sin(100.0), 0xbfe03425b78c4db8ULL);
    checkV8("sin(1e-30)", sin(1e-30), 0x39b4484bfeebc2a0ULL);
    checkV8("asin(0.5)", asin(0.5), 0x3fe0c152382d7366ULL);
    checkV8("asin(-0.5)", asin(-0.5), 0xbfe0c152382d7366ULL);
    checkV8("asin(+0)", asin(0.0), 0x0000000000000000ULL);
    checkV8("asin(1)", asin(1.0), 0x3ff921fb54442d18ULL);
    checkV8("asin(-1)", asin(-1.0), 0xbff921fb54442d18ULL);
    checkV8("acos(0.5)", acos(0.5), 0x3ff0c152382d7366ULL);
    checkV8("acos(-0.5)", acos(-0.5), 0x4000c152382d7366ULL);
    checkV8("acos(+0)", acos(0.0), 0x3ff921fb54442d18ULL);
    checkV8("acos(1)", acos(1.0), 0x0000000000000000ULL);
    checkV8("acos(-1)", acos(-1.0), 0x400921fb54442d18ULL);
    checkV8("atan2(1, 1)", atan2(1.0, 1.0), 0x3fe921fb54442d18ULL);
    checkV8("atan2(-1, 1)", atan2(-1.0, 1.0), 0xbfe921fb54442d18ULL);
    checkV8("atan2(1, -1)", atan2(1.0, -1.0), 0x4002d97c7f3321d2ULL);
    checkV8("atan2(-1, -1)", atan2(-1.0, -1.0), 0xc002d97c7f3321d2ULL);
    // The two Color exponents, the integer exactness pow promises, and the 1**-Infinity case.
    checkV8("pow(2.4, 0.41666)", pow(2.4, 0.41666), 0x3ff70b014761012aULL);
    checkV8("pow(0.41666, 2.4)", pow(0.41666, 2.4), 0x3fbf4ff9381f225fULL);
    checkV8("pow(2, 10)", pow(2.0, 10.0), 0x4090000000000000ULL);
    checkV8("pow(0.5, 3)", pow(0.5, 3.0), 0x3fc0000000000000ULL);
    checkV8("pow(1, -1)", pow(1.0, -1.0), 0x3ff0000000000000ULL);
    checkV8("pow(1.002, pi)", pow(1.002, 3.14159), 0x3ff019ca831a9931ULL);
}

}  // namespace

TN_TEST_MAIN({"bits", bits})
