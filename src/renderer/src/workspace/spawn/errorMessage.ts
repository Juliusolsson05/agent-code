import type { SessionKind } from '@renderer/workspace/types'

// Normalize spawn errors so the user-facing toast/showToast has a
// single string to print. When the Claude proxy startup path is the
// source, rewrite the error to actionable text. Proxy is not an optional
// escape hatch in Agent Code's normal workflow anymore, so this message must
// point at diagnostics/rebuild instead of teaching users to bypass the one
// transport path that gives us semantic events.

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
    return 'Claude proxy startup failed. Restart the app after rebuilding and check the proxy startup diagnostics.'
  }
  return raw
}
