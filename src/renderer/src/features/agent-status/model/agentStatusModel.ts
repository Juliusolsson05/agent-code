import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { normalizeSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import {
  buildVisibleDispatchRows,
  isPinned,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type {
  SessionId,
  SessionKind,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { displayedWorktreeContext } from '@renderer/workspace/tile-tree/TileLeaf/displayedWorktree'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { conditionStateByKind } from '@shared/types/providerConditions'
import type { ClaudeCompactionState } from '@shared/types/providerConditions'

export type AgentStatusKind = SessionKind

export type AgentStatusModel = {
  sessionId: SessionId
  kind: AgentStatusKind
  title: string
  cwd: string
  /** The worktree the badge shows (displayedWorktreeContext), so the badge's
   *  hover-only details are reachable from the keyboard here (K2-13). */
  worktree: { branch: string | null; path: string; active: boolean } | null
  providerSessionId: string | null
  providerSessionState: 'present' | 'none'
  runtime: {
    sessionStatus: string
    sessionStatusSource: string
    processStatus: string
    transcriptStatus: string
    activityStatus: string | null
    streamPhase: string
    pendingCompaction: string | null
    processError: string | null
    transcriptError: string | null
  }
  placement: {
    /**
     * Where the agent is, in stage terms (#992):
     *   'pinned'  — in the Pinned section of every index;
     *   'pool'    — an ordinary row of its project's index;
     *   'unknown' — no row lists it (its project is gone, or it is mid-spawn).
     * Until the unified layout this was 'grid' | 'detached-dispatch' |
     * 'pinned-dispatch' with a separate `physical: 'grid' | 'detached'` — which
     * of v2's owner structures held the session. There is one owner now, so
     * that axis is gone and the useful one took its place: `lanes`.
     */
    bucket: 'pool' | 'pinned' | 'unknown'
    /** Flat, row-major indices of every lane showing this agent. Empty means
     *  parked: alive in the pool, on no lane. */
    lanes: number[]
    dispatchLabel: string | null
    tabId: TabId | null
    tabTitle: string | null
    tabIndex: number | null
    activeTab: boolean
    focused: boolean
    pinned: boolean
  }
  relationships: {
    linkedParentId: SessionId | null
    orchestrationParentId: SessionId | null
    orchestrationRootId: SessionId | null
    orchestrationRunId: string | null
    orchestrationRole: string | null
  }
  mcp: {
    builtInDomains: string[]
  }
}

export function buildAgentStatusModel(
  state: WorkspaceState,
  runtime: SessionRuntime,
  sessionId: SessionId,
): AgentStatusModel | null {
  const meta = state.sessions[sessionId]
  if (!meta) return null
  const kind = meta.kind ?? DEFAULT_PROVIDER

  const placement = derivePlacement(state, sessionId)
  const providerSessionId = normalizeOptionalString(meta.providerSessionId)
  const domains = normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains) ?? []
  // Provider capability lookups throw for 'terminal' (it is not a registry
  // kind); a shell has no provider conditions to normalize anyway.
  const normalizeConditions = isAgentProviderKind(kind)
    ? getRendererProviderCapabilities(kind).normalizeConditions
    : undefined
  const conditions = normalizeConditions
    ? normalizeConditions({
        snapshot: runtime.conditions,
        currentTurn: runtime.semantic.currentTurn,
        entries: runtime.entries,
      })
    : runtime.conditions
  const compaction = conditionStateByKind<ClaudeCompactionState>(
    conditions,
    'claude.compaction',
  )

  return {
    sessionId,
    kind,
    title: sessionDisplayTitle(meta),
    cwd: meta.cwd,
    worktree: (() => {
      const context = displayedWorktreeContext(runtime.workContext, runtime.workActivity)
      if (!context?.worktreePath) return null
      return {
        branch: context.branch ?? null,
        path: context.worktreePath,
        active: runtime.workActivity?.active?.worktreePath === context.worktreePath,
      }
    })(),
    providerSessionId,
    providerSessionState: providerSessionId ? 'present' : 'none',
    runtime: {
      sessionStatus: runtime.sessionStatus,
      sessionStatusSource: runtime.sessionStatusSource,
      processStatus: runtime.processStatus,
      transcriptStatus: runtime.transcriptStatus,
      activityStatus: normalizeOptionalString(runtime.activityStatus),
      streamPhase: runtime.streamPhase,
      pendingCompaction: compaction?.visible && compaction.phase !== 'done'
        ? compaction.statusText ?? compaction.phase ?? null
        : null,
      processError: normalizeOptionalString(runtime.processError),
      transcriptError: normalizeOptionalString(runtime.transcriptError),
    },
    placement,
    relationships: {
      linkedParentId: meta.linkedParentId ?? null,
      orchestrationParentId: meta.orchestrationParentId ?? null,
      orchestrationRootId: meta.orchestrationRootId ?? null,
      orchestrationRunId: meta.orchestrationRunId ?? null,
      orchestrationRole: meta.orchestrationRole ?? null,
    },
    mcp: {
      builtInDomains: domains,
    },
  }
}

function derivePlacement(
  state: WorkspaceState,
  sessionId: SessionId,
): AgentStatusModel['placement'] {
  const pinned = isPinned(state, sessionId)
  const row = buildVisibleDispatchRows(state).find(item => item.sessionId === sessionId) ?? null
  const commandTargetId = commandTargetSessionIdForState(state)
  const lanes = state.stage.lanes.flatMap((lane, index) =>
    lane.selectedSessionId === sessionId ? [index] : [])

  // The index row is the whole answer: it already carries the project the
  // session is filed under, and a session with no row is one nothing can show.
  //
  // Until #992 two fallbacks followed — a scan of every tab's tile tree, and a
  // scan of the detached bucket — for sessions the row selector did not list,
  // and the result distinguished 'grid' from 'detached' placement. Both scans
  // read structures that no longer exist, and every owned session now has a
  // row, so they could only ever have found nothing.
  if (row) {
    return {
      bucket: pinned ? 'pinned' : 'pool',
      lanes,
      dispatchLabel: row.label,
      tabId: row.tabId,
      tabTitle: row.tabTitle,
      tabIndex: row.tabIndex,
      activeTab: row.tabId === state.activeTabId,
      focused: commandTargetId === sessionId,
      pinned,
    }
  }

  return {
    bucket: pinned ? 'pinned' : 'unknown',
    lanes,
    dispatchLabel: null,
    tabId: null,
    tabTitle: null,
    tabIndex: null,
    activeTab: false,
    focused: commandTargetId === sessionId,
    pinned,
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
