import { join } from 'node:path'

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// The OpenCode Terminal pane harness runs main's real SessionManager and
// forwarder. These are the modules it must not reach for real; each stand-in
// is explained in testing/opencodeTerminalMainStandIns.ts.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('@main/window/windowRegistry.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).windowRegistryStandIn)
vi.mock('@providers/registry.main.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).registryMainStandIn)
vi.mock('@main/workspaceDirectory.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).workspaceDirectoryStandIn)
vi.mock('@main/setup/toolchain.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).toolchainStandIn)
vi.mock('@main/performance/PerformanceService.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).performanceServiceStandIn)
vi.mock('@main/storage/feedDebugLog.js', async () => (await import('./testing/opencodeTerminalMainStandIns')).feedDebugLogStandIn)

import { createProjectionDatabase, loadDurableFixture, loadLiveFixture, playReplay } from 'opencode-terminal-headless/testing'

import { mapOpencodeMessageToFeedEntries } from '@providers/opencode/renderer/transcript/mapper'
import type { Entry } from '@shared/types/transcript'
import { extractLastAssistantText } from '@renderer/lib/copyAssistant'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import {
  commandAllowedByRenderedViewPolicy,
  getEffectiveAgentSurfaceForSession,
  type RenderedViewPolicy,
} from '@renderer/workspace/agentDisplayMode'
import { useHistoryActions } from '@renderer/workspace/hook/actions/history'
import { loadInitialHistoryForSession } from '@renderer/workspace/hook/actions/initialHistory'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'
import type { SessionId } from '@renderer/workspace/types'

import { opencodeTerminalPanes } from './testing/opencodeTerminalPane'
import { opencodeTerminalScope, paneMeta, SESSION_ID, waitFor } from './testing/opencodeTerminalScope'

// After a reload, a restart or a park, an OpenCode Terminal pane's
// conversation comes back from OpenCode's database through the real history
// source (what main's history loader delegates to) and the real renderer
// loaders. The pane stays a raw TUI; the history is for everything that reads
// `runtime.entries` (Copy Last Response, View Prompts, Dispatch titles, Agent
// Management, orchestration).

const scope = opencodeTerminalScope()
const panes = opencodeTerminalPanes(scope)

type Seen = { uuid: string | undefined; type: string; text: string | null }
const seen = (entries: readonly Entry[]): Seen[] =>
  entries.map(entry => ({ uuid: (entry as { uuid?: string }).uuid, type: entry.type, text: entryTextContent(entry) }))
const uuidOf = (entry: Entry): string | undefined => (entry as { uuid?: string }).uuid

describe('an OpenCode Terminal pane after a reload', () => {
  it('loads the conversation it showed live, and still never mounts the rendered feed', async () => {
    const recording = loadLiveFixture('queued.json')
    const live = await panes.startRecordedPane(recording)
    await playReplay(live.script, live.writer!, live.server)
    await waitFor(() => live.surfaces().lifecycle === 'completed', 'the live turn to complete')
    live.flushMain()
    const shownLive = seen(live.runtime().entries)

    const history = scope.serveHistoryFrom(live.dbPath!)
    const reloaded = scope.restoredPane(recording.sessionID, { ...emptyRuntime(), ...seedResumedRuntimeFields(undefined, paneMeta(recording.sessionID)) })
    // Seeded the way rehydrate seeds every durable agent.
    expect(reloaded.runtime().transcriptStatus).toBe('loading')
    await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: reloaded.meta, refs: reloaded.refs, setRuntimes: reloaded.setRuntimes })

    expect(history.loadInitialHistory).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'opencode', providerSessionId: recording.sessionID }))
    const runtime = reloaded.runtime()
    expect(runtime.transcriptStatus).toBe('ready')
    expect(runtime.hasOlderHistory).toBe(false)
    // Continuity: a reloaded agent reads exactly as it did live.
    expect(seen(runtime.entries)).toEqual(shownLive)
    // And against the recording itself, so a mapping gap shared by the live
    // and history paths cannot bless itself: both typed prompts, and the
    // answer OpenCode committed last (hand-read from the recording).
    const userTexts = runtime.entries.filter(entry => entry.type === 'user').map(entryTextContent)
    expect(userTexts).toEqual(expect.arrayContaining(recording.prompts.map(prompt => prompt.text)))
    expect(extractLastAssistantText(runtime.entries, 'opencode')).toBe('second')

    // The history is for the app, not for display: whatever the global view
    // mode, the TUI keeps the pane and no feed-only command appears.
    for (const globalMode of ['agent', 'hybrid', 'terminal'] as const) {
      expect(getEffectiveAgentSurfaceForSession({ kind: 'opencode', providerRuntime: 'terminal', globalMode, override: undefined, runtime })).toBe('terminal')
    }
    const feedPolicies: RenderedViewPolicy[] = [
      { kind: 'requires-rendered-feed' },
      { kind: 'opens-rendered-feed' },
      { kind: 'leases-rendered-feed', feature: 'copy-assistant-message' },
    ]
    for (const policy of feedPolicies) {
      expect(commandAllowedByRenderedViewPolicy({ policy, kind: 'opencode', providerRuntime: 'terminal', mode: 'agent', runtime })).toBe(false)
    }
  })

  it('adds nothing when history lands on a pane the live stream already filled', async () => {
    // The spawn race (history resolving after the first live entries) and
    // the MCP read's hydrate of a live pane both take this path.
    const recording = loadLiveFixture('plain.json')
    const live = await panes.startRecordedPane(recording)
    await playReplay(live.script, live.writer!, live.server)
    await waitFor(() => live.surfaces().lifecycle === 'completed', 'the live turn to complete')
    live.flushMain()
    const before = seen(live.runtime().entries)

    scope.serveHistoryFrom(live.dbPath!)
    await act(async () => {
      await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: live.meta, refs: live.refs, setRuntimes: live.setRuntimes })
    })

    expect(seen(live.runtime().entries)).toEqual(before)
    expect(live.runtime().transcriptStatus).toBe('ready')
  })
})

// Durable records shaped exactly as OpenCode's tables hold them.
const record = (id: string, role: 'user' | 'assistant', created: number, text: string) => ({
  info: { id, sessionID: 'ses_order', role, time: role === 'assistant' ? { created, completed: created + 1 } : { created }, ...(role === 'assistant' ? { finish: 'stop' } : {}) },
  parts: [{ id: `prt_${id}`, type: 'text', text }],
})

describe('where a history chunk lands in a pane that already holds entries', () => {
  // Timestamps are epoch ms, as OpenCode stores them; the mapper turns them
  // into the ISO timestamps the placement compares.
  const durable = [
    record('msg_a', 'user', 1_000, 'before the pane started'),
    record('msg_b', 'assistant', 2_000, 'old answer'),
    record('msg_c', 'user', 3_000, 'seen live'),
    record('msg_d', 'assistant', 4_000, 'answer seen live'),
    record('msg_e', 'user', 5_000, 'queued, not yet live'),
    record('msg_f', 'assistant', 6_000, 'its answer'),
    record('msg_g', 'user', 7_000, 'a later prompt'),
    record('msg_h', 'assistant', 8_000, 'the latest answer'),
  ]
  const liveWindow = (): Entry[] => [durable[2]!, durable[3]!].flatMap(item => mapOpencodeMessageToFeedEntries(item).entries)

  // `loadOlderHistory` answers like the store: the records before the cursor,
  // oldest first. (The real store's paging is covered below and in main.)
  const olderThan = (marker: string) => durable.slice(0, durable.findIndex(item => item.info.id === marker))

  async function loadChunk(chunk: typeof durable, runtime: Partial<SessionRuntime>) {
    const pane = scope.restoredPane('ses_order', { ...emptyRuntime(), entries: liveWindow(), ...runtime })
    const loadOlderHistory = vi.fn(async ({ beforeMarker }: { beforeMarker: string }) => ({ entries: olderThan(beforeMarker), hasMore: false }))
    scope.extendApi({
      loadInitialHistory: vi.fn(async () => ({ entries: chunk, hasMore: true, totalEntries: durable.length })),
      loadOlderHistory,
    })
    await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes })
    const updateRuntime = (id: SessionId, patch: Partial<SessionRuntime>) =>
      pane.setRuntimes(prev => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
    const { result } = renderHook(() => useHistoryActions(pane.setRuntimes, pane.refs, updateRuntime))
    const pageOlder = async () => {
      await act(async () => { await result.current.loadOlderHistory(SESSION_ID) })
      return loadOlderHistory.mock.lastCall?.[0].beforeMarker
    }
    return { runtime: pane.runtime, pageOlder }
  }

  it('places entries the live stream has not delivered yet after what it has, not above it', async () => {
    // The pane saw one turn live. OpenCode's tables also hold an older turn
    // (from before the pane started) and a newer one the live stream has not
    // delivered: a queued prompt, or a durable reader that stopped.
    const { runtime } = await loadChunk(durable.slice(0, 6), {})
    expect(runtime().entries.map(uuidOf)).toEqual(['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_e', 'msg_f'])
  })

  it("appends a strictly newer chunk that shares nothing with the pane, and keeps paging from the pane's oldest entry", async () => {
    // R5-F3: the database grew past one chunk while the pane's durable reader
    // was stopped, so the newest chunk (msg_g, msg_h) reaches back to nothing
    // the pane holds, and msg_e/msg_f fall in the gap between the two.
    const { runtime, pageOlder } = await loadChunk(durable.slice(6), { historyOldestMarker: 'msg_c', historyOldestOffset: null })
    expect(runtime().entries.map(uuidOf)).toEqual(['msg_c', 'msg_d', 'msg_g', 'msg_h'])
    // The latest turn is what every tail reader now sees.
    expect(extractLastAssistantText(runtime().entries, 'opencode')).toBe('the latest answer')

    // Older pages continue before the pane's own oldest entry. Had the cursor
    // moved to the chunk's head (msg_g), the next page would have brought the
    // gap (msg_e, msg_f) in ABOVE msg_c. The gap stays unloaded: rows missing
    // in order, which a later reload fills, rather than rows out of order.
    expect(await pageOlder()).toBe('msg_c')
    expect(runtime().entries.map(uuidOf)).toEqual(['msg_a', 'msg_b', 'msg_c', 'msg_d', 'msg_g', 'msg_h'])
  })

  it('still prepends an older chunk that shares nothing with the pane, the resume case every provider has', async () => {
    const { runtime } = await loadChunk(durable.slice(0, 2), { historyOldestMarker: 'msg_c', historyOldestOffset: null })
    expect(runtime().entries.map(uuidOf)).toEqual(['msg_a', 'msg_b', 'msg_c', 'msg_d'])
    expect(runtime().historyOldestMarker).toBe('msg_a')
  })
})

describe('paging an OpenCode session back through loadOlderHistory', () => {
  // The census's compaction session: 128 messages, tool calls, reasoning, a
  // compaction, same-millisecond ties. Read from the fixture by hand, two of
  // them produce no feed row: an all-synthetic user message (OpenCode's own
  // "continue" instruction after compaction) and a user message holding only
  // the compaction marker part. Every other message produces at least one.
  const FIXTURE = 'ses_5a9eb7438b655a5a8b1453adf276083c.json'
  const WITHOUT_ROWS = new Set(['msg_07418d135001EJDgblguR5sN8A', 'msg_07417fac8001Gk7VUZwMqNQBtw'])
  const INITIAL_LIMIT = 6
  const OLDER_PAGE = 40

  it('walks back to the first message by message id, in the database\'s order, with nothing duplicated', async () => {
    const fixture = loadDurableFixture(FIXTURE)
    const file = join(scope.dir(), 'compaction.db')
    createProjectionDatabase(fixture, file)
    const history = scope.serveHistoryFrom(file, { olderPageLimit: OLDER_PAGE })
    const sessionID = fixture.meta.sessionID
    const pane = scope.restoredPane(sessionID, { ...emptyRuntime(), ...seedResumedRuntimeFields(undefined, paneMeta(sessionID)) })

    await loadInitialHistoryForSession({ sessionId: SESSION_ID, meta: pane.meta, refs: pane.refs, setRuntimes: pane.setRuntimes, limit: INITIAL_LIMIT })
    expect(pane.runtime().hasOlderHistory).toBe(true)
    // The first page's cursor is its oldest message (the sixth-newest in the
    // fixture). OpenCode has no byte offsets, so none is kept.
    expect(pane.runtime().historyOldestMarker).toBe('msg_0742ed46b001yG0nqSlz76PtJF')
    expect(pane.runtime().historyOldestOffset).toBeNull()

    const updateRuntime = (id: SessionId, patch: Partial<SessionRuntime>) =>
      pane.setRuntimes(prev => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
    const { result } = renderHook(() => useHistoryActions(pane.setRuntimes, pane.refs, updateRuntime))
    const pagesNeeded = Math.ceil((fixture.messages.length - INITIAL_LIMIT) / OLDER_PAGE)
    for (let page = 0; page < pagesNeeded + 1 && pane.runtime().hasOlderHistory; page += 1) {
      const cursor = pane.runtime().historyOldestMarker
      await act(async () => { await result.current.loadOlderHistory(SESSION_ID) })
      expect(history.loadOlderHistory).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'opencode',
        providerSessionId: sessionID,
        beforeMarker: cursor,
        beforeOffset: undefined,
        limit: 200,
      }))
    }

    expect(history.loadOlderHistory).toHaveBeenCalledTimes(pagesNeeded)
    expect(pane.runtime().hasOlderHistory).toBe(false)
    const uuids = pane.runtime().entries.map(uuidOf)
    expect(new Set(uuids).size).toBe(uuids.length)
    const messageOrder = uuids
      .map(uuid => uuid?.split(':result:')[0])
      .filter((id, index, all) => id !== all[index - 1])
    expect(messageOrder).toEqual(fixture.messages.map(message => message.id).filter(id => !WITHOUT_ROWS.has(id)))
  })
})
