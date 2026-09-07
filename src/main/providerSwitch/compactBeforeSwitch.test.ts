import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationDocument, ConversationEntry } from 'agent-transcript-parser'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  locate: vi.fn(),
  stat: vi.fn(),
}))

// `read` and `readAt` share one mock so the call count below means "decodes",
// whichever entry point the implementation chose for a given decode.
vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter: (provider: string) => provider === 'opencode'
    ? { provider, read: mocks.read }
    : {
        provider,
        read: mocks.read,
        readAt: mocks.read,
        locate: mocks.locate,
      },
}))

// The wait loop stats the located transcript to decide whether a decode is
// worth paying for. Tests drive that gate through this mock; the default
// (rejecting stat) means "unknown", which keeps the decode-every-cooldown
// behaviour the pre-existing contracts below were written against.
//
// Only `stat` is replaced. The rest of the module has to stay real because the
// Stage 0 fixture loader reads its `source.jsonl` files with `readFile`, and a
// whole-module factory would leave that export undefined — which is a confusing
// failure to debug from inside an unrelated wait-loop test.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  stat: mocks.stat,
}))

// WHY the poll delay advances fake time instead of sleeping: the contracts
// below are about WHEN the implementation decodes (unchanged file → no
// decode, changed file → one decode per cooldown, last-second change → one
// final decode before the 300 s deadline). With fake timers every tick is
// deterministic and the whole file runs in milliseconds, including the
// five-minute timeout case.
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  },
}))

import { compactSourceBeforeSwitch } from './compactBeforeSwitch.js'
import { loadFixtureConversation } from './testing/fixtureConversations.js'

const T0 = 1_700_000_000_000

// The exact wrapper Claude Code puts around every persisted compaction summary
// (vendor/claude-code-src/full/services/compact/prompt.ts getCompactUserSummaryMessage).
// It matters here because it is what pushes the limit text ~150 characters into
// the carrier, which is why the parser's rate-limit guard matches at any line
// start rather than at position 0.
const CLAUDE_CONTINUATION_PREAMBLE = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'

// WHY this text is assembled here instead of read out of
// `claude-sequence-rate-limit`, which is the fixture that recorded the hazard:
// redaction replaces every private scalar with the string "fixture text", so
// the fixture's own limit message decodes as "fixture text" and would not be
// rejected by anything. The census (docs/decomposition/evidence/provider-switch/
// census.md, "what does not survive redaction") keeps the observed TEMPLATE for
// this reason, and this is that template behind the real preamble — the shape
// Task 1 pinned `compactionAvailability` against. The fixture is still used
// below for the api_error case, where the classification survives redaction.
const RATE_LIMIT_CARRIER = [
  CLAUDE_CONTINUATION_PREAMBLE,
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets <time> (<timezone>)",
].join('\n\n')

describe('compactSourceBeforeSwitch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    vi.clearAllMocks()
    mocks.read.mockReset()
    mocks.locate.mockReset()
    mocks.locate.mockResolvedValue('/project/provider-session.jsonl')
    mocks.stat.mockReset()
    mocks.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns only after the live provider persists a new native summary', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    const manager = claudeManager()

    await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('local-session', '/compact')
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the provider rejects the compaction command', async () => {
    mocks.read.mockResolvedValueOnce(conversation([]))
    const manager = {
      getSessionKind: vi.fn(() => 'codex'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({
        ok: false,
        message: 'composer unavailable',
      })),
    }

    await expect(compactSourceBeforeSwitch(manager as never, codexRequest(), requiresCompactionPlan()))
      .rejects.toThrow('composer unavailable')
    expect(mocks.read).toHaveBeenCalledOnce()
  })

  it('asks compacted Codex for a plaintext handoff instead of copying encrypted compaction', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([codexCompaction(12)], 'codex'))
      .mockResolvedValueOnce(conversation([
        codexCompaction(12),
        assistant('portable work summary', 14),
        codexTurnComplete('portable work summary', 15),
      ], 'codex'))
    const manager = codexManager()
    const onPortableSummary = vi.fn()

    const result = await compactSourceBeforeSwitch(
      manager as never,
      codexRequest(),
      requiresCompactionPlan(),
      onPortableSummary,
    )

    expect(onPortableSummary).toHaveBeenCalledOnce()
    expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(2)
    expect(manager.deliverPromptToAgent).toHaveBeenNthCalledWith(1, 'local-session', '/compact')
    expect(manager.deliverPromptToAgent).toHaveBeenNthCalledWith(
      2,
      'local-session',
      expect.stringContaining('portable handoff summary'),
    )
    expect(result.entries).toEqual([expect.objectContaining({
      kind: 'compaction',
      summary: 'portable work summary',
    })])
  })

  it('waits for the Claude summary carrier instead of accepting its boundary placeholder', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([{
        ...compaction('Conversation compacted', 12),
        summarySource: 'boundary' as const,
      }]))
      .mockResolvedValueOnce(conversation([{
        ...compaction('Detailed provider-authored summary', 12),
        summarySource: 'carrier' as const,
      }]))
    const manager = claudeManager()

    const result = await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(result.entries[0]).toMatchObject({
      kind: 'compaction',
      summary: 'Detailed provider-authored summary',
    })
  })

  it('reuses an existing Codex native compaction without compacting twice', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([codexCompaction(12)], 'codex'))
      .mockResolvedValueOnce(conversation([
        codexCompaction(12),
        assistant('portable work summary', 14),
        codexTurnComplete('portable work summary', 15),
      ], 'codex'))
    const manager = codexManager()

    await compactSourceBeforeSwitch(manager as never, codexRequest(), requiresPortableHandoffPlan())

    expect(manager.deliverPromptToAgent).toHaveBeenCalledOnce()
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalledWith('local-session', '/compact')
  })

  it('uses completed OpenCode exports for a portable handoff without requiring a file path', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([], 'opencode'))
      .mockResolvedValueOnce(conversation([
        opencodeAssistant('portable OpenCode summary', 3),
      ], 'opencode'))
    const manager = opencodeManager()
    const onPortableSummary = vi.fn()

    const result = await compactSourceBeforeSwitch(
      manager as never,
      opencodeRequest(),
      requiresCompactionPlan(),
      onPortableSummary,
    )

    expect(onPortableSummary).toHaveBeenCalledOnce()
    expect(manager.deliverPromptToAgent).toHaveBeenCalledOnce()
    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith(
      'local-session',
      expect.stringContaining('portable handoff summary'),
    )
    expect(mocks.locate).not.toHaveBeenCalled()
    expect(result.entries).toEqual([expect.objectContaining({
      kind: 'compaction',
      summary: 'portable OpenCode summary',
    })])
  })

  // The contracts below protect #720: the wait used to decode the whole source
  // transcript on every 250 ms tick (a tree walk plus a 100 MB parse for long
  // Codex rollouts) and pin the decoded documents for the whole wait. Each
  // records the fake-clock time of every decode, so the assertions are about
  // WHEN decodes happen, not merely how many.

  it('locates the transcript once and does not decode while the file is unchanged', async () => {
    const decodeTimes = recordDecodeTimes(
      conversation([]),
      conversation([]),
      conversation([]),
      conversation([compaction('provider-authored summary', 12)]),
    )
    // Unchanged for the first ten ticks (2.5 s), then growing on every tick.
    let statCalls = 0
    mocks.stat.mockImplementation(async () => (++statCalls <= 11 ? fileInfo(100, 1) : fileInfo(100 + statCalls, statCalls)))
    const manager = claudeManager()

    await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(mocks.locate).toHaveBeenCalledOnce()
    expect(mocks.locate).toHaveBeenCalledWith('/project', 'provider-session')
    // before-fingerprint read, the first poll, then one decode per cooldown
    // once the file starts moving.
    expect(decodeTimes).toHaveLength(4)
    // The first poll decodes immediately; the second waits for the file to
    // move, which the stat script schedules 2.5 s later — far beyond the 1 s
    // cooldown, so only the stat gate can explain the gap.
    expect(decodeTimes[2]! - decodeTimes[1]!).toBeGreaterThanOrEqual(2_500)
    expect(decodeTimes[3]! - decodeTimes[2]!).toBeGreaterThanOrEqual(1_000)
  })

  it('rate-limits decoding while the source keeps appending', async () => {
    const decodeTimes = recordDecodeTimes(
      conversation([]),
      conversation([]),
      conversation([]),
      conversation([compaction('provider-authored summary', 12)]),
    )
    // Every tick reports growth; only the cooled ticks may decode.
    let size = 0
    mocks.stat.mockImplementation(async () => fileInfo((size += 1), size))
    const manager = claudeManager()

    await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(decodeTimes).toHaveLength(4)
    expect(decodeTimes[2]! - decodeTimes[1]!).toBeGreaterThanOrEqual(1_000)
    expect(decodeTimes[2]! - decodeTimes[1]!).toBeLessThan(1_500)
    expect(decodeTimes[3]! - decodeTimes[2]!).toBeGreaterThanOrEqual(1_000)
    expect(decodeTimes[3]! - decodeTimes[2]!).toBeLessThan(1_500)
  })

  it('decodes again after a transient read error even when the file did not move', async () => {
    const decodeTimes: number[] = []
    mocks.read
      .mockImplementationOnce(async () => { decodeTimes.push(Date.now()); return conversation([]) })
      .mockImplementationOnce(async () => { decodeTimes.push(Date.now()); throw new Error('caught between bytes') })
      .mockImplementationOnce(async () => {
        decodeTimes.push(Date.now())
        return conversation([compaction('provider-authored summary', 12)])
      })
    mocks.stat.mockResolvedValue(fileInfo(100, 1))
    const manager = claudeManager()

    const result = await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(decodeTimes).toHaveLength(3)
    expect(decodeTimes[2]! - decodeTimes[1]!).toBeGreaterThanOrEqual(1_000)
    expect(result.entries[0]).toMatchObject({ kind: 'compaction' })
  })

  it('still decodes a change that lands inside the final cooldown before the deadline', async () => {
    // The file moves at T+299.25 s (decoded, not yet terminal) and again at
    // T+299.5 s — inside the cooldown, with no cooled tick left before the
    // 300 s deadline. The wait must spend one more decode on it rather than
    // fail a switch whose source was already irreversibly compacted.
    const start = T0
    mocks.read.mockImplementation(async () => (
      Date.now() >= start + 300_000
        ? conversation([compaction('provider-authored summary', 12)])
        : conversation([])
    ))
    mocks.stat.mockImplementation(async () => {
      const elapsed = Date.now() - start
      if (elapsed < 299_250) return fileInfo(100, 1)
      if (elapsed < 299_500) return fileInfo(200, 2)
      return fileInfo(300, 3)
    })
    const manager = claudeManager()

    const result = await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(result.entries[0]).toMatchObject({ kind: 'compaction' })
    expect(Date.now() - start).toBeGreaterThanOrEqual(300_000)
  })

  // #820. Both cases are the same disaster in two shapes: `/compact` was
  // already delivered, so the source's history is on its way to being replaced,
  // and the provider answered with a usage limit instead of a summary. The wait
  // must fail while the pane is still on the source — every alternative
  // (accepting the limit text as a summary, or timing out) ends with a switch
  // that carried nothing and a source that can no longer show what was lost.

  it('fails immediately when the compaction carrier is a rate-limit message', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([{
        ...compaction(RATE_LIMIT_CARRIER, 900),
        summarySource: 'carrier' as const,
      }]))
    const manager = claudeManager()

    await expect(compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan()))
      .rejects.toThrow(/usage-limit message where its compaction summary should be/)
    // Two decodes, not a five-minute wait: the carrier is a definitive answer,
    // so there is nothing to keep polling for.
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('fails immediately when a rate-limit error lands after /compact was sent', async () => {
    // Here the fixture carries the evidence: `isApiErrorMessage: true` is a
    // boolean, so Claude decode still classifies these records as
    // `opaque`/`api_error` after redaction even though their text is gone.
    const rateLimited = await loadFixtureConversation('claude-sequence-rate-limit', 'claude')
    const apiErrors = rateLimited.entries
      .filter((entry): entry is Extract<ConversationEntry, { kind: 'opaque' }> => (
        entry.kind === 'opaque' && entry.nativeType === 'api_error'
      ))
      // Re-addressed past the baseline the wait captured, which is what
      // "landed after /compact" means to `findApiErrorAfterLine`.
      .map(entry => ({ ...entry, source: { ...entry.source, line: 901 } }))
    expect(apiErrors.length).toBeGreaterThan(0)
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation(apiErrors))
    const manager = claudeManager()

    await expect(compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan()))
      .rejects.toThrow(/reported a usage limit instead of compacting/)
  })

  it('re-locates the transcript when its pinned path stops resolving', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    // The first located file vanishes after the first poll decode; the
    // re-located one is where the summary lands.
    mocks.locate
      .mockResolvedValueOnce('/project/old.jsonl')
      .mockResolvedValueOnce('/project/new.jsonl')
    let statCalls = 0
    mocks.stat.mockImplementation(async (path: string) => {
      statCalls += 1
      if (path === '/project/old.jsonl' && statCalls > 1) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return fileInfo(100, 1)
    })
    const manager = claudeManager()

    await compactSourceBeforeSwitch(manager as never, claudeRequest(), requiresCompactionPlan())

    expect(mocks.locate).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })
})

function recordDecodeTimes(...results: ConversationDocument[]): number[] {
  const times: number[] = []
  for (const result of results) {
    mocks.read.mockImplementationOnce(async () => {
      times.push(Date.now())
      return result
    })
  }
  return times
}

function claudeManager() {
  return {
    getSessionKind: vi.fn(() => 'claude'),
    getSpawnCwd: vi.fn(() => '/project'),
    deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
  }
}

function codexManager() {
  return {
    getSessionKind: vi.fn(() => 'codex'),
    getSpawnCwd: vi.fn(() => '/project'),
    deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
  }
}

function opencodeManager() {
  return {
    getSessionKind: vi.fn(() => 'opencode'),
    getSpawnCwd: vi.fn(() => '/project'),
    deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
  }
}

function claudeRequest() {
  return {
    sourceKind: 'claude' as const,
    targetKind: 'codex' as const,
    sourceProviderSessionId: 'provider-session',
    sourceSessionId: 'local-session',
    cwd: '/project',
  }
}

function codexRequest() {
  return {
    sourceKind: 'codex' as const,
    targetKind: 'claude' as const,
    sourceProviderSessionId: 'provider-session',
    sourceSessionId: 'local-session',
    cwd: '/project',
  }
}

function opencodeRequest() {
  return {
    sourceKind: 'opencode' as const,
    targetKind: 'claude' as const,
    sourceProviderSessionId: 'provider-session',
    sourceSessionId: 'local-session',
    cwd: '/project',
  }
}

function fileInfo(size: number, mtimeMs: number) {
  return { size, mtimeMs }
}

function conversation(
  entries: ConversationDocument['entries'],
  sourceProvider: 'claude' | 'codex' | 'opencode' = 'claude',
): ConversationDocument {
  return {
    schemaVersion: 1 as const,
    sourceProvider,
    sourceSessionIds: ['provider-session'],
    entries,
  }
}

function opencodeAssistant(text: string, line: number) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    content: [{ kind: 'text' as const, text }],
    timestamp: '2026-09-03T12:00:00.000Z',
    source: {
      provider: 'opencode',
      line,
      raw: {
        info: { role: 'assistant', time: { created: 1, completed: 2 } },
        parts: [{ type: 'text', text }],
      },
      evidence: [],
    },
  }
}

function codexTurnComplete(summary: string, line: number) {
  return {
    kind: 'opaque' as const,
    nativeType: 'event_msg',
    timestamp: null,
    source: {
      provider: 'codex',
      line,
      raw: {
        type: 'event_msg',
        payload: { type: 'task_complete', last_agent_message: summary },
      },
      evidence: [],
    },
  }
}

function codexCompaction(line: number) {
  return {
    ...compaction('', line),
    summarySource: 'encrypted' as const,
    source: {
      provider: 'codex',
      line,
      raw: { type: 'compacted' },
      evidence: [],
    },
  }
}

function assistant(text: string, line: number) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    content: [{ kind: 'text' as const, text }],
    timestamp: null,
    source: { provider: 'codex', line, raw: {}, evidence: [] },
  }
}

function compaction(summary: string, line: number) {
  return {
    kind: 'compaction' as const,
    summary,
    timestamp: null,
    source: { provider: 'claude', line, raw: {}, evidence: [] },
  }
}

function requiresCompactionPlan() {
  return {
    kind: 'requires-compaction' as const,
    conversation: conversation([]),
    estimatedCharacters: 1_001,
    budgetCharacters: 1_000,
    overflowCharacters: 1,
  }
}

function requiresPortableHandoffPlan() {
  return {
    kind: 'requires-portable-handoff' as const,
    conversation: conversation([codexCompaction(12)], 'codex'),
    estimatedCharacters: 1,
    budgetCharacters: 1_000,
    compactionSourceLine: 12,
  }
}
