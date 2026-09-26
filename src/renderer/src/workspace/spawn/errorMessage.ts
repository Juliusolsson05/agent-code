import type { SessionKind } from '@renderer/workspace/types'
import { MISSING_WORKSPACE_FOLDER_PREFIX, PROVIDER_CLI_NOT_FOUND_SUFFIX, SESSION_START_FAILED_MESSAGE } from '@shared/types/session'
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind'

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
const PROXY_STARTUP_FAILED_MESSAGE = 'Claude proxy startup failed. Restart Agent Code after rebuilding, or disable Proxy-Streamed Semantic Rendering in settings if the proxy will not start in this environment.'

/**
 * The spawn failures whose text is safe to show AND tells the user what to
 * do, or null for everything else (#1286 review C). Exactly three, and the
 * returned text is ALWAYS rebuilt from our own constants, never copied from
 * the error (#1286 review C round 2):
 *  - the Claude proxy rewrite above (this file);
 *  - main's MissingWorkspaceDirectoryError. The folder named is `cwd`, the
 *    folder this renderer asked to spawn in. The error's tail was once
 *    returned instead, and a provider exception that happened to contain the
 *    prefix followed by a URL or token passed it straight to a toast;
 *  - main's ProviderCliNotFoundError, only for a known provider id (an
 *    arbitrary lowercase token before the suffix is not a kind).
 * Recognised on both sides of `spawn`: sessionSpawnErrorMessage maps a raw
 * rejection onto one of these, and a create's toast re-reads the message
 * `spawn` threw. That second read is why the proxy sentence is recognised by
 * its own text: its raw needles are gone by then.
 */
export function curatedSpawnMessage(raw: string, cwd: string): string | null {
  if (raw.includes(PROXY_STARTUP_FAILED_MESSAGE)) return PROXY_STARTUP_FAILED_MESSAGE
  if (raw.includes(MISSING_WORKSPACE_FOLDER_PREFIX)) return `${MISSING_WORKSPACE_FOLDER_PREFIX}${cwd}`
  const cli = raw.indexOf(PROVIDER_CLI_NOT_FOUND_SUFFIX)
  if (cli >= 0) {
    const kind = /[a-z][a-z0-9-]*$/u.exec(raw.slice(0, cli))?.[0]
    if (kind && (AGENT_PROVIDER_KINDS as readonly string[]).includes(kind)) return `${kind}${PROVIDER_CLI_NOT_FOUND_SUFFIX}`
  }
  return null
}

export function sessionSpawnErrorMessage(
  kind: SessionKind,
  err: unknown,
  useProxy: boolean,
  /** The folder spawn was asked to use; the only folder a message may name. */
  cwd: string,
): string {
  const raw =
    err instanceof Error && err.message.length > 0
      ? err.message
      : String(err || `Could not start ${kind}.`)
  if (
    kind === 'claude' &&
    useProxy &&
    (
      raw.includes('Timed out waiting for mitmproxy') ||
      raw.includes('Unable to locate mitm') ||
      raw.includes('mitmdump')
    )
  ) {
    return PROXY_STARTUP_FAILED_MESSAGE
  }
  // Main's curated, actionable start failures (missing folder, missing CLI).
  const curated = curatedSpawnMessage(raw, cwd)
  if (curated) return curated
  // Everything else is the raw provider exception relayed through IPC, which
  // can carry environment values, proxy URLs or scoped MCP tokens (steering
  // q22). This string reaches newTab, reload, provider-switch, rewind and
  // capability-reload toasts and the orchestration tool error (#1286 review
  // B), so it is flattened HERE, once, instead of at each of them. Main
  // journals the raw error before it rethrows.
  return SESSION_START_FAILED_MESSAGE
}
