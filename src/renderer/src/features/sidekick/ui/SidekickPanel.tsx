import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { PanelHeader } from '@renderer/components/ui/panel-header'
import { SidePanel } from '@renderer/components/ui/side-panel'
import { useHermesConnections } from '@renderer/features/hermes-chat/useHermesConnections'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { sidekickPlace } from '@renderer/features/sidekick/actions/useSidekickActions'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickSummary } from '@renderer/features/sidekick/state/sidekickIndexStore'
import { KeyboardRegionContext, SIDEKICK_PANEL_ATTRIBUTE } from '@renderer/features/sidekick/ui/KeyboardRegionContext'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { providerChoiceLabel } from '@renderer/workspace/providerChoices'
import { clampSidekickPanelWidth, DEFAULT_SIDEKICK_PANEL } from '@renderer/workspace/sidekickPanel'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { isAgentProviderKind } from '@shared/types/providerKind'

/**
 * The tab id renderWorkspaceLeaf requires. NEVER resolved: the panel always
 * passes both `onFocusRequest` and `surfacePaneLabel`, the two parameters a
 * leaf would otherwise derive from its tab (TileTree.tsx). A sidekick has no
 * project, so there is no real id to pass — a named constant says so instead
 * of an empty string that looks like a bug.
 */
export const SIDEKICK_SURFACE_TAB_ID = 'sidekick'


type Props = { workspace: Workspace; actions: SidekickActions }

export function SidekickPanel({ workspace, actions }: Props) {
  const panel = workspace.state.sidekickPanel ?? DEFAULT_SIDEKICK_PANEL
  const settings = useAppStore(state => state.settings)
  const names = useAppStore(state => state.workspaceAgentNames)
  const region = useAppStore(state => state.keyboardRegion)
  const setRegion = useAppStore(state => state.setKeyboardRegion)
  const openPicker = useAppStore(state => state.openSidekickPicker)
  const { showToast } = useGlobalToast()
  const summary = useSidekickSummary(panel.sidekickId)
  const place = sidekickPlace(workspace.state.sessions, panel.sidekickId)
  const [busy, setBusy] = useState<'attaching' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Width: clamped on every read (sidekickPanel.ts WHY), dragged from the
  // panel's LEFT edge. The panel is the rightmost column of the main row, so
  // its width is simply the distance from the pointer to the window's right
  // edge.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const width = clampSidekickPanelWidth(panel.width, windowWidth)
  const splitter = useResizableSplitter({
    axis: 'x',
    onDrag: clientX => workspace.setSidekickPanel({ width: clampSidekickPanelWidth(window.innerWidth - clientX, window.innerWidth) }),
  })

  // Attach the sidekick as soon as the panel shows it, when no CURRENT lease
  // holds it elsewhere. WHY 'elsewhere' is attempted too (review round 1, F3):
  // after this window's renderer reloads, main still files the lease under
  // this window at the old generation until something re-claims it, and the
  // index can report it as live in a window — this one. Main is the only side
  // that can tell "stale lease of mine" from "really in another window":
  // attach transfers a stale lease and refuses a current one with
  // 'owned-elsewhere', which simply leaves the "Live in another window" state
  // up. A sidekick live in another window is never TAKEN automatically —
  // "Open here" is the explicit move.
  const attachAttempted = useRef<string | null>(null)
  // Retry must re-run this effect; clearing the ref alone changed no dependency
  // (review round 1, F6), so the button did nothing.
  const [attempt, setAttempt] = useState(0)
  // Wait for boot (plan R2): rehydrate's first publish also merges held
  // sidekick rows, so this wait is belt and braces, not load-bearing.
  const bootstrapComplete = workspace.restoreStatus !== 'pending'
  useEffect(() => {
    if (!panel.sidekickId || !bootstrapComplete) return
    if (place.kind !== 'asleep' && place.kind !== 'elsewhere') return
    // Keyed by place too: a sidekick refused as 'elsewhere' must be attached
    // once its window closes and it turns 'asleep'.
    const key = `${panel.sidekickId}:${place.kind}:${attempt}`
    if (attachAttempted.current === key) return
    attachAttempted.current = key
    setBusy('attaching')
    setFailure(null)
    void actions.showSidekick(panel.sidekickId)
      .then(result => { if (!result.ok && result.reason !== 'owned-elsewhere') setFailure(failureText(result.reason)) })
      .catch(error => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }, [actions, attempt, bootstrapComplete, panel.sidekickId, place.kind])

  // Move the caret into the sidekick whenever it owns the keyboard (F2).
  // TileLeaf focuses its input only when its `focused` prop CHANGES or focus
  // is unowned; the first ⌘J mounts the leaf already focused while the caret
  // still sits in the lane's composer, so Enter submitted to the lane. The
  // first textarea covers both views: the prose composer and xterm's helper
  // textarea in terminal view.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const heldSessionId = place.kind === 'here' ? place.sessionId : null
  useEffect(() => {
    if (region !== 'sidekick' || !heldSessionId) return
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current
      if (!body || body.contains(document.activeElement)) return
      body.querySelector<HTMLElement>('textarea')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [region, heldSessionId])

  const openHere = useCallback(async () => {
    if (!panel.sidekickId) return
    setBusy('attaching')
    setFailure(null)
    try {
      const result = await actions.openHere(panel.sidekickId)
      if (!result.ok) setFailure(failureText(result.reason))
      else setRegion('sidekick')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [actions, panel.sidekickId, setRegion])

  const remove = useCallback(async () => {
    if (!panel.sidekickId) return
    const confirmed = await requestConfirm({
      title: 'Remove Sidekick',
      description: 'Its process stops and it leaves the Sidekick index. The conversation stays in Conversations.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await actions.removeSidekick(panel.sidekickId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }, [actions, panel.sidekickId, showToast])

  const meta = place.kind === 'here' ? workspace.state.sessions[place.sessionId] : undefined
  const kind = meta?.kind ?? summary?.kind ?? null
  const kindLabel = kind && isAgentProviderKind(kind) ? providerChoiceLabel(kind, (meta?.providerRuntime ?? summary?.providerRuntime ?? undefined) as never) : null
  const hermes = useHermesConnections(kind === 'hermes')
  const connectionId = meta?.remoteConnectionId ?? summary?.remoteConnectionId ?? null
  const connectionName = connectionId ? hermes?.find(entry => entry.id === connectionId)?.name ?? null : null
  const agentNameId = meta?.agentNameId ?? summary?.agentNameId ?? null
  const name = settings.agentNamesEnabled && agentNameId ? names[agentNameId] ?? null : null
  const title = [name ?? meta?.title ?? summary?.title ?? null, kindLabel, connectionName].filter(Boolean).join(' · ')

  return (
    <SidePanel label="Sidekick" className="relative" style={{ width }} {...{ [SIDEKICK_PANEL_ATTRIBUTE]: '' }}>
      <div className="absolute inset-y-0 left-0 z-10 -translate-x-1/2">
        <SplitHandle
          dragging={splitter.dragging}
          onMouseDown={splitter.onMouseDown}
          label="Resize Sidekick panel"
          valueNow={width}
          onKeyboardDelta={delta => workspace.setSidekickPanel({ width: clampSidekickPanelWidth(width - delta * 16, window.innerWidth) })}
        />
      </div>
      {splitter.cursorLock}
      <PanelHeader
        label="Sidekick"
        title={title || undefined}
        onClose={() => {
          workspace.setSidekickPanel({ open: false })
          setRegion('workspace')
        }}
        closeLabel="Hide Sidekick"
        actions={(
          <>
            <Button variant="ghost" size="xs" onClick={() => openPicker('switch')}>Switch</Button>
            {place.kind === 'here' ? (
              <Button variant="ghost" size="xs" onClick={() => { void workspace.reloadSessionAgent(place.sessionId) }}>Reload</Button>
            ) : null}
            {panel.sidekickId ? <Button variant="ghost" size="xs" onClick={() => { void remove() }}>Remove</Button> : null}
          </>
        )}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {place.kind === 'here' ? (
          <KeyboardRegionContext.Provider value="sidekick">
            <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
              {renderWorkspaceLeaf(
                place.sessionId,
                region === 'sidekick' ? place.sessionId : null,
                workspace,
                SIDEKICK_SURFACE_TAB_ID,
                settings.agentViewMode,
                settings.showStatusMode,
                settings.showWorktreeBadges,
                () => setRegion('sidekick'),
                'S',
              )}
            </div>
          </KeyboardRegionContext.Provider>
        ) : (
          <SidekickPanelBody
            state={busy === 'attaching' ? 'attaching' : failure ? 'failed' : place.kind === 'elsewhere' ? 'elsewhere' : place.kind === 'none' ? 'empty' : 'attaching'}
            failure={failure}
            onOpenHere={() => { void openHere() }}
            onRetry={() => { setFailure(null); setAttempt(value => value + 1) }}
            onNew={() => openPicker('create')}
          />
        )}
      </div>
    </SidePanel>
  )
}

function failureText(reason: string): string {
  switch (reason) {
    case 'owned-elsewhere': return 'This sidekick is live in another window.'
    case 'not-found': return 'This sidekick no longer exists.'
    case 'window-gone': return 'This window could not take the sidekick.'
    default: return reason
  }
}

export function SidekickPanelBody({ state, failure, onOpenHere, onRetry, onNew }: {
  state: 'empty' | 'elsewhere' | 'attaching' | 'failed'
  failure: string | null
  onOpenHere: () => void
  onRetry: () => void
  onNew: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[12px] text-muted">
      {state === 'empty' ? (
        <>
          <div>No sidekick yet. A sidekick is a global agent that starts in your home folder and stays beside every project.</div>
          <Button size="sm" onClick={onNew}>New Sidekick…</Button>
        </>
      ) : null}
      {state === 'elsewhere' ? (
        <>
          <div>Live in another window.</div>
          <Button size="sm" onClick={onOpenHere}>Open here</Button>
        </>
      ) : null}
      {state === 'attaching' ? <div role="status">Opening sidekick…</div> : null}
      {state === 'failed' ? (
        <>
          <div role="alert">{failure}</div>
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        </>
      ) : null}
    </div>
  )
}
