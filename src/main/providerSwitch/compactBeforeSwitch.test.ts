import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationDocument } from 'agent-transcript-parser'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  locate: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter: () => ({ read: mocks.read, locate: mocks.locate }),
}))

// The wait loop stats the located transcript to decide whether a decode is
// worth paying for. Tests drive that gate through this mock; the default
// (rejecting stat) means "unknown", which keeps the decode-every-cooldown
// behaviour the pre-existing contracts below were written against.
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }))

import { compactSourceBeforeSwitch } from './compactBeforeSwitch.js'

describe('compactSourceBeforeSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.locate.mockReset()
    mocks.locate.mockResolvedValue('/project/provider-session.jsonl')
    mocks.stat.mockReset()
    mocks.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  })

  it('returns only after the live provider persists a new native summary', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())

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

    await expect(compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'codex',
      targetKind: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())).rejects.toThrow('composer unavailable')
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
    const manager = {
      getSessionKind: vi.fn(() => 'codex'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }
    const onPortableSummary = vi.fn()

    const result = await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'codex',
      targetKind: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan(), onPortableSummary)

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
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    const result = await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())

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
    const manager = {
      getSessionKind: vi.fn(() => 'codex'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'codex',
      targetKind: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresPortableHandoffPlan())

    expect(manager.deliverPromptToAgent).toHaveBeenCalledOnce()
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalledWith('local-session', '/compact')
  })

  // The three contracts below protect #720: the wait used to decode the whole
  // source transcript on every 250 ms tick (a tree walk plus a 100 MB parse
  // for long Codex rollouts) and pin the decoded documents for the whole wait.

  it('locates the transcript once and skips decoding while the file is unchanged', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    // Three ticks see the same size/mtime, then the provider appends.
    mocks.stat
      .mockResolvedValueOnce(fileInfo(100, 1))
      .mockResolvedValueOnce(fileInfo(100, 1))
      .mockResolvedValueOnce(fileInfo(100, 1))
      .mockResolvedValue(fileInfo(240, 2))
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())

    expect(mocks.locate).toHaveBeenCalledOnce()
    expect(mocks.locate).toHaveBeenCalledWith('/project', 'provider-session')
    // before-fingerprint read + first poll + the poll after the file grew.
    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(mocks.stat.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('rate-limits decoding while the source keeps appending', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    // Every tick reports growth; only the cooled ticks may decode.
    let size = 0
    mocks.stat.mockImplementation(async () => fileInfo((size += 1), size))
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())

    expect(mocks.read).toHaveBeenCalledTimes(3)
    // At least three changed ticks passed between the two poll decodes.
    expect(mocks.stat.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('decodes again after a transient read error even when the file did not move', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockRejectedValueOnce(new Error('caught between bytes'))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    mocks.stat.mockResolvedValue(fileInfo(100, 1))
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    const result = await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, requiresCompactionPlan())

    expect(mocks.read).toHaveBeenCalledTimes(3)
    expect(result.entries[0]).toMatchObject({ kind: 'compaction' })
  })
})

function fileInfo(size: number, mtimeMs: number) {
  return { size, mtimeMs }
}

function conversation(
  entries: ConversationDocument['entries'],
  sourceProvider: 'claude' | 'codex' = 'claude',
): ConversationDocument {
  return {
    schemaVersion: 1 as const,
    sourceProvider,
    sourceSessionIds: ['provider-session'],
    entries,
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
