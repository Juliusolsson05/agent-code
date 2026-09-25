// Which transcript fault a live-channel diagnostic proves has RECOVERED.
//
// Two terminal-runtime providers raise a fault on the transcript error
// channel when their live channel has not come up yet, and later report
// through the transcript-diagnostic channel that it did:
//   - Pi: the bridge extension was unreachable (`(provider_bridge_unreachable)`);
//   - OpenCode Terminal: the TUI's server never answered
//     (`(provider_server_unreachable)`, #881), when it was merely late.
// A `connected: true` live-state for that provider clears exactly that fault
// and nothing else — any other transcript error is somebody else's to clear.
//
// WHY shared (#1177): the desktop hub applied this rule inline, and the phone
// store never subscribed to the diagnostic channel at all, so a Pi or
// OpenCode Terminal session that recovered kept showing the failure (and
// its reload advice) on the phone forever. Both now ask this function.

export const PI_BRIDGE_UNREACHABLE = '(provider_bridge_unreachable)'
export const OPENCODE_SERVER_UNREACHABLE = '(provider_server_unreachable)'

/** The fault marker this diagnostic proves recovered, or null. */
export function faultRecoveredByDiagnostic(diagnostic: unknown): string | null {
  const live = diagnostic as { kind?: unknown; connected?: unknown } | null
  if (live?.connected !== true) return null
  if (live.kind === 'pi-terminal-live-state') return PI_BRIDGE_UNREACHABLE
  if (live.kind === 'opencode-terminal-live-state') return OPENCODE_SERVER_UNREACHABLE
  return null
}
