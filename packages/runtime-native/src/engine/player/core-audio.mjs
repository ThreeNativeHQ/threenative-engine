// three's audio classes over the engine Object3D and the player's WebAudio (the legacy host's).
// The facade re-exports the classes; core-host pushes poses to WebAudio once per tick. One set per
// isolate: a game entry that imports core-host itself bundles this module twice, and a second set
// would tick voices the game never made.
import { defineAudioClasses } from "../../../../three-native/src/audio.ts";

const { Object3D, Vector3, Quaternion } = globalThis;
if (!globalThis.__tnAudio)
  globalThis.__tnAudio = defineAudioClasses({ Object3D, Vector3, Quaternion,
    read: async (url) => globalThis.tn.loadAsset("audio", url).value });
export const audio = globalThis.__tnAudio;
