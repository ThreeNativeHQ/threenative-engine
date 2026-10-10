/* Perry's numeric FFI over the same ABI the Wasm facade calls. No Perry values enter the engine. */
#include "threenative/abi/tn_tsl.h"
#include <stdlib.h>
#include <string.h>

extern uint32_t tnp_dispatch(uintptr_t id, uintptr_t args, uint32_t count, uintptr_t packet);
extern void tnp_release_callback(uintptr_t id);
extern uintptr_t tnw_attribute_view(const tn_handle_t *attribute, uint64_t *out);
extern void tnw_attribute_view_release(uintptr_t lease);

static tn_status_t callback(void *id, const tn_value_t *args, uint32_t count,
                            char *error, uint32_t capacity) {
    const uintptr_t packet[2] = {(uintptr_t)error, capacity};
    return tnp_dispatch((uintptr_t)id, (uintptr_t)args, count, (uintptr_t)packet);
}
static void release_callback(void *id) { tnp_release_callback((uintptr_t)id); }

int64_t js_tnp_layout(int32_t field) {
    const size_t layout[] = {sizeof(void *), sizeof(tn_handle_t), sizeof(tn_value_t),
        sizeof(tn_diagnostic_t), offsetof(tn_value_t, text), offsetof(tn_value_t, count),
        offsetof(tn_value_t, numbers), sizeof(tn_tsl_arg_t)};
    return field >= 0 && field < 8 ? (int64_t)layout[field] : -1;
}
int64_t js_tnp_alloc(int64_t bytes) {
    return bytes > 0 ? (int64_t)(uintptr_t)calloc(1, (size_t)bytes) : 0;
}
void js_tnp_free(int64_t pointer) { free((void *)(uintptr_t)pointer); }

/* memcpy avoids alignment and aliasing assumptions on engine fields. */
double js_tnp_memory(int32_t kind, int64_t address, double number) {
    void *pointer = (void *)(uintptr_t)address;
#define ACCESS(code, type) \
    case code: { type value; memcpy(&value, pointer, sizeof(value)); return (double)value; } \
    case code + 16: { type value = (type)number; memcpy(pointer, &value, sizeof(value)); return number; }
    switch (kind) {
        ACCESS(0, uint8_t)
        ACCESS(1, uint16_t)
        ACCESS(2, uint32_t)
        ACCESS(3, uint64_t)
        ACCESS(4, double)
        ACCESS(5, float)
        ACCESS(6, int8_t)
        ACCESS(7, int16_t)
        ACCESS(8, int32_t)
        default: return 0;
    }
#undef ACCESS
}

/* Struct-by-value C parameters arrive as pointers, exactly as with Emscripten's wrappers. */
int64_t js_tnp_call(int32_t op, int64_t a, int64_t b, int64_t c, int64_t d,
                    int64_t e, int64_t f, int64_t g) {
#define P(type, x) ((type *)(uintptr_t)(x))
#define H(x) (*P(tn_handle_t, x))
    switch (op) {
        case 0: *P(tn_version_info_t, a) = tn_engine_version(); return 0;
        case 1: return tn_context_create(P(tn_context_t *, a), P(tn_version_info_t, b), P(tn_diagnostic_t, c));
        case 2: return tn_type_id(P(char, a));
        case 3: return tn_object_release(H(a), P(tn_diagnostic_t, b));
        case 4: tn_object_engine_references(P(tn_handle_t, a), (uint32_t)b, P(uint32_t, c)); return 0;
        case 5: return tn_construct(P(tn_context_t, a), P(char, b), P(tn_value_t, c), (uint32_t)d, P(tn_handle_t, e), P(tn_diagnostic_t, f));
        case 6: return tn_invoke(H(a), P(char, b), P(tn_value_t, c), (uint32_t)d, P(tn_value_t, e), P(tn_diagnostic_t, f));
        case 7: return tn_get(H(a), P(char, b), P(tn_value_t, c), P(tn_diagnostic_t, d));
        case 8: return tn_set(H(a), P(char, b), P(tn_value_t, c), P(tn_diagnostic_t, d));
        case 9: return tn_set_callback(H(a), P(char, b), c ? callback : NULL, (void *)(uintptr_t)d, c ? release_callback : NULL, P(tn_diagnostic_t, f));
        case 10: tn_diagnostic_release(P(tn_diagnostic_t, a)); return 0;
        case 11: return tn_tsl_call(P(tn_context_t, a), P(char, b), P(uint64_t, c), P(tn_tsl_arg_t, d), (uint32_t)e, P(uint64_t, f), P(tn_diagnostic_t, g));
        case 12: return tn_tsl_release(P(tn_context_t, a), (uint64_t)b, P(tn_diagnostic_t, c));
        case 13: return tn_tsl_set(P(tn_context_t, a), H(b), P(char, c), (uint64_t)d, P(tn_diagnostic_t, e));
        case 14: return tn_tsl_set_uniform(P(tn_context_t, a), P(uint64_t, b), P(double, c), (uint32_t)d, P(tn_diagnostic_t, e));
        case 15: return tn_tsl_effect_parameter(P(tn_context_t, a), P(uint64_t, b), P(char, c), P(double, d), P(double, e), P(tn_diagnostic_t, f));
        case 16: return tn_context_destroy(P(tn_context_t, a), P(tn_diagnostic_t, b));
        case 17: return (int64_t)tnw_attribute_view(P(tn_handle_t, a), P(uint64_t, b));
        case 18: tnw_attribute_view_release((uintptr_t)a); return 0;
        default: return TN_ERROR_INVALID_ARGUMENT;
    }
#undef H
#undef P
}
