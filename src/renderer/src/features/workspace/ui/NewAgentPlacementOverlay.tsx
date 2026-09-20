import { isAgentProviderKind } from '@shared/types/providerKind'
import { Button } from '@renderer/components/ui/button'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  SessionId,
  SessionSpawnSelection,
  TabId,
} from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  SESSION_SPAWN_CHOICES,
  type AgentProviderChoice,
} from '@renderer/workspace/providerChoices'

// New Agent… — a kind picker. Pick what to create; it lands in the pool.
//
// WHY there is no placement step any more (#992): this overlay used to be two
// screens. After the kind picker came a geometric placement step — arrows
// chose "left of the focused pane" or "new outer column" and Enter split the
// tile tree there — plus a third "attach a detached session to the grid" mode
// that reused the same step. All of that was tree geometry. The stage has no
// tree: a new session joins its project's pool, and where it shows is the
// lane the creator resolves from current focus (see
// `createDetachedDispatchAgent` / `resolveDispatchSpawnTarget`). So the
// overlay is exactly what Dispatch already used: one screen, one Enter.
//
// The file keeps its historical name because MainSurface, the uiShell flags
// (`newAgentPlacementOpen`), the command (`new-agent`) and tests all speak
// it; renaming is cleanup-stage work, not a behavior change.

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
  /**
   * Non-null = "Linked Agent" mode. The value is the parent session
   * id. The overlay shows only agent choices — including the separate
   * OpenCode/OpenCode Terminal runtime choices — and on pick calls
   * `createLinkedAgent(kind, parentId)`. This is a uiShell-level intent
   * passed in, so the caller owns the close path.
   */
  linkedAgentParentId: SessionId | null
  /**
   * Non-null = a project header's "+" opened this, and the new agent must
   * land in that project rather than the focused one. Carries a session from
   * the clicked group as a cwd anchor — see the field's WHY in
   * uiShell/types.ts for why both halves are needed.
   */
  projectIntent: { tabId: TabId; anchorSessionId: SessionId } | null
}

// This overlay consumes the same expanded provider choices as the Switch
// Provider picker. See providerChoices.ts for why OpenCode Terminal is runtime
// metadata rather than a hand-written fourth provider kind.
const KIND_OPTIONS = SESSION_SPAWN_CHOICES

export function NewAgentPlacementOverlay({
  open,
  workspace,
  onClose,
  linkedAgentParentId,
  projectIntent,
}: Props) {
  const linkedMode = linkedAgentParentId !== null
  const [selectedIndex, setSelectedIndex] = useState(0)
  // One-shot latch around the spawn. Creation is async (spawns a session,
  // awaits an IPC round-trip, then closes the overlay). Until the close fires,
  // this overlay keeps its `open` prop true and its keydown listener
  // registered — so a user that hits Enter twice in quick succession would
  // spawn a second unwanted agent. A ref (not state) because the latch needs
  // to gate the synchronous keydown handler path, not trigger a re-render.
  const committingRef = useRef(false)

  // Linked mode offers agent providers only: createLinkedAgent's signature
  // refuses 'terminal' (a shell cannot be an orchestration/linked child).
  // Ordinary creation offers Terminal too (#865): terminals are full pool
  // sessions since #671.
  const kindOptions = useMemo(
    () => linkedMode
      ? KIND_OPTIONS.filter((option): option is AgentProviderChoice =>
          isAgentProviderKind(option.kind),
        )
      : KIND_OPTIONS,
    [linkedMode],
  )

  // Shared by the Enter keybind and the click handler so both paths behave
  // identically.
  const commitKind = (selection: SessionSpawnSelection) => {
    const { kind, providerRuntime } = selection
    if (committingRef.current) return
    if (linkedMode && linkedAgentParentId) {
      // WHY the runtime narrow: `SessionKind` includes 'terminal', which
      // createLinkedAgent's signature refuses. kindOptions is already filtered
      // to agent providers in linked mode, but the event handler is typed
      // against the broader union. Route through the registry predicate
      // instead of a hand-written pair so adding a provider does not silently
      // drop it here again (#394 phase 4).
      if (!isAgentProviderKind(kind)) return
      committingRef.current = true
      void workspace.createLinkedAgent({ kind, providerRuntime }, linkedAgentParentId)
      // createLinkedAgent does not own the overlay lifecycle (the
      // linked intent lives in uiShell); close it ourselves.
      onClose()
      return
    }
    committingRef.current = true
    // Every kind goes through the one pool creator, terminals included
    // (#865). It honors projectIntent, so "+" on a project header files the
    // session there, and it closes this overlay itself once the session is
    // placed (closeNewAgentPlacement) — which is why onClose is NOT called.
    void workspace.createDetachedDispatchAgent({ kind, providerRuntime }, projectIntent ?? undefined)
  }

  useEffect(() => {
    if (!open) return
    setSelectedIndex(0)
    // Reset the commit latch whenever the overlay re-opens. Otherwise
    // a user could open → commit → close → reopen and the second
    // session would be suppressed.
    committingRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    const handled = new Set(['Escape', 'ArrowUp', 'ArrowDown', 'Enter'])
    const onKeyDown = (event: KeyboardEvent) => {
      if (!handled.has(event.key)) return
      event.stopPropagation()
      event.preventDefault()
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex(prev => (prev + kindOptions.length - 1) % kindOptions.length)
        return
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex(prev => (prev + 1) % kindOptions.length)
        return
      }
      const option = kindOptions[selectedIndex]
      if (option) commitKind(option)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
    // commitKind closes over props already listed here; listing the function
    // itself would re-register the listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindOptions, linkedAgentParentId, onClose, open, projectIntent, selectedIndex, workspace])

  // A project must exist to own the new session; WelcomeEmpty covers the
  // no-project boot, so this overlay simply does not render there.
  if (!open || !workspace.activeTab) return null

  return (
    <div
      data-agent-code-interaction-owner="app"
      className="absolute inset-0 z-40 bg-black/20"
      // The backdrop is the mouse exit. Only a click on the backdrop ITSELF
      // dismisses: a click that bubbled up from the picker must not.
      onClick={event => {
        if (event.target !== event.currentTarget) return
        onClose()
      }}
    >
      <div className="absolute left-4 top-4 pointer-events-none">
        <div className="rounded-float border border-border bg-surface/95 px-3 py-2 text-[11px] text-ink-dim shadow-lg shadow-black/30">
          Choose agent type with ↑/↓ and press Enter
        </div>
      </div>

      {/* pointer-events-none on the CENTERING layer, re-enabled on the card
          itself. Without this the layer is `absolute inset-0` and covers the
          whole backdrop, so the backdrop's click-to-dismiss could never fire
          (event.target was always this div, never the backdrop) and the
          overlay had ZERO mouse exits — the only way out with a mouse was to
          create an agent you did not want. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="rounded-float pointer-events-auto w-[340px] border border-border bg-surface shadow-lg shadow-black/30">
          <div className="border-b border-border px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
            New Agent
          </div>
          <div className="p-2">
            {kindOptions.map((option, index) => {
              const active = index === selectedIndex
              return (
                <button
                  key={`${option.kind}:${option.providerRuntime ?? 'default'}`}
                  type="button"
                  onClick={() => {
                    setSelectedIndex(index)
                    commitKind(option)
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
          {/* A visible Cancel: the backdrop click is reachable, but a control
              is what a mouse-first user actually looks for. */}
          <div className="flex justify-end border-t border-border px-3 py-2">
            <Button variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
