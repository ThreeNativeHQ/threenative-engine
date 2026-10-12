// libFuzzer target (PRD-500 phase 3): random handles, version records, type names and context
// churn through the C ABI. Every call must return a status; ASan/UBSan judge every access.
#include "threenative/abi/tn_abi.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    std::vector<tn_context_t*> contexts;
    std::vector<tn_handle_t> handles;
    const tn_version_info_t own = tn_engine_version();
    size_t at = 0;
    auto byte = [&]() -> uint8_t { return at < size ? data[at++] : 0; };
    auto bytes = [&](void* out, size_t n) {
        std::memset(out, 0, n);
        const size_t take = at + n <= size ? n : size - at;
        std::memcpy(out, data + at, take);
        at += take;
    };
    while (at < size) {
        tn_diagnostic_t diagnostic{nullptr, 0};
        switch (byte() % 7) {
            case 0: {
                tn_context_t* context = nullptr;
                tn_version_info_t module = own;
                if (byte() & 1) bytes(&module, sizeof module);
                if (tn_context_create(&context, &module, &diagnostic) == TN_OK) contexts.push_back(context);
                break;
            }
            case 1:
                if (!contexts.empty()) {
                    const size_t i = byte() % contexts.size();
                    tn_context_destroy(contexts[i], &diagnostic);
                    if (byte() & 1) contexts.erase(contexts.begin() + static_cast<long>(i));  // else keep it dangling-by-id only
                }
                break;
            case 2:
                if (!contexts.empty()) {
                    uint16_t type = 0;
                    bytes(&type, sizeof type);
                    tn_handle_t handle{};
                    if (tn_object_create(contexts[byte() % contexts.size()], type % 130, &handle, &diagnostic) == TN_OK) {
                        handles.push_back(handle);
                    }
                }
                break;
            case 3: {
                tn_handle_t handle{};
                if (!handles.empty() && (byte() & 1)) handle = handles[byte() % handles.size()];
                else bytes(&handle, sizeof handle);
                tn_object_release(handle, &diagnostic);
                break;
            }
            case 4: {
                tn_version_info_t module{};
                bytes(&module, sizeof module);
                tn_version_handshake(&module, nullptr, &diagnostic);
                break;
            }
            case 5: {
                const size_t n = byte() % 32;
                std::string name(n, '\0');
                bytes(name.data(), n);
                tn_type_id(name.c_str());
                break;
            }
            case 6:
                tn_version_handshake(nullptr, nullptr, &diagnostic);
                break;
        }
        tn_diagnostic_release(&diagnostic);
    }
    // Contexts from this input are torn down so the next input starts clean.
    for (tn_context_t* context : contexts) {
        tn_diagnostic_t diagnostic{nullptr, 0};
        tn_context_destroy(context, &diagnostic);
        tn_diagnostic_release(&diagnostic);
    }
    return 0;
}
