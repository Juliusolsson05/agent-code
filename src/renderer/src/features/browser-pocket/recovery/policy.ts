import { isLoopbackUrl } from '@shared/browserPocket/url'
import type { LanePort } from '@shared/browserPocket/types'
import { isAgentSessionKind } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/hook'
import type { SessionId } from '@renderer/workspace/types'
import type { PocketLive } from '../state/pocketLiveStore'

export type LoadFailure = NonNullable<PocketLive['failed']>

// Chromium net/base/net_error_list.h is the source of these stable codes:
// https://github.com/chromium/chromium/blob/main/net/base/net_error_list.h
// Certificate, DNS, policy and renderer-crash failures do not establish that
// restarting a development server would help. Keep this allowlist narrow;
// errorDescription is display data, never a signal to execute an agent task.
const CONNECTION_ERRORS: Record<string, string> = {
  '-7': 'ERR_TIMED_OUT',
  '-100': 'ERR_CONNECTION_CLOSED',
  '-101': 'ERR_CONNECTION_RESET',
  '-102': 'ERR_CONNECTION_REFUSED',
  '-104': 'ERR_CONNECTION_FAILED',
  '-118': 'ERR_CONNECTION_TIMED_OUT',
}

export function canRequestRestart(failure: LoadFailure | null): boolean {
  return Boolean(failure && Object.prototype.hasOwnProperty.call(CONNECTION_ERRORS, failure.code) && isLoopbackUrl(failure.url))
}

export function restartOwner(workspace: Pick<Workspace, 'state' | 'runtimes'>, sessionId: SessionId, pocketId: string) {
  const meta = workspace.state.sessions[sessionId]
  if (!meta || !isAgentSessionKind(meta.kind ?? 'claude') || meta.browserPocket?.pocketId !== pocketId) return null
  const runtime = workspace.runtimes[sessionId]
  const worktree = runtime?.workContext?.worktreePath ?? runtime?.projectDir ?? meta.cwd
  if (!worktree) return null
  // Metadata objects can change during an ordinary wake. Compare the actual
  // ownership facts, not object identity, and never follow a renamed lane.
  const identity = JSON.stringify([sessionId, pocketId, meta.kind ?? 'claude', meta.providerRuntime ?? null, meta.projectId ?? null, meta.cwd, worktree])
  return { identity, worktree }
}

export function restartContext(failure: LoadFailure, worktree: string, ports: LanePort[]) {
  const url = new URL(failure.url)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  // A port can be shared across IPv4/IPv6 or projects. Only a single current
  // exact-origin observation is useful; absence must never block recovery of
  // a dead server. Nothing here claims a terminal or process is exclusively ours.
  const pids = new Set(ports.filter(p => {
    try { return p.port === port && new URL(p.url).origin === url.origin } catch { return false }
  }).map(p => p.pid))
  return {
    origin: url.origin, port, worktree,
    connectionError: CONNECTION_ERRORS[failure.code],
    ...(pids.size === 1 ? { observedPid: [...pids][0] } : {}),
  }
}
