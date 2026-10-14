import { useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import { useHermesConnections } from '@renderer/features/hermes-chat/useHermesConnections'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { sidekickPlace } from '@renderer/features/sidekick/actions/useSidekickActions'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickSummaries } from '@renderer/features/sidekick/state/sidekickIndexStore'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { AGENT_PROVIDER_CHOICES, filterAgentProviderChoices, providerChoiceLabel } from '@renderer/workspace/providerChoices'
import type { AgentProviderChoice } from '@renderer/workspace/providerChoices'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SidekickSummary } from '@shared/sidekicks/types'
import { isAgentProviderKind } from '@shared/types/providerKind'
import type { HermesConnectionInfo } from '@shared/hermes/types'

// The Sidekick Picker (#1493): lists ONLY sidekicks — never lane agents — and
// creates new ones by kind. Built on the shared list primitive
// (useListNavigation, "the ONE implementation") inside a Dialog, the
// ProviderSwitchPickerModal pattern: the listbox owns focus, rows are not
// tab stops, Enter activates the highlight, ⌘⌫ removes.

type Row =
  | { kind: 'sidekick'; summary: SidekickSummary }
  | { kind: 'new'; choice: AgentProviderChoice; disabledReason: string | null }

/**
 * New Sidekick rows, Hermes first when it can actually connect (plan
 * Decision 5). WHY disabled-with-a-reason rather than hidden when no
 * connection is signed in: the user asked for Hermes to be first-class here;
 * a missing row would read as "Hermes is not supported", while a disabled
 * row says exactly what to do. Exported for the picker test.
 */
export function newSidekickChoices(
  choices: readonly AgentProviderChoice[],
  hermes: readonly HermesConnectionInfo[] | null,
): Array<{ choice: AgentProviderChoice; disabledReason: string | null }> {
  const hermesReady = (hermes ?? []).some(connection => connection.state === 'ready')
  const hermesSignedIn = (hermes ?? []).some(connection => connection.state === 'ready' || connection.state === 'unreachable')
  const rows = choices.map(choice => ({
    choice,
    disabledReason: choice.kind === 'hermes' && !hermesSignedIn ? 'Sign in under Settings → Hermes' : null,
  }))
  const hermesRows = rows.filter(row => row.choice.kind === 'hermes')
  const others = rows.filter(row => row.choice.kind !== 'hermes')
  return hermesReady ? [...hermesRows, ...others] : [...others, ...hermesRows]
}

export function SidekickPicker({ workspace, actions }: { workspace: Workspace; actions: SidekickActions }) {
  const open = useAppStore(state => state.sidekickPickerOpen)
  const mode = useAppStore(state => state.sidekickPickerMode)
  const close = useAppStore(state => state.closeSidekickPicker)
  const names = useAppStore(state => state.workspaceAgentNames)
  const namesEnabled = useAppStore(state => state.settings.agentNamesEnabled)
  const { showToast } = useGlobalToast()
  const listRef = useRef<HTMLDivElement | null>(null)
  const summaries = useSidekickSummaries()
  const enabledKinds = useEnabledAgentProviderKinds()
  const hermes = useHermesConnections(open)

  const rows: Row[] = useMemo(() => {
    const sidekicks = [...summaries]
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(summary => ({ kind: 'sidekick' as const, summary }))
    const creatable = newSidekickChoices(filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledKinds), hermes)
      .map(entry => ({ kind: 'new' as const, ...entry }))
    return [...sidekicks, ...creatable]
  }, [enabledKinds, hermes, summaries])
  const firstNewIndex = rows.findIndex(row => row.kind === 'new')

  const activate = async (row: Row) => {
    close()
    try {
      if (row.kind === 'sidekick') {
        workspace.setSidekickPanel({ open: true, sidekickId: row.summary.id })
        useAppStore.getState().setKeyboardRegion('sidekick')
        return
      }
      if (row.disabledReason) {
        showToast(row.disabledReason)
        return
      }
      await actions.createSidekick({ kind: row.choice.kind as never, providerRuntime: row.choice.providerRuntime })
      useAppStore.getState().setKeyboardRegion('sidekick')
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  const remove = async (row: Row | undefined) => {
    if (!row || row.kind !== 'sidekick') return
    const confirmed = await requestConfirm({
      title: 'Remove Sidekick',
      description: 'Its process stops and it leaves the Sidekick index. The conversation stays in Conversations.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!confirmed) return
    try {
      await actions.removeSidekick(row.summary.id)
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  const nav = useListNavigation({
    count: rows.length,
    resetKey: `${open}:${mode}`,
    initialIndex: mode === 'create' && firstNewIndex >= 0 ? firstNewIndex : 0,
    onActivate: index => {
      const row = rows[index]
      if (row) void activate(row)
    },
    idPrefix: 'sidekick-picker-row',
  })

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogContent
        onOpenAutoFocus={event => {
          event.preventDefault()
          listRef.current?.focus()
        }}
        onKeyDown={event => {
          if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void remove(rows[nav.index])
            return
          }
          nav.onKeyDown(event)
        }}
      >
        <DialogHeader>
          <DialogTitle>Sidekicks</DialogTitle>
          <DialogDescription>Global agents in the Sidekick panel. They start in your home folder and belong to no project.</DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3">
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="Sidekicks"
            aria-activedescendant={nav.activeId}
            className="max-h-[50vh] overflow-auto rounded-slab border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            {rows.map((row, index) => {
              const focused = index === nav.index
              const isFirstNew = index === firstNewIndex
              return (
                <div key={row.kind === 'sidekick' ? row.summary.id : `new:${row.choice.kind}:${row.choice.providerRuntime ?? ''}`}>
                  {isFirstNew ? (
                    <div className="border-b border-border bg-surface px-3 py-1 text-[10px] uppercase tracking-wider text-muted select-none">New Sidekick</div>
                  ) : null}
                  <button
                    type="button"
                    {...nav.getItemProps(index)}
                    role="option"
                    aria-selected={focused}
                    aria-disabled={row.kind === 'new' && row.disabledReason ? true : undefined}
                    tabIndex={-1}
                    className={`w-full border-b border-l-2 border-border px-3 py-2 text-left last:border-b-0 cursor-pointer ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent hover:bg-row-hover-bg'}`}
                  >
                    {row.kind === 'sidekick'
                      ? <SidekickRow summary={row.summary} name={namesEnabled && row.summary.agentNameId ? names[row.summary.agentNameId] ?? null : null} here={sidekickPlace(workspace.state.sessions, row.summary.id).kind === 'here'} />
                      : (
                        <>
                          <div className={`text-[12px] font-medium ${row.disabledReason ? 'text-muted' : 'text-ink'}`}>{row.choice.label}</div>
                          <div className="mt-0.5 text-[11px] text-muted">{row.disabledReason ?? row.choice.description}</div>
                        </>
                      )}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
        <DialogActions
          confirmLabel="Open"
          onConfirm={() => { const row = rows[nav.index]; if (row) void activate(row) }}
          onCancel={close}
          confirmOnEnter={false}
          confirmDisabled={rows.length === 0}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }, { keys: ['Cmd', 'Backspace'], label: 'remove' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}

function SidekickRow({ summary, name, here }: { summary: SidekickSummary; name: string | null; here: boolean }) {
  const kindLabel = summary.kind && isAgentProviderKind(summary.kind)
    ? providerChoiceLabel(summary.kind, summary.providerRuntime as never)
    : 'Agent'
  const where = here ? 'here' : summary.liveWindowId ? 'in another window' : 'asleep'
  return (
    <>
      <div className="text-[12px] font-medium text-ink">{name ?? summary.title ?? kindLabel}</div>
      <div className="mt-0.5 text-[11px] text-muted">{kindLabel} · {where} · {relativeTime(summary.lastActiveAt)}</div>
    </>
  )
}

function relativeTime(at: number): string {
  if (!at) return 'never used'
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
