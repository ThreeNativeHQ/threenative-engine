# The desktop web-view UI overlay in the engine player: the same Rust staticlib and system webkit2gtk the
# legacy host links (CMakeLists.txt, TN_ENABLE_UI_OVERLAY). Included by NativeEngine.cmake only with
# -DTN_ENGINE_PLAYER_UI_OVERLAY=ON, after tn_engine_player exists.
if(NOT CMAKE_SYSTEM_NAME STREQUAL "Linux")
    message(FATAL_ERROR "TN_ENGINE_PLAYER_UI_OVERLAY is wired for Linux only; the legacy host's CMakeLists.txt names the Windows and macOS libraries.")
endif()
set(TN_PLAYER_UI_OVERLAY_LIB "${CMAKE_CURRENT_SOURCE_DIR}/native/ui-overlay/target/release/libthreenative_ui_overlay.a")
if(NOT EXISTS "${TN_PLAYER_UI_OVERLAY_LIB}")
    message(FATAL_ERROR "UI overlay artifact is missing: ${TN_PLAYER_UI_OVERLAY_LIB}. Run node scripts/build-native-ui-overlay.mjs.")
endif()
add_library(tn-player-ui-overlay STATIC IMPORTED)
set_target_properties(tn-player-ui-overlay PROPERTIES IMPORTED_LOCATION "${TN_PLAYER_UI_OVERLAY_LIB}")
find_package(PkgConfig REQUIRED)
pkg_check_modules(TN_WEBKITGTK REQUIRED IMPORTED_TARGET webkit2gtk-4.1)
target_compile_definitions(tn_engine_player PRIVATE TN_ENABLE_UI_OVERLAY=1 TN_ENABLE_CSS_UI=0)
target_link_libraries(tn_engine_player PUBLIC tn-player-ui-overlay PkgConfig::TN_WEBKITGTK)

# SDL3's tray defines g_object_ref and g_object_ref_sink as globals that would shadow GObject's, and
# gtk_init then calls a null pointer. Rename the two in SDL's one object file, as the legacy host does
# (CMakeLists.txt, "tn-sdl-tray-rename"), before anything links SDL.
if(SDL3_STATIC_TARGET)
    find_program(TN_OBJCOPY NAMES objcopy llvm-objcopy)
    if(NOT TN_OBJCOPY)
        message(FATAL_ERROR "objcopy is required to build the UI overlay: SDL3's tray defines g_object_ref and g_object_ref_sink as globals.")
    endif()
    file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray")
    set(TN_SDL_TRAY_STAMP "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray/renamed.stamp")
    add_custom_command(OUTPUT "${TN_SDL_TRAY_STAMP}"
        COMMAND "${CMAKE_AR}" x "$<TARGET_FILE:${SDL3_STATIC_TARGET}>" SDL_tray.c.o
        COMMAND "${TN_OBJCOPY}"
            --redefine-sym g_object_ref=tn_sdl_tray_g_object_ref
            --redefine-sym g_object_ref_sink=tn_sdl_tray_g_object_ref_sink
            SDL_tray.c.o SDL_tray.c.o
        COMMAND "${CMAKE_AR}" r "$<TARGET_FILE:${SDL3_STATIC_TARGET}>" SDL_tray.c.o
        COMMAND "${CMAKE_COMMAND}" -E touch "${TN_SDL_TRAY_STAMP}"
        DEPENDS ${SDL3_STATIC_TARGET}
        WORKING_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/tn-sdl-tray"
        COMMENT "Renaming SDL3 tray's GObject globals so the UI overlay's GTK calls survive"
        VERBATIM)
    add_custom_target(tn-sdl-tray-rename DEPENDS "${TN_SDL_TRAY_STAMP}")
    add_dependencies(tn_engine_player tn-sdl-tray-rename)
endif()
