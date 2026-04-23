import type { SessionKind } from '@renderer/workspace/types'

// Normalize spawn errors so the user-facing toast/showToast has a
// single string to print. When the Claude proxy startup path is the
// source, rewrite the error to actionable text — the raw mitmproxy
// error is useless to an end user and the real fix (turn proxy off
// or rebuild) is what the message should say.

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
    return 'Claude proxy startup failed. Disable Proxy Streaming in settings or restart the app after rebuilding.'
  }
  return raw
}
