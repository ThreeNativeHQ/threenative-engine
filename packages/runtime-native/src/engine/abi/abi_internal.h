#pragma once

// Engine-internal access behind the C ABI, for in-process callers that own both sides (a host that
// hands a game's scene to the renderer). Not part of the C ABI: nothing outside this repository's
// own executables may include it.

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "engine/abi/binding.h"
#include "threenative/abi/tn_abi.h"

namespace tn::abi {

/** The native object a live handle names (class name and shared ownership), or null. */
tn::binding::Object* objectOf(tn_handle_t handle);

/**
 * References to a live handle's object held by other engine objects (a parent, a material slot, a
 * mixer): its use count minus the copies the context itself holds for handles and member aliases.
 * 0 for a dead handle.
 */
uint32_t engineReferences(tn_handle_t handle);

/** Adopt a native loader/clone result into the context's ordinary handle/lifetime table. */
tn_handle_t shareObject(tn_context_t* context, std::string cls, std::shared_ptr<void> object);

/** In-process graph bridge; uses the same registered material getters/setters as other callers. */
engine::shader::graph::Node shaderNode(tn_handle_t handle, const std::string& path);
void setShaderNode(tn_handle_t handle, const std::string& path, engine::shader::graph::Node node);
/** The graph a tn_tsl_call node id names in `context`, or null. */
engine::shader::graph::Node tslNode(tn_context_t* context, uint64_t id);

/**
 * A numeric property write for a caller that repeats one member on one class (the V8 adapter's
 * accessor): `slot` remembers the setter found for the last class, so a steady write skips the name
 * lookup. Same status, diagnostic and crossing count as tn_set with a number value.
 */
struct SetterSlot {
    const void* binding = nullptr;
    const tn::binding::Setter* setter = nullptr;
};
tn_status_t setNumber(tn_handle_t handle, SetterSlot& slot, const std::string& name, double value, tn_diagnostic_t* diagnostic);

/**
 * The same for a read (`tn_get`): `slot` remembers the getter or member found for the last class, so a
 * steady read skips both name lookups. Same status, diagnostic and crossing count as tn_get.
 */
struct GetterSlot {
    const void* binding = nullptr;
    const tn::binding::Getter* getter = nullptr;
    const tn::binding::Method* member = nullptr;
};
tn_status_t getValue(tn_handle_t handle, GetterSlot& slot, const std::string& name, tn_value_t* result, tn_diagnostic_t* diagnostic);

/** The same for a method call (`tn_invoke`). */
struct MethodSlot {
    const void* binding = nullptr;
    const tn::binding::Method* method = nullptr;
};
tn_status_t invokeMethod(tn_handle_t handle, MethodSlot& slot, const std::string& name, const tn_value_t* args, uint32_t count,
                         tn_value_t* result, tn_diagnostic_t* diagnostic);

/**
 * A language view's hold on the storage behind a handle (PRD-573 v1.11 step 4a): a typed array over a
 * math object's own doubles must not outlive them. A transform column address leases its page slot
 * (Object3D::leaseTransform); any other object is held by a shared_ptr copy that engineReferences does
 * not count, so a view held by its owner's own wrapper never keeps that wrapper strong.
 */
struct ViewClaim;
/** Claims `handle`'s object. `address` is its storage, `column` the transform column it is in (-1: none). Null for a dead handle. */
ViewClaim* claimView(tn_handle_t handle, const void*& address, int& column);
/** A lease on a transform column address of a slot the caller already holds a claim in (a sibling column). */
ViewClaim* claimColumn(const void* address);
/** Returns a claim. Not safe from any thread: the language side queues claims and calls this on its own thread. */
void releaseViewClaim(ViewClaim* claim);
/** Drops a handle without moving the ownership epoch: for a handle whose object was only a math value view. */
void dropHandle(tn_handle_t handle);

/** Calls that crossed the C ABI (construct, invoke, get, set) since the process started. */
uint64_t crossings();

/**
 * A counter that moves whenever the engine may have started or stopped holding an object for the language
 * side: a handle released, a property or constructor given an object or a null, a method on a class that can
 * keep objects given an object, or any change to the scene hierarchy. A safe point that sees the same value as
 * last time can skip deciding again which wrappers the engine still holds (PRD-573 v1.11 step 1).
 */
uint64_t ownershipEpoch();

/**
 * The per-name histogram of those crossings (the property, method or class name), for finding which names a
 * frame spends them on. Enabling clears it; while on, its counts sum to the `crossings()` delta since then.
 * Off by default: a crossing then costs one relaxed load more.
 */
void crossingHistogramEnable(bool on);
std::vector<std::pair<std::string, uint64_t>> crossingHistogram();  // most crossed first

}  // namespace tn::abi

extern "C" int64_t js_tnp_set_post(int64_t context, int64_t node);
