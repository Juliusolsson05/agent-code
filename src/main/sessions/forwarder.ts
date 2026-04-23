import type { SessionManager } from '../sessionManager.js'
import type { LspManager } from '../lspManager.js'

import { sendToMainWindow } from '../window/mainWindow.js'
import { enqueueJsonl, flushAndDropJsonl } from './jsonlCoalescer.js'

// Session event forwarder.
//
// Wires every manager event to a matching IPC channel. Each payload
// already carries the sessionId so the renderer can route to the
// right tile. The forwarder's job is the dumbest possible one: tag
// the channel, push the payload.
//
// terminal-data is intentionally a separate channel from screen /
// jsonl-entry — keeps every Claude pane listener from unpacking and
// ignoring raw PTY bytes it doesn't care about.

export function wireSessionForwarder(
  manager: SessionManager,
  lspManager: LspManager,
): void {
  manager.on('started', payload => sendToMainWindow('session:started', payload))
  manager.on('screen', payload => sendToMainWindow('session:screen', payload))

  // Bulk-only forwarding. See jsonlCoalescer.ts for the full rationale
  // — every jsonl-entry goes through the coalescer; live single
  // entries become 1-element bulk messages with imperceptible latency.
  manager.on('jsonl-entry', payload => {
    enqueueJsonl(payload.sessionId, payload.entry, payload.file)
  })
  manager.on('jsonl-error', ({ sessionId, error }) =>
    sendToMainWindow('session:jsonl-error', {
      sessionId,
      message: String(error.message ?? error),
    }),
  )
  manager.on('terminal-data', payload =>
    sendToMainWindow('session:terminal-data', payload),
  )
  manager.on('process-state', payload => sendToMainWindow('session:process-state', payload))
  manager.on('trust-dialog', payload => sendToMainWindow('session:trust-dialog', payload))
  manager.on('resume-prompt', payload => sendToMainWindow('session:resume-prompt', payload))
  manager.on('compaction-state', payload => sendToMainWindow('session:compaction-state', payload))
  manager.on('semantic-event', payload => sendToMainWindow('session:semantic-event', payload))
  manager.on('exit', payload => {
    // Final flush — any entries still buffered from the last
    // bootstrapTail tick must land before exit so the renderer sees a
    // consistent final entries list.
    flushAndDropJsonl(payload.sessionId)
    sendToMainWindow('session:exit', payload)
  })
  lspManager.on('diagnostics', payload => sendToMainWindow('lsp:diagnostics', payload))
}
