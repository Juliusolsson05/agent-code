import { useEffect, useMemo, useRef } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import {
  providerChoiceLabel,
  enabledProviderSwitchChoices,
  type AgentProviderChoice,
} from '@renderer/workspace/providerChoices'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { isAgentProviderKind } from '@shared/types/providerKind'
import { withVisibleControls } from '@shared/text/visibleControls'
import { MISSING_PROVIDER_HINT, useMissingProviders } from '@renderer/features/setup/store'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

/** Explicit single-agent provider/runtime destination picker. */
export function ProviderSwitchPickerModal({
  open,
  sessionId,
  workspace,
  onClose,
}: Props) {
  // The LISTBOX is the focus owner (focus-owner invariant, useListNavigation).
  const listRef = useRef<HTMLDivElement | null>(null)
  const committingRef = useRef(false)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const sourceKind = isAgentProviderKind(meta?.kind) ? meta.kind : null
  // #1102: enablement filter — a disabled provider is neither a valid
  // destination nor (for a disabled source) worth offering escapes from.
  const enabledKinds = useEnabledAgentProviderKinds()
  const choices = useMemo(
    () => sourceKind ? enabledProviderSwitchChoices(sourceKind, enabledKinds) : [],
    [sourceKind, enabledKinds],
  )
  const missingProviders = useMissingProviders()

  useEffect(() => {
    if (!open) return
    // A modal instance stays mounted across invocations. Reset both pieces of
    // one-shot state so a previous selection cannot suppress or preselect the
    // next agent's switch. (The highlight resets through useListNavigation's
    // resetKey below.)
    committingRef.current = false
  }, [open, sessionId, sourceKind])

  const choose = (choice: AgentProviderChoice) => {
    if (!sessionId || committingRef.current) return
    committingRef.current = true
    // Close before the potentially minutes-long compaction transaction. The
    // existing pane toast owns progress and errors; keeping a stale picker over
    // a pane whose local id is about to be replaced would invite a second
    // selection against dead state.
    onClose()
    void workspace.switchSessionProvider(
      sessionId,
      choice.kind,
      choice.providerRuntime,
    )
  }

  const nav = useListNavigation({
    count: choices.length,
    resetKey: `${open}:${sessionId}:${sourceKind}`,
    onActivate: index => {
      const choice = choices[index]
      if (choice) choose(choice)
    },
    idPrefix: 'provider-switch-choice',
  })
  const selected = choices[nav.index] ?? null

  const currentLabel = sourceKind
    ? providerChoiceLabel(sourceKind, meta?.providerRuntime)
    : 'Unavailable agent'
  const cwdBase = meta?.cwd.split('/').filter(Boolean).pop() ?? meta?.cwd ?? ''

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={event => {
          event.preventDefault()
          listRef.current?.focus()
        }}
        // ↑↓ / ⌃N⌃P / Home / End / PgUp / PgDn / Enter via the shared hook.
        // A focused button owns its own Enter (#862) — enforced inside the
        // hook with focusedControlOwnsEnter: without it, Tab to Cancel +
        // Enter switched the agent to the highlighted provider.
        onKeyDown={nav.onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Switch Provider</DialogTitle>
          <DialogDescription asChild>
            <div>
              {/* Names the conversation being moved to another provider
                  (#1049 re-review). */}
              <div>Current: {withVisibleControls(currentLabel)}{cwdBase ? ` · ${withVisibleControls(cwdBase)}` : ''}</div>
              <div className="mt-0.5 text-[10px]">
                Choose where this conversation should continue.
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-3">
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Provider destinations"
          aria-activedescendant={nav.activeId}
          className="rounded-slab overflow-hidden border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {choices.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-muted">
              This session has no available provider destinations.
            </div>
          ) : choices.map((choice, index) => {
            const focused = index === nav.index
            return (
              <button
                key={`${choice.kind}:${choice.providerRuntime ?? 'structured'}`}
                type="button"
                {...nav.getItemProps(index)}
                role="option"
                aria-selected={focused}
                // Not a tab stop (#862). Keyboard selection is the arrow-driven
                // highlight; a Tab-focused row kept DOM focus while the arrows
                // moved the highlight, and Space — a native click on the FOCUSED
                // button — then switched to a provider other than the one
                // highlighted. Mouse clicks still work; keyboard focus now only
                // rests on the dialog surface or the footer.
                tabIndex={-1}
                data-provider-switch-choice={`${choice.kind}:${choice.providerRuntime ?? 'structured'}`}
                className={`
                  w-full border-b border-l-2 border-border px-3 py-2 text-left last:border-b-0
                  ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent hover:bg-row-hover-bg'}
                  cursor-pointer
                `}
              >
                <div className="text-[12px] font-medium text-ink">{choice.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">{missingProviders.has(choice.kind) ? MISSING_PROVIDER_HINT : choice.description}</div>
              </button>
            )
          })}
        </div>

        </div>

        {/* The prose legend "↑↓ choose · Enter switch · Esc cancel" became
            chips: Escape and Enter on the buttons that perform them, ↑↓ in the
            legend (plan H2/H3). Switch exists so Enter's meaning is on a
            button; confirmOnEnter={false} because the list owns Enter. */}
        <DialogActions
          confirmLabel="Switch"
          onConfirm={() => { if (selected) choose(selected) }}
          onCancel={onClose}
          confirmOnEnter={false}
          confirmDisabled={!selected}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}
