#include "check.h"
#include "engine/renderer/probes/capture.h"
#include <limits>
using namespace tn::engine;
int main() {
    CHECK(probes::validCaptureFace(Vector3{2, 3, 4}, 256, 5, 0.01, 2000));
    CHECK(!probes::validCaptureFace(Vector3{}, 256, 6, 0.1, 100));
    CHECK(!probes::validCaptureFace(Vector3{}, 0, 0, 0.1, 100));
    CHECK(!probes::validCaptureFace(Vector3{}, 256, 0, 0, 100));
    CHECK(!probes::validCaptureFace(Vector3{}, 256, 0, 100, 100));
    CHECK(!probes::validCaptureFace(Vector3{std::numeric_limits<double>::quiet_NaN(), 0, 0}, 256, 0, 0.1, 100));
    return tn_check_failures ? 1 : 0;
}
