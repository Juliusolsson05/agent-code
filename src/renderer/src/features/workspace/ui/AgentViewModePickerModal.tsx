import { useMemo, useRef } from 'react'

import { DialogActions } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { AgentViewModeOverride, SessionId } from '@renderer/workspace/types'
import { DEFAULT_PROVIDER, effectiveProviderRuntime, isAgentProviderKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

type PickerValue = AgentViewModeOverride | 'default'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  globalMode: AgentViewMode
  onClose: () => void
}

type Option = {
  value: PickerValue
  label: string
  description: string
  disabled?: boolean
}

export function AgentViewModePickerModal({
  open,
  sessionId,
  workspace,
  globalMode,
  onClose,
}: Props) {
  // The LISTBOX is the focus owner (focus-owner invariant, useListNavigation).
  const listRef = useRef<HTMLDivElement | null>(null)
  const meta = sessionId ? workspace.state.sessions[sessionId] : null
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  const isAgent = isAgentProviderKind(kind)
  const provider = getRendererProviderCapabilities(isAgent ? kind : DEFAULT_PROVIDER)
  // Effective runtime: a terminal-only provider (Pi) is locked to its TUI
  // even when its metadata carries no runtime.
  const terminalRuntime = effectiveProviderRuntime(kind, meta?.providerRuntime) === 'terminal'
  const nativeUnavailable = kind === 'opencode' && !terminalRuntime
  const currentValue: PickerValue = terminalRuntime
    ? 'terminal'
    : meta?.agentViewModeOverride ?? 'default'

  const options = useMemo<Option[]>(
    () => [
      {
        value: 'default',
        label: `Follow Global (${labelForGlobalMode(globalMode)})`,
        description: 'Use the app-wide Agent View Mode setting.',
        disabled: terminalRuntime,
      },
      {
        value: 'agent',
        label: 'Agent',
        description: 'Always show Agent Code rendering for this session.',
        disabled: terminalRuntime,
      },
      {
        value: 'terminal',
        label: 'Terminal',
        description: nativeUnavailable
          ? 'Choose OpenCode Terminal when creating an agent; this structured session has no PTY.'
          : 'Always show the provider native terminal for this session.',
        disabled: nativeUnavailable,
      },
    ],
    [globalMode, nativeUnavailable, terminalRuntime],
  )

  const pick = (value: PickerValue) => {
    if (!sessionId || !isAgent) return
    const option = options.find(item => item.value === value)
    if (option?.disabled) return
    const ok = workspace.setSessionAgentViewModeOverride(
      sessionId,
      value === 'default' ? null : value,
    )
    if (ok) onClose()
  }
  // Movement, disabled-row skipping, Enter and hover go through the shared
  // list hook (plan K5); this dialog only says what Enter means. The
  // highlight opens on the CURRENT mode (resetKey = open), so Enter-on-open
  // is a no-op re-apply rather than a surprise change.
  const nav = useListNavigation({
    count: options.length,
    initialIndex: Math.max(0, options.findIndex(option => option.value === currentValue)),
    resetKey: open,
    isDisabled: index => Boolean(options[index]?.disabled) || !isAgent,
    onActivate: index => {
      const option = options[index]
      if (option) pick(option.value)
    },
    idPrefix: 'agent-view-mode',
  })
  const cursor = options[nav.index]?.value ?? currentValue

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
        // A focused footer button owns its own Enter (#867) — enforced inside
        // useListNavigation with the same focusedControlOwnsEnter predicate.
        onKeyDown={nav.onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Agent View Mode</DialogTitle>
          <DialogDescription>
            {isAgent
              ? `${provider.name} session`
              : 'Only agent sessions can override the view mode.'}
          </DialogDescription>
        </DialogHeader>

        {/* Roving focus: rows out of the tab order need the highlight ANNOUNCED
            rather than focused, or a screen reader hears nothing as the arrows
            move (#867 review). */}
        <div className="px-4 py-3">
        <div
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Agent view mode"
          aria-activedescendant={nav.activeId}
          className="rounded-slab overflow-hidden border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {options.map((option, index) => {
            const selected = option.value === currentValue
            const focused = option.value === cursor
            const disabled = option.disabled || !isAgent
            return (
              <button
                key={option.value}
                type="button"
                {...nav.getItemProps(index)}
                role="option"
                aria-selected={selected}
                // Out of the tab order, with the arrow-driven highlight the
                // only selection signal (#867, same as #862). A Tab-focused
                // row can diverge from that highlight, and Space clicks the
                // FOCUSED one — so the user would act on a row other than the
                // one the dialog is showing as chosen, whatever Enter does.
                tabIndex={-1}
                // (Click-without-focus-theft — `tabIndex={-1}` does not stop
                // Chromium focusing a clicked button, and a focused row owns
                // the next Enter — now comes from getItemProps' onMouseDown.)
                disabled={disabled}
                className={`
                  w-full text-left px-3 py-2 border-b border-l-2 border-border last:border-b-0
                  ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent'}
                  ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-row-hover-bg cursor-pointer'}
                `}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-medium text-ink">
                    {option.label}
                  </span>
                  {selected && (
                    <span className="text-[10px] uppercase tracking-wider text-accent">
                      Current
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-muted leading-snug">
                  {option.description}
                </div>
              </button>
            )
          })}
        </div>

        </div>

        {/* Apply exists so Enter's meaning is visible on a button (plan H2)
            and a mouse user has an explicit commit besides clicking a row.
            confirmOnEnter={false}: the list already owns Enter. */}
        <DialogActions
          confirmLabel="Apply"
          onConfirm={() => pick(cursor)}
          onCancel={onClose}
          confirmOnEnter={false}
          confirmDisabled={!isAgent || Boolean(options[nav.index]?.disabled)}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}

function labelForGlobalMode(mode: AgentViewMode): string {
  switch (mode) {
    case 'agent':
      return 'Agent'
    case 'terminal':
      return 'Terminal'
    case 'hybrid':
      return 'Hybrid'
  }
}
