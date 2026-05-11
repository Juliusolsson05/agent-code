import { ipcRenderer } from 'electron'

import type { DictationDebugEventInput } from '@preload/api/types.js'

// Renderer-side bridge to the per-session dictation debug journal.
//
// Fire-and-forget by design: we use `ipcRenderer.send` (not `invoke`)
// so hot paths — every `dataavailable` chunk, every 100 ms audio-level
// sample — pay zero round-trip cost. Main batches writes at 100 ms per
// file. See:
//   * src/main/dictationJournal.ts   — on-disk shape
//   * src/main/ipc/dictation.ts      — channel handler
//   * src/preload/api/types.ts       — DictationDebugLayer / EventInput
//
// `debugSessionId` is minted by the renderer in `useComposerDictation`
// at recorder construction time. It is NOT the Deepgram stream id; the
// Deepgram id is null during the first ~180 ms accidental-tap window,
// and a lot of the interesting failure events happen there. Keying the
// debug file on a renderer-owned UUID gives every event a stable home.

export const dictationDebugApi = {
  recordDictationDebugEvent: (
    debugSessionId: string,
    input: DictationDebugEventInput,
  ): void => {
    ipcRenderer.send('dictation:debug-event', debugSessionId, input)
  },
}
