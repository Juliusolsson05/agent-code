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
function foldClaude(runtime: SessionRuntime, events: Record<string, unknown>[]): SessionRuntime {
  let semantic = runtime.semantic
  for (const event of events) semantic = foldSemanticEvent(semantic, event, 'claude')
  return { ...runtime, semantic }
}

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

  it('follows streaming semantic text as the newest message and leaves thinking out', () => {
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
      { type: 'block_started', turnId: 'msg_live', blockIndex: 1, kind: 'text', source: 'proxy' },
      {
        type: 'text_delta',
        turnId: 'msg_live',
        blockIndex: 1,
        textDelta: 'Streaming answer so far',
        textSoFar: 'Streaming answer so far',
        source: 'proxy',
      },
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
