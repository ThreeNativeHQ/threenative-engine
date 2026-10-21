#include "check.h"
#include "engine/renderer/frame_gpu_timer.h"

// A pass outside a frame (texture mips, a compute dispatch) takes a slot in the shared stream, and only
// the next owner frame clears it. Midway's load ran 1199 render passes in one gap, so two such gaps without
// a frame between them filled the stream, and the pass that found it full threw out of render() on every
// later frame (TN_GPU_TIMER_CAPACITY, an unplayable page). A full stream refuses the sample instead.

namespace {

struct Writes {
    WGPUQuerySet querySet = nullptr;
    uint32_t beginningOfPassWriteIndex = 0, endOfPassWriteIndex = 0;
};

void fullStreamRefusesTheSampleAndDoesNotThrow() {
    tn::engine::FrameGpuTimer timer;
    timer.enabled = true;
    bool threw = false;
    uint32_t attached = 0;
    try {
        for (uint32_t i = 0; i < tn::engine::FrameGpuTimer::maxPasses + 5; ++i) {
            Writes writes;
            if (timer.attach(writes, 2)) {
                CHECK(writes.beginningOfPassWriteIndex == attached * 2);
                CHECK(writes.endOfPassWriteIndex == attached * 2 + 1);
                ++attached;
            }
        }
    } catch (...) {
        threw = true;
    }
    CHECK(!threw);
    CHECK(attached == tn::engine::FrameGpuTimer::maxPasses);
    CHECK(timer.segments.size() == tn::engine::FrameGpuTimer::maxPasses);
    CHECK(timer.failed);
}

void ownerFrameEndRestoresTiming() {
    tn::engine::FrameGpuTimer timer;
    for (uint32_t i = 0; i < tn::engine::FrameGpuTimer::maxPasses; ++i) {
        Writes writes;
        CHECK(timer.attach(writes, 2));
    }
    Writes refused;
    CHECK(!timer.attach(refused, 2));
    // What Renderer::render does after the frame it owns.
    timer.segments.clear();
    timer.failed = false;
    Writes again;
    CHECK(timer.attach(again, 1));
    CHECK(again.beginningOfPassWriteIndex == 0);
    CHECK(timer.segments.size() == 1);
}

}  // namespace

TN_TEST_MAIN({"full_stream", fullStreamRefusesTheSampleAndDoesNotThrow},
             {"owner_frame_restores", ownerFrameEndRestoresTiming})
