import type { SessionKind } from '@renderer/workspace/types'

// Normalize spawn errors so the user-facing toast/showToast has a
// single string to print. When the Claude proxy startup path is the
// source, rewrite the error to actionable text.
//
// WHY the message lists both restart AND the settings toggle:
//
// Proxy Streaming is still an exposed setting (settingsRegistry.ts:
// "Proxy-Streamed Semantic Rendering"), so a user staring at this
// toast does in fact have a working escape hatch — they can disable
// the streaming pipeline and fall back to non-semantic rendering.
// An earlier draft of this message removed the settings hint because
// the runtime team intends proxy streaming to become non-optional,
// but until the setting is actually removed from the UI it would be
// misleading to hide the only fix path the user can act on right now.
// Order matters: restart first because the packaged-app case is
// usually a transient mitmproxy startup race that goes away on
// relaunch; disabling is the durable fallback for environments
// where the proxy can't run at all.
export function sessionSpawnErrorMessage(
  kind: SessionKind,
  err: unknown,
  useProxy: boolean,
): string {
  const raw =
    err instanceof Error && err.message.length > 0
      ? err.message
      : String(err || `Failed to start ${kind}`)
  if (
    kind === 'claude' &&
    useProxy &&
    (
      raw.includes('Timed out waiting for mitmproxy') ||
      raw.includes('Unable to locate mitm') ||
      raw.includes('mitmdump')
    )
  ) {
    return 'Claude proxy startup failed. Restart Agent Code after rebuilding, or disable Proxy-Streamed Semantic Rendering in settings if the proxy will not start in this environment.'
  }
  return raw
}
