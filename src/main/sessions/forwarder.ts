import type { SessionManager } from '@main/sessionManager.js'
import type { LspManager } from '@main/lspManager.js'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import { enqueueJsonl, flushAndDropJsonl } from '@main/sessions/jsonlCoalescer.js'
import { SubAgentWatcherManager } from '@main/subagents/index.js'

// Session event forwarder.
//
// Wires every manager event to a matching IPC channel. Each payload
// already carries the sessionId so the renderer can route to the
// right tile. The forwarder's job is the dumbest possible one: tag
// the channel, push the payload.
//
// terminal-data and agent-pty-data are intentionally separate channels from
// screen / jsonl-entry. terminal-data is for plain shell panes;
// agent-pty-data is an opt-in inline terminal for Claude/Codex panes.
// Keeping both out of the normal structured feed path prevents every
// agent pane listener from unpacking and ignoring raw PTY bytes.

export function wireSessionForwarder(
  manager: SessionManager,
  lspManager: LspManager,
): void {
  // Per-session subagent fleet watcher. Driven off the main transcript stream
  // (jsonl-entry carries the transcript `file` we derive the subagents dir
  // from, and the tool_result blocks that flip a subagent to done/error). See
  // src/main/subagents/.
  const subAgents = new SubAgentWatcherManager((sessionId, map) =>
    sendToMainWindow('session:sub-agents', { sessionId, subAgents: map }),
  )

  manager.on('started', payload => sendToMainWindow('session:started', payload))
  manager.on('screen', payload => sendToMainWindow('session:screen', payload))

  // Bulk-only forwarding. See jsonlCoalescer.ts for the full rationale
  // — every jsonl-entry goes through the coalescer; live single
  // entries become 1-element bulk messages with imperceptible latency.
  manager.on('jsonl-entry', payload => {
    enqueueJsonl(payload.sessionId, payload.entry, payload.file)
    subAgents.observeParentEntry(payload.sessionId, payload.entry, payload.file)
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
  manager.on('agent-pty-data', payload =>
    sendToMainWindow('session:agent-pty-data', payload),
  )
  manager.on('process-state', payload => sendToMainWindow('session:process-state', payload))
  // Legacy per-condition channels (session:trust-dialog / :resume-prompt /
  // :permission-prompt / :compaction-state) are no longer forwarded to the
  // renderer. The renderer consumes only the unified `session:conditions`
  // snapshot and derives every pending-prompt field from it; no renderer or
  // harness ever subscribed to the granular channels (confirmed by rg before
  // removal — see docs/audit-plans/execution/ipc-shared-contracts-implementation-log.md).
  // The manager STILL emits the granular events internally (provider runtimes
  // drive them); we simply stop bridging them over IPC. Re-deprecating the
  // manager-level events is owned by the conditions-framework cluster.
  manager.on('conditions', payload => sendToMainWindow('session:conditions', payload))
  manager.on('semantic-event', payload => sendToMainWindow('session:semantic-event', payload))
  manager.on('exit', payload => {
    // Final flush — any entries still buffered from the last
    // bootstrapTail tick must land before exit so the renderer sees a
    // consistent final entries list.
    flushAndDropJsonl(payload.sessionId)
    subAgents.stop(payload.sessionId)
    sendToMainWindow('session:exit', payload)
  })
  lspManager.on('diagnostics', payload => sendToMainWindow('lsp:diagnostics', payload))
}
