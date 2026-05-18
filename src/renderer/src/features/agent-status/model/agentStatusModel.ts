import { normalizeSessionBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import {
  buildVisibleDispatchRows,
  isPinned,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'
import type {
  SessionId,
  SessionKind,
  TabId,
  WorkspaceState,
} from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

export type AgentStatusKind = Extract<SessionKind, 'claude' | 'codex'>

export type AgentStatusModel = {
  sessionId: SessionId
  kind: AgentStatusKind
  title: string
  cwd: string
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
    bucket: 'grid' | 'detached-dispatch' | 'pinned-dispatch' | 'unknown'
    physical: 'grid' | 'detached' | 'unknown'
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
  const kind = meta.kind ?? 'claude'
  if (!isAgentKind(kind)) return null

  const placement = derivePlacement(state, sessionId)
  const providerSessionId = normalizeOptionalString(meta.providerSessionId)
  const domains = normalizeSessionBuiltInMcpDomains(meta.builtInMcpDomains) ?? []

  return {
    sessionId,
    kind,
    title: meta.title?.trim() || basename(meta.cwd),
    cwd: meta.cwd,
    providerSessionId,
    providerSessionState: providerSessionId ? 'present' : 'none',
    runtime: {
      sessionStatus: runtime.sessionStatus,
      sessionStatusSource: runtime.sessionStatusSource,
      processStatus: runtime.processStatus,
      transcriptStatus: runtime.transcriptStatus,
      activityStatus: normalizeOptionalString(runtime.activityStatus),
      streamPhase: runtime.streamPhase,
      pendingCompaction: runtime.pendingCompaction
        ? runtime.pendingCompaction.statusText ?? runtime.pendingCompaction.phase
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
  const activeTabId = state.activeTabId

  if (row) {
    const physical = row.placement === 'detached' ? 'detached' : 'grid'
    return {
      bucket: pinned
        ? 'pinned-dispatch'
        : physical === 'detached'
          ? 'detached-dispatch'
          : 'grid',
      physical,
      dispatchLabel: row.label,
      tabId: row.tabId,
      tabTitle: row.tabTitle,
      tabIndex: row.tabIndex,
      activeTab: row.tabId === activeTabId,
      focused: commandTargetId === sessionId,
      pinned,
    }
  }

  const gridOwner = findGridOwner(state, sessionId)
  if (gridOwner) {
    return {
      bucket: pinned ? 'pinned-dispatch' : 'grid',
      physical: 'grid',
      dispatchLabel: null,
      tabId: gridOwner.id,
      tabTitle: gridOwner.title,
      tabIndex: gridOwner.index,
      activeTab: gridOwner.id === activeTabId,
      focused: commandTargetId === sessionId,
      pinned,
    }
  }

  // WHY this fallback is intentionally narrow:
  // `Show Agent Status` is command-target driven, so normal callers should
  // arrive here only for a visible grid or Dispatch row. We still surface
  // detached ownership when the model is used in tests or future inspectors,
  // but we do not walk `state.buried` or invent hidden-session UI in v1. Buried
  // panes are not command targets; showing them here would quietly broaden this
  // feature into a workspace debugger instead of the compact focused-agent
  // status view requested in #209.
  const detached = Object.values(state.detachedSessions)
    .find(entry => entry.sessionId === sessionId) ?? null
  if (detached) {
    return {
      bucket: pinned ? 'pinned-dispatch' : 'detached-dispatch',
      physical: 'detached',
      dispatchLabel: null,
      tabId: detached.projectTabId,
      tabTitle: detached.projectTabTitle,
      tabIndex: detached.projectTabIndex,
      activeTab: detached.projectTabId === activeTabId,
      focused: commandTargetId === sessionId,
      pinned,
    }
  }

  return {
    bucket: pinned ? 'pinned-dispatch' : 'unknown',
    physical: 'unknown',
    dispatchLabel: null,
    tabId: null,
    tabTitle: null,
    tabIndex: null,
    activeTab: false,
    focused: commandTargetId === sessionId,
    pinned,
  }
}

function findGridOwner(
  state: WorkspaceState,
  sessionId: SessionId,
): { id: TabId; title: string; index: number } | null {
  // WHY this scans tile leaves directly instead of `resolveTabSessions`:
  // status placement needs to distinguish physical grid placement from
  // detached Dispatch ownership. `resolveTabSessions` deliberately returns the
  // union of both buckets for membership questions, which would erase the
  // difference this panel exists to explain. Keeping this scan private to the
  // status model, after trying the Dispatch row selector first, prevents each
  // UI surface from re-learning the grid-vs-detached split independently.
  for (let index = 0; index < state.tabs.length; index += 1) {
    const tab = state.tabs[index]
    if (!tab) continue
    if (collectLeaves(tab.root).includes(sessionId)) {
      return { id: tab.id, title: tab.title, index }
    }
  }
  return null
}

function isAgentKind(kind: SessionKind): kind is AgentStatusKind {
  return kind === 'claude' || kind === 'codex'
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}
