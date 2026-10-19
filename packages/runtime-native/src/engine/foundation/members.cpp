#include "members.h"

namespace tn::engine {

Handle MemberAliases::alias(Handle owner, uint16_t member, uint16_t memberType) {
    if (handles_.check(owner) != HandleError::None) return Handle{};
    const uint64_t k = key(owner, member);
    const auto found = byOwner_.find(k);
    // A cached alias is reused only while it still names this owner generation: a reused owner
    // slot gets fresh aliases, never the previous object's.
    if (found != byOwner_.end()) {
        const auto target = byAlias_.find(found->second.index);
        if (handles_.check(found->second) == HandleError::None && target != byAlias_.end() &&
            target->second.owner.generation == owner.generation) {
            return found->second;
        }
    }
    const Handle alias = handles_.allocate(memberType);
    byOwner_[k] = alias;
    byAlias_[alias.index] = Target{owner, member};
    return alias;
}

bool MemberAliases::resolve(Handle alias, Target& out) const {
    if (handles_.check(alias) != HandleError::None) return false;
    const auto found = byAlias_.find(alias.index);
    if (found == byAlias_.end() || handles_.check(found->second.owner) != HandleError::None) return false;
    out = found->second;
    return true;
}

// ponytail: a linear scan over every alias; index aliases by owner if releases show up in profiles.
void MemberAliases::releaseOwner(Handle owner) {
    for (auto it = byOwner_.begin(); it != byOwner_.end();) {
        if ((it->first >> 16) == owner.index) {
            byAlias_.erase(it->second.index);
            handles_.release(it->second);
            it = byOwner_.erase(it);
        } else {
            ++it;
        }
    }
}

}  // namespace tn::engine
