import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { SessionInfo } from '@shared/types/session'

export type ResumeSessionTarget = {
  cwd: string
  provider: AgentProviderKind
}

type SessionLister = (
  cwd: string,
  limit: number,
  provider: AgentProviderKind,
) => Promise<SessionInfo[]>

const LOAD_FAILURE_MESSAGE = 'Unable to load saved sessions. Check the app log and try again.'

/**
 * Own one coherent resume-list request and the target that produced it.
 *
 * WHY target is state rather than a fresh derivation from workspace focus:
 * restart hydration can change Dispatch/grid focus while the disk walk is in
 * flight. If list rows use the old request but preview/resume use the new focus,
 * the user can see one provider's session and launch it as another provider.
 * The request generation also prevents a slower obsolete empty result from
 * replacing a newer successful Codex list—the complaint captured exactly that
 * indistinguishable "No matching sessions" outcome.
 */
export function useResumeSessionListing(
  listSessions: SessionLister = window.api.listSessionsForCwd,
): {
  target: ResumeSessionTarget | null
  sessions: SessionInfo[]
  loading: boolean
  error: string | null
  load: (target: ResumeSessionTarget) => Promise<void>
} {
  const requestVersion = useRef(0)
  const [target, setTarget] = useState<ResumeSessionTarget | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => {
    // WHY invalidate on unmount: the IPC call cannot be cancelled, but it also
    // must not write into a palette instance that has already been dismissed.
    requestVersion.current += 1
  }, [])

  const load = useCallback(async (nextTarget: ResumeSessionTarget): Promise<void> => {
    const request = ++requestVersion.current
    setTarget(nextTarget)
    setSessions([])
    setError(null)
    setLoading(true)
    try {
      const listed = await listSessions(nextTarget.cwd, 20, nextTarget.provider)
      if (request !== requestVersion.current) return
      setSessions(listed)
    } catch {
      if (request !== requestVersion.current) return
      setSessions([])
      setError(LOAD_FAILURE_MESSAGE)
    } finally {
      if (request === requestVersion.current) setLoading(false)
    }
  }, [listSessions])

  return { target, sessions, loading, error, load }
}
