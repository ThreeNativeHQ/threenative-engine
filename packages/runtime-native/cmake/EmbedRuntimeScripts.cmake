if(NOT DEFINED OUTPUT OR NOT DEFINED SOURCE_DIR OR NOT DEFINED SCRIPT_NAMES)
    message(FATAL_ERROR "OUTPUT, SOURCE_DIR, and SCRIPT_NAMES are required")
endif()

get_filename_component(OUTPUT_DIR "${OUTPUT}" DIRECTORY)
file(MAKE_DIRECTORY "${OUTPUT_DIR}")
file(WRITE "${OUTPUT}" "#pragma once\n#include <cstddef>\n#include <string_view>\n\nnamespace mystral::runtime_scripts {\n\nstruct ScriptView {\n    const char* data = nullptr;\n    std::size_t size = 0;\n};\n\n")

set(SCRIPT_CASES "")
foreach(SCRIPT_NAME IN LISTS SCRIPT_NAMES)
    string(MAKE_C_IDENTIFIER "${SCRIPT_NAME}" SCRIPT_IDENTIFIER)
    file(READ "${SOURCE_DIR}/${SCRIPT_NAME}.js" SCRIPT_HEX HEX)
    string(REGEX REPLACE "([0-9A-Fa-f][0-9A-Fa-f])" "0x\\1," SCRIPT_BYTES "${SCRIPT_HEX}")
    file(APPEND "${OUTPUT}"
        "inline constexpr unsigned char k_${SCRIPT_IDENTIFIER}[] = {${SCRIPT_BYTES}};\n"
    )
    set(SCRIPT_CASES
        "${SCRIPT_CASES}    if (name == \"${SCRIPT_NAME}\") return {reinterpret_cast<const char*>(k_${SCRIPT_IDENTIFIER}), sizeof(k_${SCRIPT_IDENTIFIER})};\n"
    )
endforeach()

file(APPEND "${OUTPUT}" "\nstatic inline ScriptView find(std::string_view name) {\n${SCRIPT_CASES}    return {};\n}\n\n}  // namespace mystral::runtime_scripts\n")
