#pragma once

#include <cstdint>
#include <unordered_map>

#include "engine/foundation/handles.h"

namespace tn::engine {

/**
 * Member aliases (PRD-502 phase 2): `mesh.position` is the same logical object on every access.
 * An alias is a handle of the member's own type whose slot names (owner, member) instead of
 * holding a value, so it resolves through the owner every time: it follows the owner's storage
 * when that grows, and dies with the owner. Repeated access returns the one cached alias handle.
 */
class MemberAliases {
public:
    explicit MemberAliases(HandleTable& handles) : handles_(handles) {}

    /** The alias for (owner, member), created on first access and returned unchanged after. */
    Handle alias(Handle owner, uint16_t member, uint16_t memberType);

    struct Target {
        Handle owner;
        uint16_t member = 0;
    };
    /** The (owner, member) an alias names, or false when either is no longer live. */
    bool resolve(Handle alias, Target& out) const;

    /** Drops every alias of an owner; call when the owner is released. */
    void releaseOwner(Handle owner);

    size_t size() const { return byAlias_.size(); }

private:
    static uint64_t key(Handle owner, uint16_t member) {
        return (uint64_t{owner.index} << 16) | member;
    }
    HandleTable& handles_;
    std::unordered_map<uint64_t, Handle> byOwner_;    // (owner index, member) -> alias
    std::unordered_map<uint32_t, Target> byAlias_;    // alias index -> target
};

}  // namespace tn::engine
