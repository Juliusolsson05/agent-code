import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import { APP_INTERACTION_OWNER_ATTRIBUTE } from '@renderer/lib/interaction-ownership'
import type { Entry } from '@shared/types/transcript'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ReaderView } from './ReaderView'

function assistantEntry(uuid: string, text: string): Entry {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: text },
  } as Entry
}

// Timestamped shapes for the live-turn tests. The ledger orders committed rows
// against semantic turns by time, so the committed transcript is dated well
// before the fold's Date.now() — exactly how a real session looks when the
// user opens Reader on an agent that has been working for a while.
const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

const datedUserEntry = (uuid: string, ms: number, text: string) =>
  ({
    uuid,
    type: 'user',
    timestamp: iso(ms),
    message: { role: 'user', content: text },
  }) as unknown as Entry

const datedAssistantEntry = (uuid: string, msgId: string, ms: number, text: string) =>
  ({
    uuid,
    type: 'assistant',
    timestamp: iso(ms),
    message: { id: msgId, role: 'assistant', content: text },
  }) as unknown as Entry

const COMMITTED_ANSWER = 'I will dispatch four agents to investigate the reader bug in parallel.'

function committedRuntime(): SessionRuntime {
  return {
    ...emptyRuntime(),
    entries: [
      datedUserEntry('u1', T, 'investigate the reader bug'),
      datedAssistantEntry('a1', 'msg_committed', T + 100, COMMITTED_ANSWER),
    ],
    lastJsonlEntryAt: T + 100,
  }
}

// Claude Code's CoordinatorTaskPanel, drawn BELOW the prompt footer while
// background agents run. Row format from
// vendor/claude-code-src/full/components/CoordinatorAgentStatus.tsx (MainLine:
// `${prefix}${BLACK_CIRCLE} main`, BLACK_CIRCLE = '⏺' on darwin; AgentLine:
// `${prefix}${bullet} ${description} ${PLAY_ICON} ${elapsed} · ↓ ${n} tokens`)
// with the literal descriptions reported in #855. Its `⏺ main` row is the one
// the screen scraper took for the start of an assistant block.
const BACKGROUND_AGENT_PANEL_SCREEN = [
  `⏺ ${COMMITTED_ANSWER}`,
  '',
  '⏺ 4 general-purpose agents launched (ctrl+o to expand)',
  '',
  '✻ Cogitating… (esc to interrupt)',
  '',
  '─'.repeat(100),
  '❯ ',
  '─'.repeat(100),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  '',
  '  ⏺ main',
  '  ◯ general-purpose  Comparing SessionList.ts copies ▶ 14m 41s · ↓ 550.2k tokens',
  '  ◯ general-purpose (+3)  Reading AgentTerminalLeaf status chrome ▶ 14m 24s · ↓ 309.7k tokens',
].join('\n')

// Drive the real semantic reducer with the event vocabulary the headless
// SemanticChannel emits, so the live-turn shape under test is the one
// production builds rather than a hand-assembled object that could drift.
//
// WHY Date.now is pinned per fold: the reducer stamps turn start/end times with
// Date.now(), and the ledger orders semantic turns against committed entries by
// those times. Pinning them keeps a multi-turn scenario in the order a real
// session produces instead of whatever the test machine's clock says.
function foldClaude(
  runtime: SessionRuntime,
  events: Record<string, unknown>[],
  nowMs: number = Date.now(),
): SessionRuntime {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs)
  try {
    let semantic = runtime.semantic
    for (const event of events) semantic = foldSemanticEvent(semantic, event, 'claude')
    return { ...runtime, semantic }
  } finally {
    clock.mockRestore()
  }
}

// One Claude proxy text block, in the order ClaudeProxyAdapter publishes it:
// every text_delta is followed by a turn-level turn_delta carrying the turn's
// aggregate text (ClaudeProxyAdapter: publishTextDelta, then applyDelta). The
// aggregate matters because the pre-#855 Reader read `currentTurn.text`, so a
// trace without it would make the old implementation look broken for the
// wrong reason.
function proxyTextBlock(
  turnId: string,
  blockIndex: number,
  text: string,
  turnText: string,
  opts: { complete?: boolean } = {},
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { type: 'block_started', turnId, blockIndex, kind: 'text', source: 'proxy' },
    { type: 'text_delta', turnId, blockIndex, textDelta: text, textSoFar: text, source: 'proxy' },
    { type: 'turn_delta', turnId, fullText: turnText, source: 'proxy' },
  ]
  if (opts.complete) {
    events.push({ type: 'block_completed', turnId, blockIndex, kind: 'text', text, source: 'proxy' })
  }
  return events
}

function proxyTextTurn(turnId: string, text: string, opts: { complete?: boolean } = {}) {
  const events: Record<string, unknown>[] = [
    { type: 'turn_started', turnId, role: 'assistant', source: 'proxy' },
    ...proxyTextBlock(turnId, 0, text, text, opts),
  ]
  if (opts.complete) events.push({ type: 'turn_completed', turnId, fullText: text, source: 'proxy' })
  return events
}

const pagerText = () => screen.getByText(/^\d+ \/ \d+$/).textContent

function makeReaderWorkspace(runtime: SessionRuntime = {
  ...emptyRuntime(),
  entries: [
    assistantEntry('older-message', 'Older answer'),
    assistantEntry('newer-message', 'Newer answer'),
  ],
}): Workspace {
  const tab = {
    id: 'tab-1',
    title: 'Project',
    focusedSessionId: 'session-1',
    root: { type: 'leaf' as const, sessionId: 'session-1' },
  }
  return {
    state: {
      activeTabId: tab.id,
      tabs: [tab],
      sessions: {
        'session-1': { cwd: '/project', title: 'Agent', kind: 'claude' },
      },
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
      gridRelatedSelections: {},
      dispatchMode: null,
    },
    activeTab: tab,
    dispatchMode: null,
    readerMode: { tabId: tab.id, focusedSessionId: 'session-1' },
    getRuntime: () => runtime,
    setReaderModeSession: vi.fn(),
  } as unknown as Workspace
}

function pressOptionArrow(key: 'ArrowUp' | 'ArrowDown'): void {
  fireEvent.keyDown(document, { altKey: true, code: key, key })
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('Reader history keyboard ownership', () => {
  it('keeps Option+Arrow history navigation inside Reader', () => {
    render(<ReaderView workspace={makeReaderWorkspace()} />)

    expect(screen.getByText('Newer answer')).toBeTruthy()
    pressOptionArrow('ArrowUp')
    expect(screen.getByText('Older answer')).toBeTruthy()
    pressOptionArrow('ArrowDown')
    expect(screen.getByText('Newer answer')).toBeTruthy()
  })

  it('yields history navigation to an app-owned modal above Reader', () => {
    render(<ReaderView workspace={makeReaderWorkspace()} />)
    const modalOwner = document.createElement('div')
    modalOwner.setAttribute(APP_INTERACTION_OWNER_ATTRIBUTE, 'app')
    document.body.append(modalOwner)

    pressOptionArrow('ArrowUp')

    expect(screen.getByText('Newer answer')).toBeTruthy()
    expect(screen.queryByText('Older answer')).toBeNull()
  })
})

describe('Reader content source', () => {
  it('never presents Claude background-agent panel rows as the live message (#855)', () => {
    // The exact #855 state: the agent is running (waiting on background
    // agents), no semantic text turn is open, and the terminal shows the task
    // panel. Reader used to scrape this screen whenever no semantic text was
    // streaming and painted "main ◯ general-purpose … tokens" as the answer.
    const runtime: SessionRuntime = {
      ...committedRuntime(),
      sessionStatus: 'running',
      screen: BACKGROUND_AGENT_PANEL_SCREEN,
      recentScreen: BACKGROUND_AGENT_PANEL_SCREEN,
    }

    render(<ReaderView workspace={makeReaderWorkspace(runtime)} />)

    expect(screen.getByText(COMMITTED_ANSWER)).toBeTruthy()
    expect(screen.queryByText(/general-purpose/)).toBeNull()
    expect(screen.getByText('1 / 1')).toBeTruthy()
  })

  it('shows streaming semantic text as the newest message and leaves thinking out', () => {
    const runtime = foldClaude({ ...committedRuntime(), sessionStatus: 'running' }, [
      { type: 'turn_started', turnId: 'msg_live', role: 'assistant', source: 'proxy' },
      { type: 'block_started', turnId: 'msg_live', blockIndex: 0, kind: 'thinking', source: 'proxy' },
      {
        type: 'thinking_delta',
        turnId: 'msg_live',
        blockIndex: 0,
        thinkingDelta: 'Weighing the options',
        thinkingSoFar: 'Weighing the options',
        source: 'proxy',
      },
      // The proxy completes a thinking block with `text: block.thinking`, so the
      // reasoning reaches `block.text`; only the prose classifier keeps it out.
      // Without this event the assertion below could not catch that filter
      // regressing (an unfinished thinking block has empty `text`).
      {
        type: 'block_completed',
        turnId: 'msg_live',
        blockIndex: 0,
        kind: 'thinking',
        text: 'Weighing the options',
        source: 'proxy',
      },
      ...proxyTextBlock('msg_live', 1, 'Streaming answer so far', 'Streaming answer so far'),
    ])

    render(<ReaderView workspace={makeReaderWorkspace(runtime)} />)

    expect(screen.getByText('Streaming answer so far')).toBeTruthy()
    expect(screen.queryByText(/Weighing the options/)).toBeNull()
    expect(screen.getByText('2 / 2')).toBeTruthy()
  })

  it('never shows a compaction synthesis turn', () => {
    // Claude Code's compaction call streams <analysis>/<summary> XML that is
    // not user-visible prose (#345). The ledger refuses it; Reader used to read
    // `currentTurn.text` directly and bypassed that refusal.
    const synthesis = '<analysis>private scratch</analysis>'
    const runtime = foldClaude({ ...committedRuntime(), sessionStatus: 'running' }, [
      {
        type: 'turn_started',
        turnId: 'msg_compact',
        role: 'assistant',
        source: 'proxy',
        isCompactionSynthesis: true,
      },
      { type: 'turn_delta', turnId: 'msg_compact', fullText: synthesis, source: 'proxy' },
      { type: 'block_started', turnId: 'msg_compact', blockIndex: 0, kind: 'text', source: 'proxy' },
      {
        type: 'text_delta',
        turnId: 'msg_compact',
        blockIndex: 0,
        textDelta: synthesis,
        textSoFar: synthesis,
        source: 'proxy',
      },
    ])

    render(<ReaderView workspace={makeReaderWorkspace(runtime)} />)

    expect(screen.queryByText(/private scratch/)).toBeNull()
    expect(screen.getByText(COMMITTED_ANSWER)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Reader keeps the user's place while the ledger reshapes the message list.
//
// Every scenario below came out of the PR #861 review, reproduced against the
// real fold -> adapter -> ledger -> ReaderView path. They exist because
// ledger-sourced messages change shape in ways the old screen-sourced
// `__live__` sentinel never did: a turn can grow a SECOND text page, and a
// finished-but-uncommitted message is a pageable semantic-history row whose id
// changes from `semantic-block:…` to `entry:…` when its JSONL lands.
// ---------------------------------------------------------------------------
describe('Reader keeps its place', () => {
  function liveTurnWithSecondBlock(base: SessionRuntime): SessionRuntime {
    return foldClaude(base, [
      { type: 'block_completed', turnId: 'msg_live', blockIndex: 0, kind: 'text', text: 'First live block', source: 'proxy' },
      {
        type: 'block_started',
        turnId: 'msg_live',
        blockIndex: 1,
        kind: 'tool_use',
        toolName: 'Edit',
        toolUseId: 'toolu_edit',
        source: 'proxy',
      },
      ...proxyTextBlock('msg_live', 2, 'Second live block', 'First live blockSecond live block'),
    ], T + 1_100)
  }

  function firstLiveBlock(): SessionRuntime {
    return foldClaude({ ...committedRuntime(), sessionStatus: 'running' }, [
      { type: 'turn_started', turnId: 'msg_live', role: 'assistant', source: 'proxy' },
      ...proxyTextBlock('msg_live', 0, 'First live block', 'First live block'),
    ], T + 1_000)
  }

  it('follows a live turn onto its next text block when the reader is on the newest message', () => {
    const first = firstLiveBlock()
    const view = render(<ReaderView workspace={makeReaderWorkspace(first)} />)
    expect(screen.getByText('First live block')).toBeTruthy()
    expect(pagerText()).toBe('2 / 2')

    view.rerender(<ReaderView workspace={makeReaderWorkspace(liveTurnWithSecondBlock(first))} />)

    expect(screen.getByText('Second live block')).toBeTruthy()
    expect(pagerText()).toBe('3 / 3')
  })

  it('stays on an older message the user chose while newer text streams in', () => {
    const first = firstLiveBlock()
    const view = render(<ReaderView workspace={makeReaderWorkspace(first)} />)
    pressOptionArrow('ArrowUp')
    expect(screen.getByText(COMMITTED_ANSWER)).toBeTruthy()

    view.rerender(<ReaderView workspace={makeReaderWorkspace(liveTurnWithSecondBlock(first))} />)

    expect(screen.getByText(COMMITTED_ANSWER)).toBeTruthy()
    expect(pagerText()).toBe('1 / 3')
  })

  it('keeps an older message selected when its transcript copy replaces the live copy', () => {
    // msg_2 finished on the proxy and sits in semantic history while its JSONL
    // line is still in flight (a soak bundle measured ~19s of that lag); msg_3
    // is streaming. The user pages back to msg_2, then its entry lands.
    const base: SessionRuntime = {
      ...committedRuntime(),
      sessionStatus: 'running',
    }
    const secondFinished = foldClaude(base, proxyTextTurn('msg_2', 'Second answer', { complete: true }), T + 1_000)
    const thirdStreaming = foldClaude(secondFinished, proxyTextTurn('msg_3', 'Third answer streaming'), T + 2_000)

    const view = render(<ReaderView workspace={makeReaderWorkspace(thirdStreaming)} />)
    expect(pagerText()).toBe('3 / 3')
    pressOptionArrow('ArrowUp')
    expect(screen.getByText('Second answer')).toBeTruthy()
    expect(pagerText()).toBe('2 / 3')

    const committed: SessionRuntime = {
      ...thirdStreaming,
      entries: [...thirdStreaming.entries, datedAssistantEntry('a2', 'msg_2', T + 1_000, 'Second answer')],
      lastJsonlEntryAt: T + 1_000,
    }
    view.rerender(<ReaderView workspace={makeReaderWorkspace(committed)} />)

    expect(screen.getByText('Second answer')).toBeTruthy()
    expect(pagerText()).toBe('2 / 3')
  })

  it('keeps the scroll position when a message finishes streaming and when its transcript copy lands', () => {
    const base: SessionRuntime = { ...committedRuntime(), sessionStatus: 'running' }
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the final answer.`).join('\n\n')
    const streaming = foldClaude(base, proxyTextTurn('msg_final', long), T + 1_000)
    const view = render(<ReaderView workspace={makeReaderWorkspace(streaming)} />)
    const scroller = document.querySelector('article')!.parentElement as HTMLDivElement

    // The user has scrolled into the middle of the answer.
    scroller.scrollTop = 777

    const finished = foldClaude(streaming, [
      { type: 'block_completed', turnId: 'msg_final', blockIndex: 0, kind: 'text', text: long, source: 'proxy' },
      { type: 'turn_completed', turnId: 'msg_final', fullText: long, source: 'proxy' },
    ], T + 1_500)
    view.rerender(<ReaderView workspace={makeReaderWorkspace(finished)} />)
    expect(scroller.scrollTop).toBe(777)

    scroller.scrollTop = 555
    const committed: SessionRuntime = {
      ...finished,
      entries: [...finished.entries, datedAssistantEntry('a_final', 'msg_final', T + 1_500, long)],
      lastJsonlEntryAt: T + 1_500,
    }
    view.rerender(<ReaderView workspace={makeReaderWorkspace(committed)} />)
    expect(scroller.scrollTop).toBe(555)
    expect(pagerText()).toBe('2 / 2')
  })
})
