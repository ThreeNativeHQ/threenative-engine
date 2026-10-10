#pragma once
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Perry's numeric WebAudio ABI. Handles are context-owned, never native pointers.
 * packet is eight doubles, zero-filled by the caller; results replace its input lanes.
 * A zero return means success; otherwise the return points to a thread-local named error.
 * Decode queues encoded bytes in one copy; poll returns [ready, buffer, channels, frames, rate].
 * Channel returns [PCM pointer, frames]; PCM only crosses when getChannelData is requested. */
enum tnp_audio_op {
    TNP_AUDIO_CREATE, TNP_AUDIO_INFO, TNP_AUDIO_RESUME, TNP_AUDIO_SUSPEND, TNP_AUDIO_CLOSE,
    TNP_AUDIO_NODE, TNP_AUDIO_CONNECT, TNP_AUDIO_DISCONNECT, TNP_AUDIO_BUFFER,
    TNP_AUDIO_SOURCE_OPTIONS, TNP_AUDIO_START, TNP_AUDIO_STOP, TNP_AUDIO_ENDED,
    TNP_AUDIO_PARAM, TNP_AUDIO_DECODE, TNP_AUDIO_POLL, TNP_AUDIO_BUFFER_INFO,
    TNP_AUDIO_CHANNEL, TNP_AUDIO_PANNER, TNP_AUDIO_LISTENER, TNP_AUDIO_FILTER_TYPE,
    TNP_AUDIO_CREATE_BUFFER, TNP_AUDIO_DRAIN
};
int64_t js_tnp_audio_call(int32_t op, int64_t context, int64_t object,
                        int64_t packet, int64_t data, int64_t bytes);
#ifdef __cplusplus
}
#endif
