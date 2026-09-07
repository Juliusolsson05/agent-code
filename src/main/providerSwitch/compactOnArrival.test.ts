import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationDocument } from 'agent-transcript-parser'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  locate: vi.fn(),
  stat: vi.fn(),
}))

// Same three mocks, for the same reasons, as compactBeforeSwitch.test.ts: this
// file exercises the SAME wait loop (`waitForNewCompactionOn`) against the
// target session instead of the source, so anything that file had to fake to
// keep the loop off disk and off the wall clock has to be faked here too.
//
// `read` and `readAt` share one mock so a call count means "decodes", whichever
// entry point the implementation reached for.
vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter: (provider: string) => ({
    provider,
    read: mocks.read,
    readAt: mocks.read,
    locate: mocks.locate,
  }),
}))

// Only `stat` is replaced; the rest of node:fs/promises stays real because the
// Stage 0 fixture loader below reads its `source.jsonl` files with `readFile`.
// A whole-module factory would leave that export undefined and fail somewhere
// far away from the cause.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  stat: mocks.stat,
}))

// Fake time for both loops in this module: the resume-prompt poll (ten seconds
// of 250 ms ticks before it gives up) and the compaction wait (up to five
// minutes). Sleeping either for real would make this file the slowest in the
// suite and would say nothing extra about the contracts below.
vi.mock('node:timers/promises', () => ({
  setTimeout: async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  },
}))

import { compactOnArrival } from './compactOnArrival.js'
import { loadFixtureConversation } from './testing/fixtureConversations.js'

const T0 = 1_700_000_000_000

// WHY both fixtures are real Claude sequences and neither is hand-written:
//
// The pane under test is a Claude pane that has just been re-homed onto a
// projected transcript, so the "before" state is a Claude transcript with no
// compaction record yet (`claude-sequence-prompts`) and the "after" state is a
// Claude transcript whose latest boundary is a PORTABLE carrier
// (`claude-sequence-compaction`, fingerprint `claude:0:portable:…`). That pair
// is exactly what `waitForNewCompactionOn` has to distinguish: a new
// fingerprint whose availability is neither `incomplete` nor `rejected`.
//
// The two fixtures come from different recorded files, so the compacted one's
// entries carry LOWER source line numbers than the raw one's. That is
// harmless here — the only thing compared against the baseline line is the
// api_error hazard check, and neither fixture contains an api_error — but it
// is the reason this file never asserts on line ordering across the pair.
let rawConversation: ConversationDocument
let compactedConversation: ConversationDocument

beforeAll(async () => {
  rawConversation = await loadFixtureConversation('claude-sequence-prompts', 'claude')
  compactedConversation = await loadFixtureConversation('claude-sequence-compaction', 'claude')
})

function arrivalRequest() {
  return {
    sessionId: 'new',
    targetKind: 'claude' as const,
    cwd: '/project',
    providerSessionId: 'target',
  }
}

function visibleResumePrompt(selectedIndex: number) {
  return {
    provider: 'claude',
    ts: 1,
    conditions: {
      'claude.resume-prompt': {
        kind: 'claude.resume-prompt',
        state: { visible: true, selectedIndex },
        actions: [],
      },
    },
  }
}

describe('compactOnArrival', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    vi.clearAllMocks()
    mocks.read.mockReset()
    mocks.locate.mockReset()
    mocks.locate.mockResolvedValue('/project/target.jsonl')
    mocks.stat.mockReset()
    mocks.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers a visible Claude resume prompt with "Resume from summary" and waits for the carrier', async () => {
    const write = vi.fn(() => true)
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getConditionsSnapshot: vi.fn(() => visibleResumePrompt(1)),
      write,
      deliverPromptToAgent: vi.fn(),
    }
    mocks.read
      .mockResolvedValueOnce(rawConversation)
      .mockResolvedValueOnce(compactedConversation)
    const onProgress = vi.fn()

    const result = await compactOnArrival(manager as never, arrivalRequest(), onProgress)

    // The cursor sits on option 2; one Up lands on "Resume from summary
    // (recommended)" and Enter confirms it. Claude then runs its own
    // compaction, so no prompt is spent.
    expect(write).toHaveBeenNthCalledWith(1, 'new', '\x1b[A')
    expect(write).toHaveBeenNthCalledWith(2, 'new', '\r')
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, via: 'resume-prompt' })
    // Progress belongs to the NEW pane: the source session id this switch
    // started from is gone by the time arrival compaction runs.
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: 'new',
      phase: 'compacting',
    }))
  })

  it('delivers /compact when no resume prompt is visible', async () => {
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getConditionsSnapshot: vi.fn(() => null),
      write: vi.fn(() => true),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }
    mocks.read
      .mockResolvedValueOnce(rawConversation)
      .mockResolvedValueOnce(compactedConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('new', '/compact')
    expect(manager.write).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, via: 'compact-command' })
  })

  it('reports rather than throws when the target is not Claude', async () => {
    const manager = { getSessionKind: vi.fn(() => 'codex') }

    const result = await compactOnArrival(manager as never, {
      ...arrivalRequest(),
      targetKind: 'codex',
    })

    expect(result).toEqual({
      ok: false,
      message: 'Arrival compaction is only implemented for Claude targets.',
    })
    // Nothing was read: a non-Claude target is decided before any I/O, so a
    // Codex batch never pays for a decode it cannot use.
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('reports rather than throws when the pane no longer holds a live Claude session', async () => {
    const manager = { getSessionKind: vi.fn(() => null) }

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({
      ok: false,
      message: 'The new pane is not a live Claude session.',
    })
  })

  it('reports rather than throws when Claude refuses the /compact delivery', async () => {
    // The whole point of the result type: this runs AFTER the pane was
    // replaced, so a failure here must never propagate as an exception into
    // the caller that already committed the switch. The pane keeps its full
    // imported history and the user is told, once.
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getConditionsSnapshot: vi.fn(() => null),
      write: vi.fn(() => true),
      deliverPromptToAgent: vi.fn(async () => ({ ok: false, message: 'composer unavailable' })),
    }
    mocks.read.mockResolvedValueOnce(rawConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({
      ok: false,
      message: 'Claude did not accept /compact: composer unavailable',
    })
  })
})
