import { ipcRenderer } from 'electron'

import type { PasteDebugEventInput } from '@preload/api/types.js'

// Renderer-side bridge to the per-paste debug journal.
//
// Fire-and-forget via `ipcRenderer.send` (not `invoke`) so hot paths
// — every keydown, every chunked-paste IPC write — pay zero
// round-trip cost. Main batches writes at 100 ms per file. Same
// shape as `dictationDebugApi` in PR #68.
//
// `pasteId` is renderer-minted at the moment Enter is observed in the
// composer keydown handler. See `preload/api/types.ts` → PasteDebugLayer.

export const pasteDebugApi = {
  recordPasteDebugEvent: (
    pasteId: string,
    input: PasteDebugEventInput,
  ): void => {
    ipcRenderer.send('paste:debug-event', pasteId, input)
  },
}
