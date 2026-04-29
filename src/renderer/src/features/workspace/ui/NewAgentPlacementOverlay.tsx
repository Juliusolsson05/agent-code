import { useEffect, useMemo, useRef, useState } from 'react'

import {
  buildPlacementTargets,
  defaultPlacementTargetId,
  placementTargetIdForArrow,
  type PlacementTarget,
} from '@renderer/features/workspace/lib/newAgentPlacement'
import type { SessionId, SessionKind } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
  /**
   * Non-null = "attach detached session to grid" mode. The overlay
   * skips the kind picker (the session already exists) and goes
   * straight to placement-target selection. On Enter the chosen target
   * is fed to attachDetachedToGrid instead of commitNewAgentPlacement.
   *
   * WHY this is a prop and not internal overlay state: opening the
   * overlay in attach mode is a workspace-level intent (driven by a
   * command palette entry), so the source of truth lives in the
   * uiShell store and gets passed in. That keeps the close handler in
   * App.tsx — same place that closes the create-mode overlay — so
   * Escape, click-outside, and post-commit close all converge there.
   */
  attachDetachedSessionId: SessionId | null
}

const KIND_OPTIONS: Array<{ kind: SessionKind; label: string; description: string }> = [
  { kind: 'claude', label: 'Claude', description: 'full agent session' },
  { kind: 'codex', label: 'Codex', description: 'OpenAI coding agent session' },
  { kind: 'terminal', label: 'Terminal', description: 'plain shell pane' },
]

const ARROW_TO_DIRECTION = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
} as const

export function NewAgentPlacementOverlay({ open, workspace, onClose, attachDetachedSessionId }: Props) {
  // Attach mode is "user wants to move this existing detached session
  // into the grid." The overlay still does placement, just no spawn.
  // We compute it once at the top so every downstream branch reads
  // from the same value rather than null-checking the prop everywhere.
  const attachMode = attachDetachedSessionId !== null
  const overlayRef = useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedKind, setSelectedKind] = useState<SessionKind | null>(null)
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  // One-shot latch around commitNewAgentPlacement. The commit is async
  // (spawns a session, awaits an IPC round-trip, then calls
  // closeNewAgentPlacement()). Until the close fires, this overlay
  // keeps its `open` prop true and its keydown listener registered —
  // so a user that hits Enter twice in quick succession would fire
  // commit twice, spawning a second unwanted agent. A ref (not state)
  // because the latch needs to gate the synchronous keydown handler
  // path, not trigger a re-render.
  const committingRef = useRef(false)

  const activeTab = workspace.activeTab
  const anchorSessionId = activeTab?.focusedSessionId ?? null
  const dispatchMode = workspace.dispatchMode !== null
  const kindOptions = useMemo(
    () => dispatchMode
      ? KIND_OPTIONS.filter((option): option is Extract<typeof KIND_OPTIONS[number], { kind: 'claude' | 'codex' }> =>
          option.kind === 'claude' || option.kind === 'codex',
        )
      : KIND_OPTIONS,
    [dispatchMode],
  )

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
    // In attach mode there is no kind picker — the session already
    // exists. Pre-fill selectedKind with the detached session's kind
    // so the overlay starts on the placement-target step. We pick a
    // sentinel kind for the rendering branch below; it is never read
    // for the attach commit path because attach goes through
    // attachDetachedToGrid which doesn't take a kind argument.
    if (attachMode) {
      const kind = attachDetachedSessionId
        ? workspace.state.sessions[attachDetachedSessionId]?.kind ?? 'claude'
        : 'claude'
      setSelectedKind(kind)
    } else {
      setSelectedKind(null)
    }
    setSelectedTargetId(null)
    // Reset the commit latch whenever the overlay re-opens. Otherwise
    // a user could open → commit → close → reopen and the second
    // session would be suppressed.
    committingRef.current = false
  }, [attachDetachedSessionId, attachMode, open, workspace.state.sessions])

  useEffect(() => {
    if (!open) return
    const element = overlayRef.current
    if (!element) return
    const update = () => {
      setBounds({ width: element.clientWidth, height: element.clientHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open])

  const placementTargets = useMemo<PlacementTarget[]>(() => {
    if (!open || !activeTab || !anchorSessionId || !selectedKind) return []
    if (bounds.width <= 0 || bounds.height <= 0) return []
    return buildPlacementTargets(
      activeTab.root,
      anchorSessionId,
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
    )
  }, [activeTab, anchorSessionId, bounds.height, bounds.width, open, selectedKind])

  useEffect(() => {
    if (!selectedKind || !anchorSessionId) return
    if (placementTargets.length === 0) {
      setSelectedTargetId(null)
      return
    }
    setSelectedTargetId(prev => (
      prev && placementTargets.some(target => target.id === prev)
        ? prev
        : defaultPlacementTargetId(placementTargets, anchorSessionId)
    ))
  }, [anchorSessionId, placementTargets, selectedKind])

  const placementTarget = useMemo(
    () => placementTargets.find(target => target.id === selectedTargetId) ?? null,
    [placementTargets, selectedTargetId],
  )

  useEffect(() => {
    if (!open) return
    const handledPickerKeys = new Set(['Escape', 'ArrowUp', 'ArrowDown', 'Enter'])
    const handledPlacementKeys = new Set([
      'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter',
    ])

    const onKeyDown = (event: KeyboardEvent) => {
      if (!selectedKind) {
        if (!handledPickerKeys.has(event.key)) return
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelectedIndex(prev => (prev + kindOptions.length - 1) % kindOptions.length)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelectedIndex(prev => (prev + 1) % kindOptions.length)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const option = kindOptions[selectedIndex]
          if (!option) return
          if (dispatchMode) {
            // kindOptions is filtered above to exclude 'terminal' in
            // dispatch mode, so this guard is structurally guaranteed
            // — but the typechecker can't infer that from the runtime
            // filter, so re-narrow at the call site to satisfy the
            // 'claude' | 'codex' constraint on createDetachedDispatchAgent.
            if (option.kind !== 'claude' && option.kind !== 'codex') return
            if (committingRef.current) return
            committingRef.current = true
            // Dispatch Mode creates detached agents associated with the active
            // project tab. There is intentionally no placement step here:
            // inserting into the grid would recreate the broken ten-agent
            // layout when the user exits the command-center surface.
            void workspace.createDetachedDispatchAgent(option.kind)
            return
          }
          setSelectedKind(option.kind)
        }
        return
      }

      if (!handledPlacementKeys.has(event.key)) return
      if (event.key === 'Enter' && !placementTarget) return
      event.stopPropagation()

      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Backspace') {
        event.preventDefault()
        if (anchorSessionId) {
          setSelectedTargetId(defaultPlacementTargetId(placementTargets, anchorSessionId))
        }
        return
      }
      if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown'
      ) {
        event.preventDefault()
        // WHY direct arrow mapping instead of nearest-rectangle navigation:
        //
        // The target set intentionally contains two different operations:
        // split the focused pane, or wrap the whole root. Rendering every
        // target as a clickable rectangle made those operations overlap, and
        // center-distance navigation could jump from a local split to an
        // unrelated outer row because a large half-screen target happened to
        // be closer. Plain arrows now mean "place relative to the focused
        // pane"; Shift+arrow means "place relative to the whole tab." That
        // keeps the operations explicit and makes the preview the only visual
        // source of truth.
        const arrow = ARROW_TO_DIRECTION[event.key]
        const scope = event.shiftKey ? 'global' : 'local'
        // Arrow placement is anchor-relative; without an anchor in the
        // active tab there is nothing to place beside. The visibility
        // guard at the bottom of the component already prevents render
        // in that case, but the keydown handler is wired at document
        // level so this branch can still fire while we're in a
        // transient state — null-guard explicitly so the typechecker
        // is happy and the runtime is safe.
        if (!anchorSessionId) return
        setSelectedTargetId(placementTargetIdForArrow(
          placementTargets,
          anchorSessionId,
          arrow,
          scope,
        ))
        return
      }
      if (event.key === 'Enter' && placementTarget) {
        event.preventDefault()
        // Latch against double-commit. commitNewAgentPlacement is a
        // multi-step async: spawn() → setState → closeNewAgentPlacement.
        // The overlay stays mounted/open until close fires, so a rapid
        // second Enter would commit again and spawn a second session
        // the user didn't ask for. Skipping here keeps the first commit
        // the authoritative one; the reset in the `open` effect clears
        // the latch the next time the overlay opens.
        if (committingRef.current) return
        committingRef.current = true
        if (attachMode && attachDetachedSessionId) {
          // Attach is synchronous: it's a pure state move from
          // detachedSessions into a tile leaf, no spawn round-trip.
          // We close the overlay ourselves because attachDetachedToGrid
          // doesn't own that lifecycle (closeNewAgentPlacement is the
          // create-mode close; the parent owns onClose for both modes).
          workspace.attachDetachedToGrid(attachDetachedSessionId, placementTarget)
          onClose()
          return
        }
        void workspace.commitNewAgentPlacement(selectedKind, placementTarget)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [
    anchorSessionId,
    attachDetachedSessionId,
    attachMode,
    dispatchMode,
    kindOptions,
    onClose,
    open,
    placementTarget,
    placementTargets,
    selectedIndex,
    selectedKind,
    workspace,
  ])

  // Visibility rules:
  //   - create mode in grid: needs an anchor (focused leaf to place beside)
  //   - create mode in dispatch: no placement, just kind picker
  //   - attach mode: needs an anchor too (placement targets are computed
  //     relative to the focused grid pane). If the active tab has no
  //     leaves, the user has to add a pane first — refused at the
  //     command-palette `when` check, but guarded here as well.
  if (!open || !activeTab) return null
  if (attachMode && !anchorSessionId) return null
  if (!attachMode && !dispatchMode && !anchorSessionId) return null

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40 bg-black/20"
    >
      {selectedKind && placementTarget && (
        <div
          className={`
            absolute pointer-events-none border-2
            ${placementTarget.scope === 'global'
              ? 'border-amber-400 bg-amber-400/12 shadow-[0_0_0_1px_rgba(251,191,36,0.35)]'
              : 'border-red-500 bg-red-500/12 shadow-[0_0_0_1px_rgba(239,68,68,0.35)]'
            }
          `}
          style={{
            left: placementTarget.rect.x,
            top: placementTarget.rect.y,
            width: placementTarget.rect.width,
            height: placementTarget.rect.height,
          }}
          aria-label={placementTarget.label}
        />
      )}

      <div className="absolute left-4 top-4 pointer-events-none">
        <div className="border border-border bg-surface/95 px-3 py-2 text-[11px] text-ink-dim shadow-lg shadow-black/30">
              {!selectedKind ? (
                <div>{dispatchMode ? 'Choose dispatch agent type with ↑/↓ and press Enter' : 'Choose agent type with ↑/↓ and press Enter'}</div>
          ) : (
            <div className="space-y-1">
              <div>
                {attachMode
                  ? 'Attach detached agent to grid'
                  : `${KIND_OPTIONS.find(option => option.kind === selectedKind)?.label} placement`}
              </div>
              <div className="text-muted">
                Arrows split the focused pane. Shift+arrows add an outer row or column.
              </div>
              <div className="text-muted">
                Target: {placementTarget?.label ?? 'none'}
              </div>
            </div>
          )}
        </div>
      </div>

      {!selectedKind && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-[340px] border border-border bg-surface shadow-lg shadow-black/30">
            <div className="border-b border-border px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
              New Agent
            </div>
            <div className="p-2">
              {kindOptions.map((option, index) => {
                const active = index === selectedIndex
                return (
                  <button
                    key={option.kind}
                    type="button"
                    onClick={() => {
                      setSelectedIndex(index)
                      setSelectedKind(option.kind)
                    }}
                    className={`flex w-full items-center justify-between border px-3 py-2 text-left ${
                      active
                        ? 'border-accent bg-accent text-accent-fg'
                        : 'border-border bg-canvas text-ink-dim hover:border-border-hi hover:text-ink'
                    }`}
                  >
                    <span className="text-[12px]">{option.label}</span>
                    <span className={`text-[10px] ${active ? 'text-accent-fg/80' : 'text-muted'}`}>
                      {option.description}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
