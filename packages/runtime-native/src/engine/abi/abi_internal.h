#pragma once

// Engine-internal access behind the C ABI, for in-process callers that own both sides (a host that
// hands a game's scene to the renderer). Not part of the C ABI: nothing outside this repository's
// own executables may include it.

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

/** Calls that crossed the C ABI (construct, invoke, get, set) since the process started. */
uint64_t crossings();

}  // namespace tn::abi

extern "C" int64_t js_tnp_set_post(int64_t context, int64_t node);
