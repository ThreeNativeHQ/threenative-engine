# ctest native_engine_no_blocking_waits: the game thread never blocks for GPU/async completion,
# so the same code runs on browser WebGPU (owner decision 4, PRD-509). Tests may wait.
# Reviewed worker parking may annotate ONLY the condition-variable include, declaration and
# predicate wait with TN_WORKER_ONLY: and a reason. The wait must run inside a worker entry,
# never load/admit/drain; enqueue only notifies, and joining belongs to teardown. An annotation
# cannot excuse GPU waits, sleeps or futures, and is not a file-wide exemption.
file(GLOB_RECURSE sources "${ENGINE_SOURCE_DIR}/*.cpp" "${ENGINE_SOURCE_DIR}/*.h")
if(NOT sources)
    message(FATAL_ERROR "no engine sources under ${ENGINE_SOURCE_DIR}")
endif()
set(forbidden "wgpuInstanceWaitAny|wgpuDevicePoll\\([^,]+, *(true|1)|sleep_for|sleep_until|condition_variable|\\.wait\\(|std::future")
set(failures "")
foreach(source IN LISTS sources)
    file(STRINGS "${source}" lines REGEX "${forbidden}")
    foreach(line IN LISTS lines)
        if(line MATCHES "// TN_WORKER_ONLY: .+")
            string(REGEX REPLACE " *// TN_WORKER_ONLY: .*$" "" worker_line "${line}")
            if(worker_line MATCHES "^ *#include <condition_variable>$" OR
               worker_line MATCHES "^ *std::condition_variable [A-Za-z_][A-Za-z_0-9]*;$" OR
               worker_line MATCHES "^ *[A-Za-z_][A-Za-z_0-9]*\\.wait\\(lock, \\[this\\] \\{ return stopping_ \\|\\| !pending_\\.empty\\(\\); \\}\\);$")
                continue()
            endif()
        endif()
        list(APPEND failures "${source}: ${line}")
    endforeach()
endforeach()
if(failures)
    string(REPLACE ";" "\n  " failures "${failures}")
    message(FATAL_ERROR "blocking wait in engine sources:\n  ${failures}")
endif()
list(LENGTH sources count)
message(STATUS "${count} engine sources, no blocking waits")
