#pragma once

#include <memory>

// A mirror's pass is keyed by its reflector's address (render_database.cpp's reflections_). A world switch frees
// the old reflector and the next world's mirror can be handed the same address, so the entry records the reflector
// it was built for: a pass whose owner is gone is the dead reflector's, never the new one's, and is rebuilt rather
// than handed over with its renderer and its database (PRD-806 E58).

namespace tn::engine {

/** Whether the pass recorded for a reflector's address was built for a reflector that is gone. */
inline bool reflectionPassIsStale(const std::weak_ptr<const void>& owner) { return owner.expired(); }

} // namespace tn::engine
