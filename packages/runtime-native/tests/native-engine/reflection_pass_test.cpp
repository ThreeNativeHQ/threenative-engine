#include "check.h"
#include "engine/renderer/reflection_pass.h"

#include <memory>

// One mirrored pass per live reflector, keyed by the reflector's address (render_database.cpp's reflections_).
// A world switch frees the old reflector and the next world's mirror can take its address, so the entry records
// the reflector it was built for and is rebuilt once that one is gone; reusing it hands the new mirror the dead
// reflector's renderer and database (PRD-806 E58).

namespace {

using tn::engine::reflectionPassIsStale;

void reusedWhileItsReflectorLives() {
    const std::shared_ptr<const int> reflector = std::make_shared<int>(7);
    const std::weak_ptr<const void> owner = reflector;
    CHECK(!reflectionPassIsStale(owner));
}

void rebuiltWhenANewReflectorTakesTheAddress() {
    std::shared_ptr<const int> released = std::make_shared<int>(7);
    const std::weak_ptr<const void> recorded = released; // the pass's owner: what it was built for
    released.reset();                                    // a world switch frees that reflector
    const std::shared_ptr<const int> next =
        std::make_shared<int>(9); // the next mirror, which can take the freed address
    CHECK(recorded.expired());
    CHECK(reflectionPassIsStale(recorded));                         // the entry there is nobody's: rebuild it
    CHECK(!reflectionPassIsStale(std::weak_ptr<const void>(next))); // and it is not that new mirror's pass
}

} // namespace

TN_TEST_MAIN({"reused_while_alive", reusedWhileItsReflectorLives},
             {"rebuilt_when_the_address_is_reused", rebuiltWhenANewReflectorTakesTheAddress})
