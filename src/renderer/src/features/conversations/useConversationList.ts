import { useCallback, useEffect, useRef, useState } from 'react'

import type { ConversationListResponse, ConversationScope } from '@shared/conversations/types'
import type { AgentProviderKind } from '@shared/types/providerKind'

// One coherent request per filter state, versioned so a slower obsolete
// response can never replace a newer one (the exact race the old resume
// listing hook fixed for #718, kept here in the same shape).
const DEBOUNCE_MS = 120
const PAGE = 60
export const LOAD_FAILURE_MESSAGE = "Could not load conversations. Check the app log and try again."

export type ConversationListParams = {
  open: boolean
  cwd: string | null
  scope: ConversationScope
  providers: AgentProviderKind[]
  includeChildren: boolean
  query: string
}

export function useConversationList(params: ConversationListParams): {
  response: ConversationListResponse | null
  loading: boolean
  error: string | null
  /** No commanded pane and a scope that needs one: nothing was asked, so
   *  the surface must say so instead of "no conversations". */
  needsPane: boolean
  loadMore: () => void
  /** The rows on screen were fetched for OTHER parameters than the current
   *  ones (a query, scope or filter changed and the new page has not
   *  arrived). See the picker's keyboard guard (#1297 review A). */
  stale: boolean
} {
  const version = useRef(0)
  const [response, setResponse] = useState<ConversationListResponse | null>(null)
  // The parameters `response` was fetched for, set with it.
  const [responseKey, setResponseKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { open, cwd, scope, includeChildren, query } = params
  const providersKey = params.providers.join(',')

  // The everywhere scope needs no seed directory; main resolves it from ''.
  const effectiveCwd = cwd ?? (scope === 'everywhere' ? '' : null)
  const needsPane = open && effectiveCwd === null
  const paramsKey = JSON.stringify([effectiveCwd, scope, providersKey, includeChildren, query.trim()])
  const run = useCallback(async (cursor: string | null) => {
    if (!open || effectiveCwd === null) return
    const requestKey = paramsKey
    const request = ++version.current
    setLoading(true)
    setError(null)
    try {
      const next = await window.api.listConversations({
        cwd: effectiveCwd, scope, providers: providersKey ? (providersKey.split(',') as AgentProviderKind[]) : undefined,
        includeChildren, query: query.trim() || undefined, cursor, limit: PAGE,
      })
      if (request !== version.current) return
      setResponse(prev => (cursor && prev ? { ...next, rows: [...prev.rows, ...next.rows] } : next))
      setResponseKey(requestKey)
    } catch {
      if (request !== version.current) return
      // WHY not an empty list: main rejects when a store could not be read,
      // and the surface must say so. An empty list means "read, held
      // nothing", which is a different answer (#718).
      setResponse(null)
      setError(LOAD_FAILURE_MESSAGE)
    } finally {
      if (request === version.current) setLoading(false)
    }
  }, [open, effectiveCwd, scope, providersKey, includeChildren, query, paramsKey])

  const hasResponse = useRef(false)
  hasResponse.current = response !== null
  useEffect(() => {
    if (!open) {
      version.current += 1
      setResponse(null)
      setError(null)
      return
    }
    // The first paint of an open picker should not wait for the debounce;
    // only subsequent keystrokes and filter flips are coalesced.
    const timer = setTimeout(() => { void run(null) }, hasResponse.current ? DEBOUNCE_MS : 0)
    return () => clearTimeout(timer)
  }, [open, run])

  const stale = response !== null && responseKey !== paramsKey
  const loadMore = useCallback(() => {
    // Never page rows fetched for OTHER parameters (#1297 round 2): the old
    // cursor with the new scope appended new-scope rows to old ones and then
    // labelled the mix as the new scope, so `stale` cleared and Enter could
    // resume an out-of-scope row. The new first page is on its way anyway.
    if (stale) return
    if (response?.nextCursor && !loading) void run(response.nextCursor)
  }, [response, loading, run, stale])

  return { response, loading, error, needsPane, loadMore, stale }
}
