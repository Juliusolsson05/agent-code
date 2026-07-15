import type { SessionManager } from '@main/sessionManager.js'
import type { LspManager } from '@main/lspManager.js'

import { sendToMainWindow } from '@main/window/mainWindow.js'
import {
  enqueueJsonl,
  flushAllJsonl,
  flushAndDropJsonl,
  flushJsonl,
} from '@main/sessions/jsonlCoalescer.js'
import { SemanticEventIpcCoalescer } from '@main/sessions/semanticEventCoalescer.js'
import { LatestSessionIpcCoalescer } from '@main/sessions/latestSessionIpcCoalescer.js'
import { SubAgentWatcherManager } from '@main/subagents/index.js'

// Session event forwarder.
//
// Wires every manager event to a matching IPC channel. Each payload already
// carries the sessionId so the renderer can route to the right tile. Complete
// snapshots and cumulative semantic prefixes pass through the narrow
// coalescers below; structural events still preserve direct ordering.
//
// terminal-data and agent-pty-data are intentionally separate channels from
// screen / jsonl-entry. terminal-data is for plain shell panes;
// agent-pty-data is an opt-in inline terminal for Claude/Codex panes.
// Keeping both out of the normal structured feed path prevents every
// agent pane listener from unpacking and ignoring raw PTY bytes.

export type SessionForwarderControl = {
  flush(): void
}

export function wireSessionForwarder(
  manager: SessionManager,
  lspManager: LspManager,
): SessionForwarderControl {
  // Per-session subagent fleet watcher. Driven off the main transcript stream
  // (jsonl-entry carries the transcript `file` we derive the subagents dir
  // from, and the tool_result blocks that flip a subagent to done/error). See
  // src/main/subagents/.
  const subAgents = new SubAgentWatcherManager((sessionId, map) =>
    sendToMainWindow('session:sub-agents', { sessionId, subAgents: map }),
  )
  const screens = new LatestSessionIpcCoalescer(payload =>
    sendToMainWindow('session:screen', payload),
  )
  const processStates = new LatestSessionIpcCoalescer(payload =>
    sendToMainWindow('session:process-state', payload),
  )
  const semanticEvents = new SemanticEventIpcCoalescer(
    payload => sendToMainWindow('session:semantic-event', payload),
    undefined,
    sessionId => {
      // See SemanticEventIpcCoalescer.beforeBarrier. These are full snapshots / committed entries,
      // so flushing them cannot lose information and prevents an older delayed value from landing
      // after turn_completed or another structural semantic boundary.
      screens.flush(sessionId)
      processStates.flush(sessionId)
      flushJsonl(sessionId)
    },
  )

  manager.on('started', payload => sendToMainWindow('session:started', payload))
  // WHY screen/process-state do not cross IPC directly: both are complete,
  // authoritative snapshots. During a nine-agent burst the old path cloned and
  // dispatched every intermediate repaint even though the next snapshot made
  // it obsolete. Latest-per-session delivery is lossless at the state level
  // and keeps Chromium's queue bounded independently of producer cadence.
  manager.on('screen', payload => screens.enqueue(payload))

  // Bulk-only forwarding. See jsonlCoalescer.ts for the full rationale
  // — every jsonl-entry goes through the coalescer; live single
  // entries become 1-element bulk messages with imperceptible latency.
  manager.on('jsonl-entry', payload => {
    // Committed transcript state must not overtake an earlier cumulative semantic preview still
    // sitting in main's 100 ms window. The renderer's JSONL barrier can only flush messages it has
    // received, so main must establish this order before crossing Electron IPC.
    semanticEvents.flush(payload.sessionId)
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
  manager.on('process-state', payload => processStates.enqueue(payload))
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
  manager.on('semantic-event', payload => semanticEvents.enqueue(payload))
  manager.on('removed', payload => {
    // Final cleanup is keyed to removal, not renderer-facing exit. Some provider
    // stop() paths resolve without emitting exit, and SessionManager.kill() must
    // still be authoritative over the JSONL coalescer buffer and subagent
    // watchers. Natural exits emit `removed` before `exit`, preserving the old
    // ordering where the final bulk JSONL flush reaches the renderer before the
    // pane is marked exited.
    // A structural session removal is an ordering barrier just like turn_completed. Flush every
    // pending cumulative delta before the renderer learns that a runtime disappeared; otherwise a
    // final assistant/tool prefix can be stranded behind teardown and never become visible.
    semanticEvents.flush(payload.sessionId)
    screens.flush(payload.sessionId)
    processStates.flush(payload.sessionId)
    flushAndDropJsonl(payload.sessionId)
    subAgents.stop(payload.sessionId)
  })
  manager.on('exit', payload => {
    sendToMainWindow('session:exit', payload)
  })
  lspManager.on('diagnostics', payload => sendToMainWindow('lsp:diagnostics', payload))

  return {
    flush(): void {
      semanticEvents.flush()
      screens.flush()
      processStates.flush()
      flushAllJsonl()
    },
  }
}
