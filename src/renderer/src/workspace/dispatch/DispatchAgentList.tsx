import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import { extractLatestUserPrompt } from '@renderer/features/workspace/lib/latestUserPrompts'
import {
  buildDispatchGroups,
  type DispatchAgentRow,
} from '@renderer/workspace/dispatch/dispatchSelectors'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import type { SessionId, SessionKind, TabId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'

// WHY this module exists separately from DispatchLayout:
// The full Dispatch index list (sections, pinned group, activity-colored
// rows, scroll-into-view) used to live privately inside DispatchLayout.tsx.
// Tiled Dispatch (issue #248) needs the exact same index as its lane-0
// surface, so the list — and the activity/title helpers it depends on —
// were extracted here so both the classic and tiled layouts render an
// identical index. This is a pure move: behavior is unchanged.

export type DispatchAgentActivity = 'working' | 'running' | 'idle' | 'exited' | 'starting'

const latestPromptTitleCache = new WeakMap<
  Entry[],
  { kind: DispatchAgentRow['kind']; title: string | null }
>()

export const DispatchAgentList = memo(function DispatchAgentList({
  groups,
  pinnedRows,
  activeSessionId,
  dispatchScope,
  focusSessionInTab,
  showWorktreeBadges,
  disabledSessionIds,
}: {
  groups: ReturnType<typeof buildDispatchGroups>
  pinnedRows: DispatchAgentRow[]
  activeSessionId: string | null
  dispatchScope: 'global' | 'project'
  focusSessionInTab: Workspace['focusSessionInTab']
  showWorktreeBadges: boolean
  // Sessions that must render as unselectable in this index. Used by Tiled
  // Dispatch's lane-0 index to grey out agents already shown in another lane
  // (the one-session-per-lane invariant — without this, clicking a claimed
  // agent looks selectable but silently no-ops in setTiledLaneSession).
  // Undefined/absent in classic Dispatch, so its rows stay fully clickable.
  disabledSessionIds?: Set<SessionId>
}) {
  const listRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !activeSessionId) return
    const activeRow = list.querySelector<HTMLElement>('[data-dispatch-active="true"]')
    if (!activeRow) return

    // WHY not rely on row.scrollIntoView(): Dispatch's list is a nested
    // overflow region with a sticky header, and `scrollIntoView({nearest})`
    // lets the browser pick the scroll ancestor and final alignment. In
    // practice Option+Arrow could move workspace focus while the highlighted
    // row drifted beyond the list viewport. The list container is the source
    // of truth for visibility here, so compute against its own rect and move
    // only its scrollTop.
    const listRect = list.getBoundingClientRect()
    const rowRect = activeRow.getBoundingClientRect()
    const header = list.querySelector<HTMLElement>('[data-dispatch-list-header="true"]')
    const topInset = header?.offsetHeight ?? 0
    const visibleTop = listRect.top + topInset
    const visibleBottom = listRect.bottom

    if (rowRect.top < visibleTop) {
      list.scrollTop -= visibleTop - rowRect.top
    } else if (rowRect.bottom > visibleBottom) {
      list.scrollTop += rowRect.bottom - visibleBottom
    }
  }, [activeSessionId, groups, pinnedRows])

  return (
    // WHY h-full w-full instead of `basis-1/4 min-w-[220px]
    // max-w-[420px] border-r`:
    //   The aside used to be the flex child that owned its own
    //   width (basis-1/4 plus a 220..420px clamp) AND drew the
    //   right border between itself and the active-agent pane.
    //   After the splitter rewrite, the wrapping <div> in
    //   DispatchLayout sets the resolved width (style.width =
    //   dispatchListRatio * 100%) and owns the right border —
    //   keeping the basis/max-width here capped the rendered rows
    //   at 420px even when the user dragged the splitter past that
    //   threshold (visible symptom: empty canvas to the right of
    //   the rows with the inner aside's right border floating mid
    //   pane). The ratio clamp in setDispatchListRatio [0.15, 0.5]
    //   is the real bound now; the aside just fills its parent.
    <aside
      ref={listRef}
      className="h-full w-full min-h-0 bg-surface overflow-y-auto [contain:layout_paint]"
    >
      <div
        data-dispatch-list-header="true"
        className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-2.5 py-1.5 text-[10px] text-muted uppercase"
      >
        <span>Sessions</span>
        <span>{dispatchScope}</span>
      </div>
      {/* Pinned section. Rendered above the regular groups and
          always visible — pinned agents are cross-scope by design.
          The chip on each row carries the tab letter + project title
          so a global pin (e.g. ★1 → tab D / "ml-pipeline") stays
          legible while dispatch scope is set to a different project.
          Skip rendering when there are no pins so the regular agent
          groups don't gain an empty section header. */}
      {pinnedRows.length > 0 && (
        <div className="border-b border-border" data-dispatch-pinned-group="true">
          <DispatchGroupHeader title="Pinned" rows={pinnedRows} />
          <div>
            {pinnedRows.map(row => (
              <DispatchAgentListRow
                key={row.key}
                row={row}
                active={row.sessionId === activeSessionId}
                disabled={disabledSessionIds?.has(row.sessionId) ?? false}
                showWorktreeBadges={showWorktreeBadges}
                focusSessionInTab={focusSessionInTab}
                projectChip={`${tabIndexLabel(row.tabIndex)} · ${row.tabTitle}`}
              />
            ))}
          </div>
        </div>
      )}
      {groups.map(group => (
        <div key={group.tab.id} className="border-b border-border">
          <DispatchGroupHeader title={group.tab.title} rows={group.rows} />
          <div>
            {group.rows.map(row => (
              <DispatchAgentListRow
                key={row.key}
                row={row}
                active={row.sessionId === activeSessionId}
                disabled={disabledSessionIds?.has(row.sessionId) ?? false}
                showWorktreeBadges={showWorktreeBadges}
                focusSessionInTab={focusSessionInTab}
              />
            ))}
          </div>
        </div>
      ))}
    </aside>
  )
})

const DispatchGroupHeader = memo(function DispatchGroupHeader({
  title,
  rows,
}: {
  title: string
  rows: DispatchAgentRow[]
}) {
  const sessionIds = useMemo(() => rows.map(row => row.sessionId), [rows])
  const runningCount = useAppStore(useShallow(state => {
    let count = 0
    for (const sessionId of sessionIds) {
      const runtime = state.workspaceRuntimes[sessionId]
      if (runtime?.sessionStatus === 'running' || runtime?.streamPhase !== 'idle') count += 1
    }
    return count
  }))

  return (
    <div className="flex items-center justify-between gap-2 px-2.5 py-1 text-[10px] text-ink bg-canvas">
      <span className="truncate">{title}</span>
      <span className="text-muted tabular-nums">
        {runningCount}/{rows.length}
      </span>
    </div>
  )
})

const DispatchAgentListRow = memo(function DispatchAgentListRow({
  row,
  active,
  disabled = false,
  showWorktreeBadges,
  focusSessionInTab,
  projectChip,
}: {
  row: DispatchAgentRow
  active: boolean
  // When true the row is shown but unselectable (Tiled Dispatch: this agent
  // already occupies another lane). Defaults false so classic Dispatch rows
  // are always clickable.
  disabled?: boolean
  showWorktreeBadges: boolean
  focusSessionInTab: (tabId: TabId, sessionId: SessionId) => void
  // Optional small label (tab letter + project title) shown next to
  // the secondary metadata row. Only pinned rows pass this — regular
  // rows already live under a group header that names the project,
  // so a chip would just duplicate that information.
  projectChip?: string
}) {
  const runtime = useAppStore(useShallow(state => {
    const current = state.workspaceRuntimes[row.sessionId]
    return {
      sessionStatus: current?.sessionStatus,
      streamPhase: current?.streamPhase,
      exited: current?.exited,
      workContext: current?.workContext,
      workActivity: current?.workActivity,
      entries: current?.entries,
      unreadSince: current?.unreadSince,
      unreadKind: current?.unreadKind,
      conditions: current?.conditions,
      processError: current?.processError,
    }
  }))
  const onSelect = useCallback(() => {
    if (disabled) return
    focusSessionInTab(row.tabId, row.sessionId)
  }, [disabled, focusSessionInTab, row.sessionId, row.tabId])
  const isTerminal = row.kind === 'terminal'
  const activity = dispatchActivity(runtime)
  const activityClasses = dispatchActivityClasses(activity, active)
  const subtitle = dispatchSubtitle(runtime, row.kind)
  const title = !isTerminal && runtime.entries
    ? cachedLatestPromptTitle(runtime.entries, row.kind) ?? row.title
    : row.title
  const attentionLabel = dispatchAttentionLabel(runtime)
  const unreadKind = isTerminal
    ? null
    : attentionLabel
      ? 'attention'
      : runtime.unreadKind === 'attention'
        ? 'output'
        : runtime.unreadKind

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={disabled ? 'shown in another lane' : title}
      data-dispatch-active={active ? 'true' : undefined}
      // WHY this marker exists: clicking a Dispatch row lands DOM focus on this
      // <button>, which the bare-Enter composer router (composerEnterRegistry)
      // would otherwise treat as a real action button and bail on (its
      // isInteractiveTarget guard). This data attribute lets that router tell a
      // Dispatch row apart from a genuine action button, so when the active
      // pane has a non-empty submittable draft, Enter is handed to the composer
      // instead of being swallowed as a no-op re-select. See issue #236.
      // One component renders both pinned and grouped rows, so this single
      // marker covers every row in the index.
      data-dispatch-row="true"
      className={`
        relative flex w-full items-stretch text-left pr-2.5 border-t border-border overflow-hidden [contain:layout_paint]
        ${activityClasses.row}
        ${disabled ? 'opacity-40 cursor-not-allowed' : ''}
      `}
    >
      {/* Linked-agent indent. A linked agent (row.depth > 0) renders
          one level in from its parent: a fixed-width connector cell
          with a left rail + a `↳` corner glyph signals "belongs to
          the row above." depth is only ever 0 or 1 (linked agents
          don't chain), so a single cell is enough — no depth
          multiplier needed. */}
      {row.depth > 0 && (
        <span
          className="flex w-5 flex-shrink-0 items-start justify-center border-l border-border pt-1 text-[10px] leading-none text-muted select-none"
          aria-hidden="true"
        >
          ↳
        </span>
      )}
      <span className={`flex w-9 flex-shrink-0 items-center justify-center text-[10px] font-semibold tabular-nums ${activityClasses.index}`}>
        {row.label}
      </span>
      <div className="min-w-0 flex-1 py-1 pl-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="min-w-0 flex-1">
            <span className={`block min-w-0 truncate px-1 py-[1px] text-[11px] text-ink ${activityClasses.title}`}>
              {title}
            </span>
          </span>
          {unreadKind && (
            <DispatchUnreadBadge kind={unreadKind} label={attentionLabel} />
          )}
        </div>
        {/* Row 2 — secondary metadata. Worktree + model are split off the
            title row so the title can use the full row width before
            truncating. The index block owns the activity color now; keeping
            the secondary row visually neutral prevents the whole dispatch
            list from turning into a set of competing colored strips. */}
        <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-[9px] text-muted">
          <span className="truncate flex-shrink min-w-0">{subtitle}</span>
          {showWorktreeBadges && (
            <WorktreeBadge context={runtime?.workContext} activity={runtime?.workActivity} />
          )}
          <DispatchAgentBadge kind={row.kind} />
          {projectChip && (
            <span
              className="
                ml-auto flex-shrink-0 px-1.5 py-[1px] text-[9px] font-code
                leading-none text-muted border border-border bg-surface-hi
                truncate max-w-[140px]
              "
              title={projectChip}
            >
              {projectChip}
            </span>
          )}
        </div>
      </div>
    </button>
  )
})

// Exported for reuse by the Tiled Dispatch mini-list, which renders the
// same prompt-derived title in a more compact row.
export function cachedLatestPromptTitle(
  entries: Entry[],
  kind: DispatchAgentRow['kind'],
): string | null {
  const cached = latestPromptTitleCache.get(entries)
  if (cached && cached.kind === kind) return cached.title

  const title = extractLatestUserPrompt(entries, kind)?.text ?? null
  latestPromptTitleCache.set(entries, { kind, title })
  return title
}

function dispatchSubtitle(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
  unreadSince?: number | null
}, kind?: SessionKind): string {
  // WHY terminals get their own label path:
  // Agent subtitles describe model turn state (`thinking`, `responding`,
  // tool phases). A shell terminal has no transcript turn lifecycle, so
  // showing those same words would imply Claude/Codex semantics that do not
  // exist. Keep the process state visible, but prefix it as shell state so a
  // terminal row is scan-distinct even before the badge is read.
  if (kind === 'terminal') {
    if (runtime.sessionStatus === undefined) return 'shell starting'
    if (runtime.exited !== null && runtime.exited !== undefined) return 'shell exited'
    if (runtime.sessionStatus === 'running') return 'shell running'
    return 'shell idle'
  }
  if (runtime.sessionStatus === undefined) return 'starting'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  if (runtime.exited !== null && runtime.exited !== undefined) return 'exited'
  return 'idle'
}

function dispatchAttentionLabel(runtime: {
  conditions?: ProviderConditionSnapshot | null
  processError?: string | null
}): string | null {
  const conditionLabel = dispatchAttentionLabelFromConditions(runtime.conditions ?? null)
  if (conditionLabel) return conditionLabel
  if (runtime.processError) return 'ERROR'
  return null
}

// Dispatch-local agent badge. Why not reuse AgentTypeBadge from
// SessionBadges? That component is also rendered in pane headers
// (ScrollIndicator) where the longer "Claude Code" reads naturally.
// In the narrow dispatch row we want the shorter "Claude" so the
// badge doesn't crowd the worktree pill on row 2.
function DispatchAgentBadge({ kind }: { kind: SessionKind | undefined }) {
  const label =
    kind === 'codex' ? 'Codex' : kind === 'terminal' ? 'Terminal' : 'Claude'
  const classes = kind === 'terminal'
    ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200'
    : 'border-border bg-surface-hi text-muted'
  return (
    <span className={`flex-shrink-0 px-1.5 py-[1px] text-[9px] font-code leading-none border ${classes}`}>
      {label}
    </span>
  )
}

function DispatchUnreadBadge({
  kind,
  label,
}: {
  kind: 'output' | 'attention'
  label: string | null
}) {
  if (kind === 'attention') {
    return (
      <span
        className="
          flex-shrink-0 rounded-sm border border-amber-300/70 bg-amber-400/20
          px-1.5 py-[1px] text-[9px] font-semibold leading-none text-amber-100
        "
      >
        {label ?? 'ACTION'}
      </span>
    )
  }
  return (
    <span
      className="
        flex-shrink-0 rounded-sm border border-accent/70 bg-accent/20
        px-1.5 py-[1px] text-[9px] font-semibold leading-none text-accent
      "
    >
      NEW
    </span>
  )
}

// Exported for reuse by the Tiled Dispatch mini-list, which shows a
// compact activity dot derived from the same runtime state.
export function dispatchActivity(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
}): DispatchAgentActivity {
  if (runtime.sessionStatus === undefined) return 'starting'
  if (runtime.exited !== null && runtime.exited !== undefined) return 'exited'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return 'working'
  if (runtime.sessionStatus === 'running') return 'running'
  return 'idle'
}

// Exported so the Tiled Dispatch mini-list can render its index chips with
// the exact same activity background + accent-when-selected palette as the
// main index's chip cell — the two surfaces must read identically.
export function dispatchActivityClasses(
  activity: DispatchAgentActivity,
  active: boolean,
): {
  row: string
  index: string
  title: string
} {
  // Dispatch is a dense scanning surface, so full-row status backgrounds
  // make every state compete with the actual content. The index cell is the
  // one stable visual affordance every row already has, which makes it the
  // right place for both active selection and process state. Active wins here
  // because it answers "where am I focused?" while the text metadata still
  // spells out whether the underlying session is running, working, or exited.
  if (active) {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-accent text-accent-fg',
      title: '',
    }
  }
  if (activity === 'working') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-green-600 text-white',
      title: '',
    }
  }
  if (activity === 'running') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-blue-600 text-white',
      title: '',
    }
  }
  if (activity === 'starting') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-orange-500 text-black',
      title: '',
    }
  }
  if (activity === 'exited') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-muted opacity-75',
      index: 'bg-red-700 text-white',
      title: '',
    }
  }
  return {
    row: 'bg-surface hover:bg-surface-hi text-ink-dim',
    index: 'bg-zinc-700 text-zinc-100',
    title: '',
  }
}

// Activity → dot color for the compact mini-list. Mirrors the index-cell
// palette in dispatchActivityClasses so the two surfaces read the same.
export function dispatchActivityDotClass(activity: DispatchAgentActivity): string {
  switch (activity) {
    case 'working':
      return 'bg-green-500'
    case 'running':
      return 'bg-blue-500'
    case 'starting':
      return 'bg-orange-400'
    case 'exited':
      return 'bg-red-600'
    default:
      return 'bg-zinc-500'
  }
}

export function DispatchEmpty({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-[12px] text-muted">
      {message}
    </div>
  )
}
