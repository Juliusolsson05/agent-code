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

function backendSnapshot(ready: boolean) {
  return { input: { ready, revision: 1, reason: ready ? 'ready' : 'provider-not-ready' } }
}

// The live-Claude manager every case below starts from. `getBackendSnapshot`
// reports ready by default so a case that is not about the readiness gate does
// not have to script it; the gate's own cases override it.
function claudeArrivalManager(overrides: Record<string, unknown> = {}) {
  return {
    getSessionKind: vi.fn(() => 'claude'),
    getBackendSnapshot: vi.fn(() => backendSnapshot(true)),
    getConditionsSnapshot: vi.fn(() => null),
    write: vi.fn(() => true),
    deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    ...overrides,
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
    // Readiness stays FALSE for the whole case, on purpose: a visible condition
    // blocks prompt input (claudeSession.ts derivePromptGateState +
    // conditionBlocksPromptInput), so this is what the real gate reports while
    // the prompt is up. A wait that required readiness first could never answer
    // it.
    const manager = claudeArrivalManager({
      getBackendSnapshot: vi.fn(() => backendSnapshot(false)),
      getConditionsSnapshot: vi.fn(() => visibleResumePrompt(1)),
      write,
    })
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
    const manager = claudeArrivalManager()
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
    const manager = claudeArrivalManager({
      deliverPromptToAgent: vi.fn(async () => ({ ok: false, message: 'composer unavailable' })),
    })
    mocks.read.mockResolvedValueOnce(rawConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({
      ok: false,
      message: 'Claude did not accept /compact: composer unavailable',
    })
  })

  it('reports rather than throws when the transcript cannot be read', async () => {
    // The baseline read used to sit above the try, so a rejected read escaped
    // as a rejected promise — on a switch that had already replaced the pane.
    // Every failure this module can produce has to be a report.
    const manager = claudeArrivalManager()
    mocks.read.mockRejectedValueOnce(new Error('caught between bytes'))

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({ ok: false, message: 'caught between bytes' })
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalled()
  })

  it('waits for input readiness before asking a still-restoring pane to compact', async () => {
    // Spec step 1. Without this gate the wait starts at spawn, so a pane that
    // is still replaying a 53 MB import gets `/compact` typed at a TUI that
    // cannot accept it.
    const getBackendSnapshot = vi.fn()
      .mockReturnValueOnce(backendSnapshot(false))
      .mockReturnValueOnce(backendSnapshot(false))
      .mockReturnValue(backendSnapshot(true))
    const manager = claudeArrivalManager({ getBackendSnapshot })
    mocks.read
      .mockResolvedValueOnce(rawConversation)
      .mockResolvedValueOnce(compactedConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({ ok: true, via: 'compact-command' })
    expect(getBackendSnapshot).toHaveBeenCalledTimes(3)
    // The delivery happened only after the third poll returned ready.
    expect(manager.deliverPromptToAgent.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(getBackendSnapshot.mock.invocationCallOrder[2]!)
  })

  it('answers a resume prompt that appears while input readiness is still false', async () => {
    // The case that forces readiness and the prompt into ONE wait: a visible
    // condition blocks prompt input, so this pane never reports ready until the
    // prompt is answered. A readiness-first gate would time out here — on
    // exactly the large, idle sessions the prompt (and this whole feature) is
    // for.
    const getConditionsSnapshot = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(visibleResumePrompt(1))
    const manager = claudeArrivalManager({
      getBackendSnapshot: vi.fn(() => backendSnapshot(false)),
      getConditionsSnapshot,
    })
    mocks.read
      .mockResolvedValueOnce(rawConversation)
      .mockResolvedValueOnce(compactedConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({ ok: true, via: 'resume-prompt' })
    expect(manager.write).toHaveBeenCalledTimes(2)
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalled()
  })

  it('reports a restore that never finishes instead of typing into a dead TUI', async () => {
    const manager = claudeArrivalManager({
      getBackendSnapshot: vi.fn(() => backendSnapshot(false)),
    })
    mocks.read.mockResolvedValueOnce(rawConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toMatchObject({ ok: false })
    expect((result as { message: string }).message)
      .toMatch(/did not finish restoring the imported history within 30s; the imported history is intact/)
    expect(manager.deliverPromptToAgent).not.toHaveBeenCalled()
    expect(manager.write).not.toHaveBeenCalled()
  })

  it('reports the pane dying during restore as a live pane, not an aborted switch', async () => {
    // `getSessionKind` passes the entry guard and then reports the pane gone,
    // the way `pollSourceUntil` re-checks liveness on every tick.
    const getSessionKind = vi.fn()
      .mockReturnValueOnce('claude')
      .mockReturnValue(null)
    const manager = claudeArrivalManager({
      getSessionKind,
      getBackendSnapshot: vi.fn(() => backendSnapshot(false)),
    })
    mocks.read.mockResolvedValueOnce(rawConversation)

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({
      ok: false,
      message: 'The new Claude session exited before it finished restoring; the pane keeps its full history.',
    })
  })

  it('reports a compaction API error with the arrival consequence, not "the switch was aborted"', async () => {
    // I1: the shared wait's default phrasing belongs to the SOURCE path, where
    // nothing has been replaced yet. Here the pane is already live on the
    // target, so "the switch was aborted before any pane was replaced" is
    // simply false — and the message is the only thing the user sees.
    const manager = claudeArrivalManager()
    mocks.read
      .mockResolvedValueOnce(rawConversation)
      .mockResolvedValueOnce({
        ...rawConversation,
        entries: [{
          kind: 'opaque' as const,
          nativeType: 'api_error',
          timestamp: null,
          source: {
            provider: 'claude',
            line: 900,
            raw: {
              type: 'assistant',
              isApiErrorMessage: true,
              error: 'rate_limit',
              message: { role: 'assistant', content: [{ type: 'text', text: 'fixture text' }] },
            },
            evidence: [],
          },
        }],
      })

    const result = await compactOnArrival(manager as never, arrivalRequest())

    expect(result).toEqual({
      ok: false,
      message: 'The claude provider reported a usage limit instead of compacting; the imported history is intact and you can run /compact by hand.',
    })
  })
})
