import { isAgentProviderKind } from '@shared/types/providerKind'
import { Button } from '@renderer/components/ui/button'
import { Kbd, KbdLegend } from '@renderer/components/ui/kbd'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  SessionId,
  SessionSpawnSelection,
  TabId,
} from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { MISSING_PROVIDER_HINT, useMissingProviders } from '@renderer/features/setup/store'
import {
  filterSessionSpawnChoices,
  SESSION_SPAWN_CHOICES,
  type AgentProviderChoice,
} from '@renderer/workspace/providerChoices'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'

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
  const missingProviders = useMissingProviders()
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
  // Enablement filter first (#1102), linked-agent filter second: a disabled
  // provider is not an option in either mode, and `terminal` survives only
  // the ordinary path. Filtering at render, not module level — enablement
  // changes arrive over IPC while this module is already loaded.
  const enabledKinds = useEnabledAgentProviderKinds()
  const kindOptions = useMemo(
    () => {
      const enabled = filterSessionSpawnChoices(KIND_OPTIONS, enabledKinds)
      return linkedMode
        ? enabled.filter((option): option is AgentProviderChoice =>
            isAgentProviderKind(option.kind),
          )
        : enabled
    },
    [linkedMode, enabledKinds],
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
    // The list keys (plan K5/M6): ↑↓ and ⌃N/⌃P move, Home/End jump, and the
    // ends CLAMP (plan D4 — this list used to wrap, unlike every other list).
    const isMove = (event: KeyboardEvent) =>
      event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Home' || event.key === 'End'
      || (event.ctrlKey && !event.metaKey && !event.altKey && (event.key === 'n' || event.key === 'p'))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter' && !isMove(event)) return
      event.stopPropagation()
      event.preventDefault()
      if (event.key === 'Escape') {
        onClose()
        return
      }
      const last = kindOptions.length - 1
      if (event.key === 'Home') { setSelectedIndex(0); return }
      if (event.key === 'End') { setSelectedIndex(last); return }
      if (event.key === 'ArrowUp' || event.key === 'p') {
        setSelectedIndex(prev => Math.max(0, prev - 1))
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'n') {
        setSelectedIndex(prev => Math.min(last, prev + 1))
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

  // The listbox takes focus on open so it is the focus OWNER that announces
  // the highlighted option (focus-owner invariant, useListNavigation). Keys
  // are still handled by the capture listener above, which is why they keep
  // working even if focus is moved elsewhere by a click.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

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
      {/* (The floating "Choose agent type with ↑/↓ and press Enter" hint in
          the corner is gone: the keys are now a chip legend in the card's
          own footer, where the eye already is — plan H3.) */}

      {/* pointer-events-none on the CENTERING layer, re-enabled on the card
          itself. Without this the layer is `absolute inset-0` and covers the
          whole backdrop, so the backdrop's click-to-dismiss could never fire
          (event.target was always this div, never the backdrop) and the
          overlay had ZERO mouse exits — the only way out with a mouse was to
          create an agent you did not want. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="rounded-float pointer-events-auto w-[min(360px,92vw)] border border-popover-border bg-popover-bg shadow-[0_16px_48px_var(--theme-shadow-color)]">
          <div className="border-b border-border px-4 py-3 text-[12px] uppercase tracking-wider text-muted">
            New Agent
          </div>
          <div
            ref={listRef}
            role="listbox"
            aria-label="Agent type"
            aria-activedescendant={`new-agent-kind-${selectedIndex}`}
            tabIndex={-1}
            className="flex flex-col gap-1 p-2 outline-none"
          >
            {kindOptions.map((option, index) => {
              const active = index === selectedIndex
              return (
                <button
                  key={`${option.kind}:${option.providerRuntime ?? 'default'}`}
                  id={`new-agent-kind-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  // Hover follows the pointer only when it MOVES (the shared
                  // list rule), and a click does not take focus from the list.
                  onMouseMove={() => { if (!active) setSelectedIndex(index) }}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    setSelectedIndex(index)
                    commitKind(option)
                  }}
                  // Option rows (radius table: `control`) with the one row
                  // highlight (plan T7); the solid-accent fill is for SELECTED
                  // tabs, not a list cursor.
                  className={`rounded-control flex w-full items-center justify-between border border-l-2 px-3 py-2 text-left ${
                    active
                      ? 'border-border border-l-accent bg-row-selected-bg text-ink'
                      : 'border-border border-l-border bg-canvas text-ink-dim hover:bg-row-hover-bg hover:text-ink'
                  }`}
                >
                  <span className="text-[12px]">{option.label}</span>
                  <span className="text-[10px] text-muted">
                    {isAgentProviderKind(option.kind) && missingProviders.has(option.kind)
                      ? MISSING_PROVIDER_HINT
                      : option.description}
                  </span>
                </button>
              )
            })}
          </div>
          {/* A visible Cancel: the backdrop click is reachable, but a control
              is what a mouse-first user actually looks for. */}
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <KbdLegend className="text-[10px] text-muted" items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Enter'], label: 'create' }]} />
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
              <Kbd binding="Escape" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
