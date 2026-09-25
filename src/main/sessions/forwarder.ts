import type { SessionManager } from '@main/sessionManager.js'
import { aliasScreenSnapshotForWire } from '@shared/types/session.js'
import type { AgentScreenSnapshot } from '@shared/types/session.js'
import type { LspManager } from '@main/lspManager.js'
import { USER_MCP_UNAVAILABLE_CHANNEL } from '@main/ipc/userMcp.js'
import type { UserMcpUnavailableEvent } from '@shared/userMcp/types.js'
import {
  MANAGED_SKILLS_UNAVAILABLE_CHANNEL,
  type ManagedSkillsUnavailableEvent,
} from '@shared/types/tldr.js'

import {
  broadcastToWindows,
  sendToSessionWindow,
} from '@main/window/windowRegistry.js'
import { SessionFeedTap } from '@main/sessions/sessionFeedTap.js'

// Session event forwarder — the desktop WINDOW SINK over the SessionFeedTap.
//
// Since #1177 this file owns no ordering at all. Every coalescer, every
// ordering barrier, the JSONL burst buffer and the sub-agent watcher live in
// sessionFeedTap.ts, which the phone's SessionFeedSource consumes too; read
// that file for WHY each barrier exists. What remains here is only what is
// genuinely about Electron windows:
//
//   1. Routing. Each payload carries the sessionId, which is load-bearing
//      twice over: main routes the message to the window that owns the
//      session, and that window's renderer then routes it to the right tile.
//      WHY routing matters beyond tidiness: without it every window would
//      decode the full firehose of every other window's agents, and — worse —
//      each session handler in useIpcSubscriptions materializes
//      `emptyRuntime()` for an unrecognized id, so a misrouted event grows a
//      ghost runtime rather than being ignored.
//   2. The IPC channel names (`session:<tap channel>`).
//   3. The screen alias (#746), an IPC-edge byte optimisation.
//   4. Broadcast-only events that are machine-wide rather than per session.
//
// terminal-data and agent-pty-data are intentionally separate channels from
// screen / jsonl-entries. terminal-data is for plain shell panes;
// agent-pty-data is an opt-in inline terminal for Claude/Codex panes. Keeping
// both out of the normal structured feed path prevents every agent pane
// listener from unpacking and ignoring raw PTY bytes. This sink is the one
// that subscribes to them (`rawPty: true`); the remote sink does not.

export type SessionForwarderControl = {
  flush(): void
  flushSession(sessionId: string): void
}

/**
 * @param tap The shared tap. Production passes the one instance main/index.ts
 *   also hands the remote subsystem, so there is one sub-agent watcher and one
 *   ordering decision per event. The default (a private tap) exists for the
 *   test harnesses that wire a forwarder over a throwaway manager — they have
 *   no second sink, so a private tap is exactly the old behaviour.
 */
export function wireSessionForwarder(
  manager: SessionManager,
  lspManager: LspManager,
  tap: SessionFeedTap = new SessionFeedTap(manager),
): SessionForwarderControl {
  tap.addSink((channel, payload) => {
    // `removed` is a cleanup signal the tap needed for its own buffers; the
    // desktop learns removal from workspace state, and never had an IPC
    // channel for it.
    if (channel === 'removed') return
    if (channel === 'screen') {
      // WHY the alias happens here and not in the tap or the manager (#746):
      // the remote server and the recorder-independent readers take the full
      // payload; only the renderer IPC edge pays structured-clone bytes for
      // the duplicate `recent` strings, and only the preload expands them
      // back. (The session recorder taps this send, so recordings carry the
      // wire form; replay treats screen frames as no-op ticks and never reads
      // the fields.)
      sendToSessionWindow(
        payload.sessionId,
        'session:screen',
        aliasScreenSnapshotForWire(payload as { sessionId: string } & AgentScreenSnapshot),
      )
      return
    }
    sendToSessionWindow(payload.sessionId, `session:${channel}`, payload)
  }, { rawPty: true })

  // #1133. BROADCAST, not sendToSessionWindow, on purpose. Managed-skill health
  // is machine-wide (one broken TLDR skill affects every window's next launch),
  // so the warning is not about one pane. Session routing would also be wrong
  // mechanically: it quarantines events for ids no window has claimed yet and
  // records a routing gap for them, so a main-initiated spawn would raise a
  // false "missed session events" notice instead of this warning. Only domain
  // names cross, never the reconcile error (see runPreSpawnSkillReconcile).
  // Not a tap channel: it is not session-scoped and the phone has no surface
  // for it.
  manager.on('managed-skills-unavailable', ({ skills }) => {
    const event: ManagedSkillsUnavailableEvent = { skills }
    broadcastToWindows(MANAGED_SKILLS_UNAVAILABLE_CHANNEL, event)
  })
  // #1143. Broadcast for the same routing reason as managed skills above: the
  // launch can be main-initiated (orchestration child, restore) before any
  // window has claimed the id. Only server names and fixed reason strings
  // cross; nothing here can carry a secret value.
  manager.on('user-mcp-unavailable', ({ servers }) => {
    const event: UserMcpUnavailableEvent = { servers }
    broadcastToWindows(USER_MCP_UNAVAILABLE_CHANNEL, event)
  })
  // Diagnostics are keyed by file, not by session: two windows can have the
  // same file open in their editors and both need them.
  lspManager.on('diagnostics', payload => broadcastToWindows('lsp:diagnostics', payload))

  return {
    flushSession: sessionId => tap.flushSession(sessionId),
    flush: () => tap.flush(),
  }
}
