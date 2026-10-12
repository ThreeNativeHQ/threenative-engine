/* PRD-500: the ABI header compiles as C11 and links from a C program. */
#include "threenative/abi/tn_abi.h"
#include "threenative/abi/tn_tsl.h" /* PRD-540: tn_tsl_arg_t compiles as C11 too */

#include <stdio.h>

int main(void) {
    tn_version_info_t module = tn_engine_version();
    tn_diagnostic_t diagnostic = {0, 0};
    tn_context_t* context = 0;
    if (tn_context_create(&context, &module, &diagnostic) != TN_OK) return 1;
    tn_handle_t mesh;
    if (tn_object_create(context, tn_type_id("Mesh"), &mesh, &diagnostic) != TN_OK) return 2;
    if (tn_object_release(mesh, &diagnostic) != TN_OK) return 3;
    if (tn_context_destroy(context, &diagnostic) != TN_OK) return 4;
    tn_diagnostic_release(&diagnostic);
    printf("PASS c11 type Mesh=%u\n", (unsigned)mesh.type);
    return 0;
}
