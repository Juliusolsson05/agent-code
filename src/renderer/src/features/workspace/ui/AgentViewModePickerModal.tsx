import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { AgentViewMode } from '@renderer/app-state/settings/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { AgentViewModeOverride, SessionId } from '@renderer/workspace/types'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const wasOpenRef = useRef(false)
  const meta = sessionId ? workspace.state.sessions[sessionId] : null
  const kind = meta?.kind ?? DEFAULT_PROVIDER
  const isAgent = isAgentProviderKind(kind)
  const provider = getRendererProviderCapabilities(isAgent ? kind : DEFAULT_PROVIDER)
  const nativeUnavailable = kind === 'opencode'
  const currentValue: PickerValue = meta?.agentViewModeOverride ?? 'default'
  const [cursor, setCursor] = useState<PickerValue>(currentValue)

  const options = useMemo<Option[]>(
    () => [
      {
        value: 'default',
        label: `Follow Global (${labelForGlobalMode(globalMode)})`,
        description: 'Use the app-wide Agent View Mode setting.',
      },
      {
        value: 'agent',
        label: 'Agent',
        description: 'Always show Agent Code rendering for this session.',
      },
      {
        value: 'terminal',
        label: 'Terminal',
        description: nativeUnavailable
          ? 'OpenCode native terminal mode is not available yet.'
          : 'Always show the provider native terminal for this session.',
        disabled: nativeUnavailable,
      },
    ],
    [globalMode, nativeUnavailable],
  )

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCursor(currentValue)
    }
    wasOpenRef.current = open
  }, [currentValue, open])

  const cursorIndex = Math.max(0, options.findIndex(option => option.value === cursor))
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
  const moveCursor = (delta: -1 | 1) => {
    const enabledIndexes = options
      .map((option, index) => ({ option, index }))
      .filter(item => !item.option.disabled)
      .map(item => item.index)
    if (enabledIndexes.length === 0) return
    const currentEnabledIndex = enabledIndexes.findIndex(index => index === cursorIndex)
    const fallback = delta > 0 ? 0 : enabledIndexes.length - 1
    const nextEnabledIndex = Math.max(
      0,
      Math.min(
        enabledIndexes.length - 1,
        (currentEnabledIndex < 0 ? fallback : currentEnabledIndex) + delta,
      ),
    )
    setCursor(options[enabledIndexes[nextEnabledIndex]]?.value ?? 'default')
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        ref={dialogRef}
        tabIndex={-1}
        onOpenAutoFocus={event => {
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            moveCursor(-1)
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            moveCursor(1)
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            pick(cursor)
          }
        }}
        className="w-[500px] max-w-[calc(100vw-64px)]"
      >
        <DialogHeader>
          <DialogTitle className="font-semibold">Agent View Mode</DialogTitle>
          <DialogDescription>
            {isAgent
              ? `${provider.name} session`
              : 'Only agent sessions can override the view mode.'}
          </DialogDescription>
        </DialogHeader>

        <div className="mx-4 my-4 border border-border bg-canvas">
          {options.map(option => {
            const selected = option.value === currentValue
            const focused = option.value === cursor
            const disabled = option.disabled || !isAgent
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onMouseEnter={() => setCursor(option.value)}
                onClick={() => pick(option.value)}
                className={`
                  w-full text-left px-3 py-3 border-b border-border last:border-b-0
                  ${focused ? 'bg-accent/12' : 'bg-transparent'}
                  ${disabled ? 'opacity-45 cursor-not-allowed' : 'hover:bg-surface cursor-pointer'}
                `}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-semibold text-ink">
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

        <DialogFooter>
          <Button
            type="button"
            onClick={onClose}
            variant="outline"
          >
            Cancel
          </Button>
        </DialogFooter>
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
