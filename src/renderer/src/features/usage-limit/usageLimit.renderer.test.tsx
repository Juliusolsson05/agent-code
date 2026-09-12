import { Feed } from '@renderer/features/feed/ui/Feed'
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Entry } from '@shared/types/transcript'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
import { ProviderContext } from '@renderer/features/feed/context'
import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { UsageLimitNoticeView } from '@providers/shared/renderer/protocols/usage-limit/UsageLimitNoticeView'
import { codexUsageLimitNotice } from '@providers/codex/renderer/adapters/usageLimitNotice'
import { claudeUsageLimitNotice } from '@providers/claude/renderer/adapters/usageLimitNotice'
import { useUsageLimitActions } from './useUsageLimitActions'
import fixture from '../../../../../testing/fixtures/provider-usage-limits/cases.json'

function host(kind: 'claude' | 'codex' = 'codex') {
  let runtime = { ...emptyRuntime(), sessionRunId: 'run-a' }
  const pane = 'notice-pane'
  const tab = { id: 't', focusedSessionId: 'different-pane', root: { type: 'leaf', sessionId: pane } }
  const workspace = {
    state: { detachedSessions: {}, sessions: { [pane]: { id: pane, kind, cwd: '/synthetic', providerSessionId: fixture.claude.sessionId } }, tabs: [tab] },
    readerMode: { tabId: 't', focusedSessionId: pane },
    getRuntime: () => runtime,
    get runtimes() { return { [pane]: runtime } },
    subscribeRuntime: () => () => {},
    showPaneToast: vi.fn(),
  } as unknown as Workspace
  return { workspace, pane, get runtime() { return runtime }, replaceRun: () => { runtime = { ...runtime, sessionRunId: 'run-b' } } }
}

describe('shared usage notice presentation and host actions', () => {
  it('preview dispatch renders the monthly card before compaction, with original text and fixed link', () => {
    const entry = { ...fixture.claude, isCompactSummary: true } as unknown as Entry
    render(<ProviderContext.Provider value="claude"><EntryRow entry={entry} /></ProviderContext.Provider>)
    expect(screen.getByRole('region', { name: 'Claude Code usage notice' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Monthly spend limit reached' })).toBeInTheDocument()
    expect(screen.queryByText('Conversation Summary')).not.toBeInTheDocument()
    expect(screen.getByText('Session reset reported for 2:10pm (America/Los_Angeles)')).toBeInTheDocument()
    expect(screen.getByText('The session reset does not raise the monthly spend cap.')).toBeInTheDocument()
    expect(screen.getByText(fixture.claude.message.content[0]!.text).closest('details')).toHaveTextContent('Original provider message')
    expect(screen.getByRole('link', { name: 'Manage usage ↗' })).toHaveAttribute('href', 'https://claude.ai/settings/usage?from=cc_cli_limit_message')
    expect(screen.queryByRole('button', { name: 'Switch provider…' })).not.toBeInTheDocument()
  })

  it('gives a member owner guidance and keeps provider markup inert', () => {
    const notice = codexUsageLimitNotice({ ...fixture.codex[2], message: '<script>danger()</script> [pay](https://untrusted.invalid)' })!
    const { container } = render(<UsageLimitNoticeView notice={notice} />)
    expect(screen.getByText('Ask a workspace owner to add credits.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByText(notice.originalMessage)).toBeInTheDocument()
    expect(screen.queryByText(/Reset reported/)).not.toBeInTheDocument()
  })

  it('opens Usage idempotently and targets the notice pane even when another pane is focused', () => {
    const h = host()
    const { result } = renderHook(() => useUsageLimitActions(h.workspace, h.pane, 'run-a'))
    const notice = codexUsageLimitNotice(fixture.codex[0])!
    render(<UsageLimitNoticeView notice={notice} sessionRunId="run-a" actions={result.current} />)
    useAppStore.setState({ usageModalOpen: true, providerSwitchPickerSessionId: null })
    fireEvent.click(screen.getByRole('button', { name: 'Usage overview' }))
    expect(useAppStore.getState().usageModalOpen).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Switch provider…' }))
    expect(useAppStore.getState().providerSwitchPickerSessionId).toBe(h.pane)
    useAppStore.setState({ providerSwitchPickerSessionId: null })
    // Deliberately no React rerender: catches the action-time race between an
    // already-painted button and a replacement backend in the same pane.
    h.replaceRun()
    fireEvent.click(screen.getByRole('button', { name: 'Switch provider…' }))
    expect(useAppStore.getState().providerSwitchPickerSessionId).toBeNull()
    expect(h.workspace.showPaneToast).toHaveBeenCalledWith(h.pane, expect.stringContaining('replaced agent'))
  })

  it('withholds switch for old runs, unrelated native transcripts, exits, and replaced providers', () => {
    const h = host('claude')
    const { result } = renderHook(() => useUsageLimitActions(h.workspace, h.pane, 'run-a'))
    const notice = claudeUsageLimitNotice(fixture.claude)!
    expect(result.current.canSwitchProvider(notice)).toBe(true)
    expect(result.current.canSwitchProvider(notice, 'old-run')).toBe(false)
    expect(result.current.canSwitchProvider({ ...notice, providerSessionId: 'archived-other-agent' })).toBe(false)
    expect(result.current.canSwitchProvider({ ...notice, provider: 'codex' })).toBe(false)
    h.runtime.exited = 0
    expect(result.current.canSwitchProvider(notice)).toBe(false)
  })

  it('Reader paints the ledger notice as a card, not quotable assistant Markdown', () => {
    const h = host()
    h.runtime.semantic = foldSemanticEvent(h.runtime.semantic, fixture.codex[0]!, 'codex', 'run-a')
    const { container } = render(<ReaderView workspace={h.workspace} />)
    expect(screen.getByRole('heading', { name: 'Usage limit reached' })).toBeInTheDocument()
    expect(container.querySelector('[data-renderer-id="shared.usage-limit"]')).toBeInTheDocument()
    expect(container.querySelector('[data-quote-scope]')).toBeNull()
  })

  it('the real Feed ledger hook retains notices on remount and does not duplicate unchanged input', () => {
    const h = host()
    h.runtime.semantic = foldSemanticEvent(h.runtime.semantic, fixture.codex[0]!, 'codex', 'run-a')
    const first = renderHook(() => useLedgerFeedItems(h.runtime, 'codex', h.pane))
    const plan = first.result.current
    first.rerender()
    expect(first.result.current).toBe(plan)
    expect(plan.items.map(item => item.type)).toEqual(['provider-notice'])
    first.unmount()
    const second = renderHook(() => useLedgerFeedItems(h.runtime, 'codex', h.pane))
    expect(second.result.current.items[0]?.key).toBe(plan.items[0]?.key)
  })
})


it('Feed paints the selected notice once without a fabricated assistant turn', () => {
  const h = host()
  h.runtime.semantic = foldSemanticEvent(h.runtime.semantic, fixture.codex[0]!, 'codex', 'run-a')
  function Harness() {
    const plan = useLedgerFeedItems(h.runtime, 'codex', h.pane)
    return <Feed sessionId={h.pane} provider="codex" entries={[]} renderItemsOverride={plan.items} />
  }
  const { container } = render(<Harness />)
  expect(container.querySelectorAll('[data-renderer-id="shared.usage-limit"]')).toHaveLength(1)
  expect(screen.getByRole('heading', { name: 'Usage limit reached' })).toBeInTheDocument()
  expect(screen.queryByText('waiting for Codex…')).not.toBeInTheDocument()
})

it('connected remote SessionView replaces raw fallback with a no-turn notice on the error-only update', async () => {
  const { act } = await import('@testing-library/react')
  const { TranscriptStore } = await import('../../../../remote-client/src/transcript/store')
  const { SessionView, EMPTY_MOBILE_COMPOSER_STATE } = await import('../../../../remote-client/src/ui/SessionView')
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const methods = {
    getSessionList: () => [{ sessionId: 'remote-cap', kind: 'codex', alive: true, cwd: '/synthetic', lastActivityAt: 0 }],
    getSttAvailability: () => false,
    getHistory: async () => ({ ok: false, error: 'No transcript yet' }),
  }
  const feed = new Proxy(methods, { get(target, key: string) {
    if (key in target) return target[key as keyof typeof target]
    return (cb: (value: unknown) => void) => {
      let set = listeners.get(key)
      if (!set) listeners.set(key, set = new Set())
      set.add(cb)
      return () => set.delete(cb)
    }
  } }) as unknown as import('../../../../remote-client/src/WebSocketSessionFeed').WebSocketSessionFeed
  const store = new TranscriptStore(feed)
  const emit = (name: string, value: unknown) => { for (const cb of listeners.get(name) ?? []) cb(value) }
  const view = render(<SessionView feed={feed} store={store} connection="open" sessionId="remote-cap" token="synthetic" onBack={() => {}} composerState={EMPTY_MOBILE_COMPOSER_STATE} updateComposerState={() => {}} />)
  try {
    await act(async () => { emit('onSessionScreen', { sessionId: 'remote-cap', recent: 'Raw terminal fallback' }) })
    expect(screen.getByText('Raw terminal fallback')).toBeInTheDocument()
    await act(async () => { emit('onSessionSemanticEvent', { sessionId: 'remote-cap', event: fixture.codex[0] }) })
    expect(screen.getByRole('heading', { name: 'Usage limit reached' })).toBeInTheDocument()
    expect(screen.queryByText('Raw terminal fallback')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch provider…' })).not.toBeInTheDocument()
  } finally { view.unmount(); store.dispose() }
})
