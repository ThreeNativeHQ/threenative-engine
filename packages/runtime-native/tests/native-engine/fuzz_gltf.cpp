// libFuzzer target (PRD-515 phase 3): arbitrary bytes through cgltf and the native glTF loader. A
// refusal is a result; a crash, an out-of-bounds read or undefined behaviour is the failure.
#include "engine/assets/gltf/loader.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    tn::engine::gltf::LoadResult loaded = tn::engine::gltf::load({data, size});
    volatile bool sink = loaded.scene != nullptr;
    (void)sink;
    return 0;
}
