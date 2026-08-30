import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  DEFAULT_PROVIDER,
  isAgentProviderKind,
} from '@shared/types/providerKind'
import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { WorktreeBadge } from '@renderer/workspace/tile-tree/TileLeaf/SessionBadges'
import { extractLatestUserPrompt } from '@renderer/features/workspace/lib/latestUserPrompts'
import { buildDispatchGroups } from '@renderer/workspace/dispatch/dispatchSelectors'
import type { DispatchAgentRow } from '@renderer/workspace/dispatch/dispatchSelectors'
import { DispatchColorFlagStrip } from '@renderer/workspace/dispatch/DispatchColorFlagStrip'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabels'
import { rowScopedRows } from '@renderer/workspace/dispatch/rowScopedRows'
import type { DispatchGridRow, SessionId, SessionKind, TabId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { dispatchAttentionLabelFromConditions } from '@renderer/workspace/conditions/selectors'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'

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
  onCreateAgentInProject,
  gridRow,
  onToggleExpandedParent,
  onToggleCapChildren,
  onPickRowProject,
}: {
  groups: ReturnType<typeof buildDispatchGroups>
  pinnedRows: DispatchAgentRow[]
  activeSessionId: string | null
  dispatchScope: 'global' | 'project'
  focusSessionInTab: Workspace['focusSessionInTab']
  showWorktreeBadges: boolean
  // Renders a "+" in each project header when supplied. Optional so the
  // Tiled and classic layouts can adopt it independently, and so a caller
  // that has no meaningful create path simply omits it rather than passing a
  // no-op the header would still render a button for.
  onCreateAgentInProject?: (tabId: TabId, anchorSessionId: SessionId) => void
  // Grid Dispatch (#681): the grid row this index belongs to. Supplies the
  // project binding and child density that make one row's list differ from
  // another's over the same workspace. Absent in classic Dispatch, which has
  // no rows and therefore no per-row scoping.
  gridRow?: Pick<DispatchGridRow, 'projectTabId' | 'capChildren' | 'expandedParents'>
  onToggleExpandedParent?: (parentSessionId: SessionId) => void
  onToggleCapChildren?: () => void
  onPickRowProject?: () => void
  // Sessions that must render as unselectable in this index. Used by Tiled
  // Dispatch's lane-0 index to grey out agents already shown in another lane
  // (the one-session-per-lane invariant — without this, clicking a claimed
  // agent looks selectable but silently no-ops in selectTiledLaneSession).
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

  // Row scoping. Absent `gridRow` means classic Dispatch: no binding, no cap,
  // every row through. Applied at RENDER only — it never reaches
  // buildVisibleDispatchRows, so labels, globalIndex, and cmd+N targeting stay
  // computed from the full canonical set and a filtered list shows gaps rather
  // than renumbering.
  const scopedGroups = useMemo(
    () => groups
      .map(group => ({ ...group, items: rowScopedRows(group.rows, gridRow ?? {}) }))
      .filter(group => group.items.length > 0),
    [groups, gridRow],
  )
  const scopedPinnedRows = useMemo(
    () => (gridRow?.projectTabId === undefined
      ? pinnedRows
      : pinnedRows.filter(row => row.tabId === gridRow.projectTabId)),
    [pinnedRows, gridRow],
  )
  const rowProjectLabel = useMemo(
    () => (gridRow?.projectTabId === undefined
      ? null
      : groups.find(group => group.tab.id === gridRow.projectTabId)?.tab.title
        ?? 'Project'),
    [groups, gridRow],
  )

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
        <span className="flex items-center gap-1.5">
          {/* Child-cap toggle. A stable control whose STATE is the glyph, not
              the label — the same rule command titles follow ("Reader Mode",
              never "Toggle Reader Mode"). */}
          {onToggleCapChildren && (
            <button
              type="button"
              onClick={onToggleCapChildren}
              data-dispatch-row="true"
              title={
                gridRow?.capChildren === false
                  ? 'Cap orchestrated agents'
                  : 'Show all orchestrated agents'
              }
              aria-label={
                gridRow?.capChildren === false
                  ? 'Cap orchestrated agents'
                  : 'Show all orchestrated agents'
              }
              className="px-1 leading-none text-[11px] text-muted hover:text-fg"
            >
              {gridRow?.capChildren === false ? '⊟' : '⊞'}
            </button>
          )}
          {/* The row's project binding lives at the top of the list it
              constrains — the whole benefit of a per-row index over one shared
              sidebar. Falls back to the scope label in classic Dispatch. */}
          {onPickRowProject ? (
            <button
              type="button"
              onClick={onPickRowProject}
              data-dispatch-row="true"
              title="Restrict this row to one project"
              className="max-w-[9rem] truncate uppercase hover:text-fg"
            >
              {rowProjectLabel ?? 'Any project'}
            </button>
          ) : (
            <span>{dispatchScope}</span>
          )}
        </span>
      </div>
      {/* Pinned section. Rendered above the regular groups and
          always visible — pinned agents are cross-scope by design.
          The chip on each row carries the tab letter + project title
          so a global pin (e.g. ★1 → tab D / "ml-pipeline") stays
          legible while dispatch scope is set to a different project.
          Skip rendering when there are no pins so the regular agent
          groups don't gain an empty section header. */}
      {scopedPinnedRows.length > 0 && (
        <div className="border-b border-border" data-dispatch-pinned-group="true">
          {/* projectTabId=null: pinned agents can span several projects, so
              there is no single tab a new agent would belong to. */}
          <DispatchGroupHeader title="Pinned" rows={scopedPinnedRows} projectTabId={null} />
          <div>
            {scopedPinnedRows.map(row => (
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
      {scopedGroups.map(group => (
        <div key={group.tab.id} className="border-b border-border">
          <DispatchGroupHeader
            title={group.tab.title}
            rows={group.rows}
            projectTabId={group.tab.id}
            onCreateAgent={onCreateAgentInProject}
          />
          <div>
            {group.items.map(item => (
              item.kind === 'agent' ? (
                <DispatchAgentListRow
                  key={item.row.key}
                  row={item.row}
                  active={item.row.sessionId === activeSessionId}
                  disabled={disabledSessionIds?.has(item.row.sessionId) ?? false}
                  showWorktreeBadges={showWorktreeBadges}
                  focusSessionInTab={focusSessionInTab}
                />
              ) : (
                <button
                  key={`${item.kind}:${item.parentSessionId}`}
                  type="button"
                  onClick={() => onToggleExpandedParent?.(item.parentSessionId)}
                  data-dispatch-row="true"
                  className="flex w-full items-center gap-1 border-t border-border py-1 pl-7 text-left text-[10px] text-muted hover:text-fg hover:bg-surface-raised"
                >
                  {item.kind === 'more' ? `+ ${item.hidden} more` : '− Show fewer'}
                </button>
              )
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
  // Null for the "Pinned" section, which reuses this header but is not a
  // project — there is no tab to create an agent in, so the button is omitted
  // rather than guessing. Passed explicitly rather than derived here, because
  // deriving it would mean this component knowing which of its two callers it
  // is, which is exactly the coupling that makes a shared header stop being
  // shared.
  projectTabId,
  onCreateAgent,
}: {
  title: string
  rows: DispatchAgentRow[]
  projectTabId: TabId | null
  onCreateAgent?: ((tabId: TabId, anchorSessionId: SessionId) => void) | undefined
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
      {/* The header div has no onClick of its own, so this needs no
          stopPropagation and there is no button-in-button hazard — unlike the
          agent rows below, which ARE buttons. Deliberately always visible
          rather than hover-revealed: DispatchColorFlagStrip already sets the
          precedent that this list reserves its space permanently so the
          trailing edge stays straight, and a hover-revealed control is one a
          mouse-first user has to hunt for. */}
      {/* Grouped so `justify-between` puts the title left and this pair right;
          three loose children would space the button out into the middle. */}
      <span className="flex shrink-0 items-center gap-1.5">
        {projectTabId && onCreateAgent && rows.length > 0 ? (
          <button
            type="button"
            aria-label={`New agent in ${title}`}
            title={`New agent in ${title}`}
            onClick={() => onCreateAgent(projectTabId, rows[0].sessionId)}
            className="h-4 w-4 rounded-control text-[12px] leading-none text-muted hover:bg-border hover:text-ink"
          >
            +
          </button>
        ) : null}
        <span className="text-muted tabular-nums">
          {runningCount}/{rows.length}
        </span>
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
  const title = dispatchRowTitle(row, runtime.entries)
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
        relative flex w-full items-stretch text-left border-t border-border overflow-hidden [contain:layout_paint]
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
              className="rounded-control
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
      {/* WHY this column renders even when the row has no flag: a sparse,
          conditional strip would make each row's title width depend on its
          flag state and destroy the straight trailing edge users scan. The
          shared component leaves unflagged rows transparent while preserving
          the same real 10px flex allocation in both rich and tiled lists. */}
      <DispatchColorFlagStrip sessionId={row.sessionId} />
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

/**
 * Resolve the one-line Dispatch label without erasing the distinction between
 * an explicit title and the existing latest-prompt fallback.
 *
 * WHY `row.title` alone is insufficient: selectors historically fold the cwd
 * basename into that field, and the component then replaces it with the latest
 * prompt. Once users can author a title, applying the same replacement makes
 * Save appear to work in the pane while the primary Dispatch index—the surface
 * built for scanning many agents—continues showing something else. Carrying
 * `agentTitle` separately lets explicit user intent win while preserving the
 * useful automatic prompt label for every untitled agent.
 */
export function dispatchRowTitle(
  row: Pick<DispatchAgentRow, 'agentTitle' | 'kind' | 'title'>,
  entries?: Entry[],
): string {
  if (row.agentTitle) return row.agentTitle
  if (row.kind !== 'terminal' && entries) {
    return cachedLatestPromptTitle(entries, row.kind) ?? row.title
  }
  return row.title
}

function dispatchSubtitle(runtime: {
  sessionStatus?: string
  streamPhase?: string
  exited?: number | null
  unreadSince?: number | null
  processStatus?: string
}, kind?: SessionKind): string {
  // WHY terminals get their own label path:
  // Agent subtitles describe model turn state (`thinking`, `responding`,
  // tool phases). A shell terminal has no transcript turn lifecycle, so
  // showing those same words would imply Claude/Codex semantics that do not
  // exist. Keep the process state visible, but prefix it as shell state so a
  // terminal row is scan-distinct even before the badge is read.
  if (kind === 'terminal') {
    if (runtime.sessionStatus === undefined) return 'shell starting'
    if (isSessionExited(runtime)) return 'shell exited'
    if (runtime.sessionStatus === 'running') return 'shell running'
    return 'shell idle'
  }
  if (runtime.sessionStatus === undefined) return 'starting'
  if (runtime.streamPhase && runtime.streamPhase !== 'idle') return runtime.streamPhase
  if (runtime.sessionStatus === 'running') return 'running'
  if (isSessionExited(runtime)) return 'exited'
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
  // Registry-derived (#394 phase 4); terminal keeps its literal,
  // undefined kind = pre-kind back-compat (Claude).
  const label =
    kind === 'terminal'
      ? 'Terminal'
      : getRendererProviderCapabilities(isAgentProviderKind(kind) ? kind : DEFAULT_PROVIDER).shortLabel
  const classes = kind === 'terminal'
    ? 'border-info-border bg-info-soft text-info'
    : 'border-border bg-surface-hi text-muted'
  return (
    <span className={`rounded-chip flex-shrink-0 px-1.5 py-[1px] text-[9px] font-code leading-none border ${classes}`}>
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
          flex-shrink-0 rounded-chip border border-warning-border bg-warning-soft
          px-1.5 py-[1px] text-[9px] font-semibold leading-none text-warning
        "
      >
        {label ?? 'ACTION'}
      </span>
    )
  }
  return (
    <span
      className="
        flex-shrink-0 rounded-chip border border-accent/70 bg-accent/20
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
  processStatus?: string
}): DispatchAgentActivity {
  if (runtime.sessionStatus === undefined) return 'starting'
  if (isSessionExited(runtime)) return 'exited'
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
      index: 'bg-success text-success-fg',
      title: '',
    }
  }
  if (activity === 'running') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-info text-info-fg',
      title: '',
    }
  }
  if (activity === 'starting') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-ink',
      index: 'bg-warning text-warning-fg',
      title: '',
    }
  }
  if (activity === 'exited') {
    return {
      row: 'bg-surface hover:bg-surface-hi text-muted opacity-75',
      index: 'bg-danger text-danger-fg',
      title: '',
    }
  }
  return {
    row: 'bg-surface hover:bg-surface-hi text-ink-dim',
    index: 'bg-surface-hi text-muted',
    title: '',
  }
}

// Activity → dot color for the compact mini-list. Mirrors the index-cell
// palette in dispatchActivityClasses so the two surfaces read the same.
export function dispatchActivityDotClass(activity: DispatchAgentActivity): string {
  switch (activity) {
    case 'working':
      return 'bg-success'
    case 'running':
      return 'bg-info'
    case 'starting':
      return 'bg-warning'
    case 'exited':
      return 'bg-danger'
    default:
      return 'bg-muted'
  }
}

/**
 * The empty state for a lane or list with nothing in it.
 *
 * WHY `hint` is optional rather than always shown: this renders for two
 * different situations. One is exhaustion — every agent is already in a lane,
 * and the user did not ask for this — where a second line telling them to press
 * a key would be noise. The other is a lane the user just deliberately created
 * (#673), where naming the state and the way out of it is the whole job. Only
 * the caller knows which one it is looking at.
 */
export function DispatchEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1 px-4 text-center text-[12px] text-muted">
      <span>{message}</span>
      {hint && <span className="text-[11px] text-muted/70">{hint}</span>}
    </div>
  )
}
