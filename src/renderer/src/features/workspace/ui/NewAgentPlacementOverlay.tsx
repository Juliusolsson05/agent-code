import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
  isAgentProviderKind,
} from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { Button } from '@renderer/components/ui/button'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  buildPlacementTargets,
  defaultPlacementTargetId,
  placementTargetIdForArrow,
} from '@renderer/features/workspace/lib/newAgentPlacement'
import type { PlacementTarget } from '@renderer/features/workspace/lib/newAgentPlacement'
import type { SessionId, SessionKind, TabId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { DispatchAttachIntent } from '@renderer/app-state/uiShell/types'

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
  attachIntent: DispatchAttachIntent | null
  /**
   * Non-null = "Linked Agent" mode. The value is the parent session
   * id. The overlay shows ONLY the Claude/Codex kind picker — no
   * placement step — and on pick calls
   * `createLinkedAgent(kind, parentId)`. Like attach mode this is a
   * uiShell-level intent passed in, so App.tsx owns the close path.
   */
  linkedAgentParentId: SessionId | null
  /**
   * Non-null = the Dispatch project header's "+" opened this, and the new
   * agent must land in that project rather than the focused one. Carries a
   * session from the clicked group as a cwd anchor — see the field's WHY in
   * uiShell/types.ts for why both halves are needed.
   */
  projectIntent: { tabId: TabId; anchorSessionId: SessionId } | null
}

// Registry-derived agent options (#394 phase 2c-2) + the one
// non-registry pane kind. A newly registered provider appears in the
// spawn overlay automatically instead of compiling but being
// unspawnable from the UI (#394 §4.6).
const KIND_OPTIONS: Array<{ kind: SessionKind; label: string; description: string }> = [
  ...AGENT_PROVIDER_KINDS.map(kind => {
    const caps = getRendererProviderCapabilities(kind)
    return { kind: kind as SessionKind, label: caps.shortLabel, description: caps.spawnDescription }
  }),
  { kind: 'terminal', label: 'Terminal', description: 'plain shell pane' },
]

const ARROW_TO_DIRECTION = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
} as const

export function NewAgentPlacementOverlay({
  open,
  workspace,
  onClose,
  attachIntent,
  linkedAgentParentId,
  projectIntent,
}: Props) {
  // Attach mode is "user wants to move this existing detached session
  // into the grid." The overlay still does placement, just no spawn.
  // We compute it once at the top so every downstream branch reads
  // from the same value rather than null-checking the prop everywhere.
  const attachMode = attachIntent !== null
  // Linked mode is "spawn a new agent linked to a parent." Kind-only:
  // no placement step at all (the linked agent is always a detached
  // dispatch agent in the parent's tab — see createLinkedAgent).
  const linkedMode = linkedAgentParentId !== null
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
  const placementTab = attachIntent
    ? workspace.state.tabs.find(tab => tab.id === attachIntent.targetTabId) ?? null
    : activeTab
  const anchorSessionId = placementTab?.focusedSessionId ?? null
  const dispatchMode = workspace.dispatchMode !== null
  // Both dispatch mode and linked mode are "kind only": pick any registered
  // agent provider — no placement step, no terminal option. The filter below
  // pulls the option set from `AGENT_PROVIDER_KINDS` (not a hand-written
  // literal) so a newly registered provider becomes selectable here without
  // touching this file. See CLAUDE.md and issue #394 phase 4.
  const kindOnly = dispatchMode || linkedMode
  const kindOptions = useMemo(
    () => kindOnly
      ? KIND_OPTIONS.filter((option): option is Extract<typeof KIND_OPTIONS[number], { kind: AgentProviderKind }> =>
          isAgentProviderKind(option.kind),
        )
      : KIND_OPTIONS,
    [kindOnly],
  )

  // Commit a chosen kind. In kind-only modes this spawns immediately;
  // in ordinary create mode it advances to the placement step. Shared
  // by the Enter keybind and the click handler so both paths behave
  // identically (the click path used to just `setSelectedKind`, which
  // silently did nothing in dispatch mode).
  const commitKind = (kind: SessionKind) => {
    if (linkedMode && linkedAgentParentId) {
      // WHY the runtime narrow: `SessionKind` includes 'terminal', which
      // createLinkedAgent's signature refuses. The kind picker filters options
      // in kind-only modes to `AgentProviderKind` (see kindOptions above), so
      // in practice this branch only fires with an agent provider — but the
      // event handler is typed against the broader union. Route through the
      // registry predicate instead of a hand-written pair so adding a
      // provider does not silently drop it here again (#394 phase 4).
      if (!isAgentProviderKind(kind)) return
      if (committingRef.current) return
      committingRef.current = true
      void workspace.createLinkedAgent(kind, linkedAgentParentId)
      // createLinkedAgent does not own the overlay lifecycle (the
      // linked intent lives in uiShell); close it ourselves.
      onClose()
      return
    }
    if (dispatchMode) {
      if (committingRef.current) return
      committingRef.current = true
      if (kind === 'terminal') {
        // DEAD BRANCH, kept as a guard rather than removed.
        //
        // `kindOnly` is true whenever `dispatchMode` is set, and that filters
        // KIND_OPTIONS down to agent providers only — both commitKind call
        // sites read the filtered list, so Terminal is never offered here in
        // Dispatch and this cannot fire. (See the "no placement step, no
        // terminal option" note above, which says the same thing.)
        //
        // It stays because the handler is typed against the full SessionKind
        // union: if a future change reintroduces Terminal to the Dispatch kind
        // picker, falling through would hand 'terminal' to
        // createDetachedDispatchAgent, whose signature excludes it. Routing to
        // splitFocused is the correct behaviour if this ever becomes live —
        // its Dispatch branch is kind-agnostic and files a terminal as a
        // detached row (#671).
        //
        // NOT equivalent to the agent path in one respect: that path forwards
        // `projectIntent`, the project-header "+" override that exists because
        // lane focus does not identify the clicked project. splitFocused has no
        // such override, so a revived Terminal option would resolve its project
        // from focus alone.
        void workspace.splitFocused('vertical', 'terminal')
        return
      }
      // WHY registry-driven runtime narrow (not `kind !== 'claude' && kind !==
      // 'codex'`): the two-provider literal here silently dropped OpenCode
      // clicks with no toast, no spawn, no log — the classic silent-fail path
      // #394 §4 warned about. Using the shared predicate keeps this branch
      // aligned with the kind picker's option filter (kindOptions above) and
      // with every downstream API that takes `AgentProviderKind`
      // (createDetachedDispatchAgent, createLinkedAgent, buildProviderResume-
      // Command, duplicateSession).
      if (!isAgentProviderKind(kind)) return
      // Dispatch Mode creates a detached provider agent on the focused
      // Dispatch project; there is intentionally no placement step.
      // createDetachedDispatchAgent owns its own overlay close.
      //
      // When the project header's "+" opened this, the target is explicit and
      // must override focus-based resolution — the whole reason that intent
      // exists is that focus does NOT identify the clicked project in Tiled
      // Dispatch.
      void workspace.createDetachedDispatchAgent(kind, projectIntent ?? undefined)
      return
    }
    setSelectedKind(kind)
  }

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
      const kind = attachIntent
        ? workspace.state.sessions[attachIntent.sessionId]?.kind ?? DEFAULT_PROVIDER
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
  }, [attachIntent, attachMode, open, workspace.state.sessions])

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
    if (!open || !placementTab || !anchorSessionId || !selectedKind) return []
    if (bounds.width <= 0 || bounds.height <= 0) return []
    return buildPlacementTargets(
      placementTab.root,
      anchorSessionId,
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
    )
  }, [anchorSessionId, bounds.height, bounds.width, open, placementTab, selectedKind])

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
          commitKind(option.kind)
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
        if (attachMode && attachIntent) {
          // Attach may wake a post-restart parked backend before the state move.
          // Fire-and-forget here because the action owns failure toasts and
          // refuses to insert a dead leaf if wake fails.
          // We close the overlay ourselves because attachDetachedToGrid
          // doesn't own that lifecycle (closeNewAgentPlacement is the
          // create-mode close; the parent owns onClose for both modes).
          void workspace.attachDetachedToGrid(
            attachIntent.sessionId,
            attachIntent.targetTabId,
            placementTarget,
          )
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
    attachIntent,
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
  if (!open || !placementTab) return null
  if (attachMode && !anchorSessionId) return null
  if (!attachMode && !dispatchMode && !anchorSessionId) return null

  return (
    <div
      ref={overlayRef}
      data-agent-code-interaction-owner="app"
      className="absolute inset-0 z-40 bg-black/20"
      // WHY the backdrop is now clickable: during the placement step this
      // overlay rendered ZERO interactive elements — the preview rect is
      // pointer-events-none, targets move on arrows, commit is Enter, and
      // cancel was Escape. A mouse-only user who picked an agent kind was
      // trapped in a modal they could neither commit nor dismiss. This does
      // not make placement itself clickable (see the WHY further up on why
      // clickable target rectangles were removed and should stay removed) —
      // it just guarantees a way out, which is the part that was harmful.
      onClick={event => {
        // Only a click on the backdrop ITSELF. A click that bubbled up from
        // the kind picker must not also dismiss the overlay.
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      {selectedKind && placementTarget && (
        <div
          className={`
            absolute pointer-events-none border-2
            ${placementTarget.scope === 'global'
              ? 'border-warning bg-warning-soft'
              : 'border-danger bg-danger-soft'
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
        {/* The hint box is pointer-events-none so it never blocks the grid
            underneath, so the Cancel has to re-enable pointer events on
            itself. Placed here rather than in the kind picker because the
            placement step is exactly the state that had no way out. */}
        {selectedKind ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            // pointer-events-auto: the overlay root is pointer-events-none so
            // clicks reach the tiles being placed into; this escape hatch has
            // to opt back in.
            className="pointer-events-auto mt-2"
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {!selectedKind && (
        // pointer-events-none on the CENTERING layer, re-enabled on the card
        // itself. Without this the layer is `absolute inset-0` and covers the
        // whole backdrop, so the backdrop's click-to-dismiss could never fire
        // (event.target was always this div, never the backdrop). In Dispatch
        // and linked-agent mode that was fatal rather than annoying: those are
        // kind-only, so `selectedKind` never becomes truthy, the Cancel button
        // below never renders, and the overlay had ZERO mouse exits — the only
        // way out with a mouse was to create an agent you did not want. The
        // Dispatch "+" leads straight here, so it would have shipped a button
        // whose only destination is a trap.
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto w-[340px] border border-border bg-surface shadow-lg shadow-black/30">
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
                      commitKind(option.kind)
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
            {/* An explicit Cancel on the kind step too. The backdrop click
                above is now reachable, but a visible control is what a
                mouse-first user actually looks for — and this is the only step
                Dispatch and linked-agent mode ever show. */}
            <div className="flex justify-end border-t border-border px-3 py-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
