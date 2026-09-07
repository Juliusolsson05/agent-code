import { beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateConversationCharacters } from 'agent-transcript-parser'
import type { ConversationDocument } from 'agent-transcript-parser'

const mocks = vi.hoisted(() => ({
  sourceRead: vi.fn(),
  targetProject: vi.fn(),
  targetWrite: vi.fn(),
  targetSessionId: vi.fn(),
  targetProfile: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000099',
}))

// WHY every registered provider resolves to the SAME mock pair instead of one
// hand-wired branch per kind: these tests are about the host's transaction
// order — what it plans, whether it ever spends a source turn, what it reports
// — and never about a provider's adapter. The old per-kind branches wired only
// the half each existing case happened to use (Claude had no `targetProfile`,
// Codex had a dead `read`), so adding the Codex -> Claude policy cases below
// would have meant editing three branches to say the same thing. Any provider
// can now be either end; the registry's "unknown provider throws" contract is
// still modelled, because switchProvider relies on it.
vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider !== 'claude' && provider !== 'codex' && provider !== 'opencode') {
      throw new Error(`No transcript engine adapter is registered for provider "${provider}".`)
    }
    return {
      provider,
      read: mocks.sourceRead,
      projectNativeResume: mocks.targetProject,
      write: mocks.targetWrite,
      sessionId: mocks.targetSessionId,
      targetProfile: mocks.targetProfile,
    }
  },
}))

// WHY the parser is NOT mocked while the engine is: the policy under test is
// "which planner outcome does the host ask for, and what does it do with the
// answer". A stubbed planner would let this file agree with a planner that does
// not exist, which is exactly the failure the Stage 0 fixtures were recorded to
// prevent. Real decode, real plan, mocked disk.
import { switchProvider } from './switchProvider.js'
import { loadFixtureConversation } from './testing/fixtureConversations.js'

const conversation = {
  schemaVersion: 1 as const,
  sourceProvider: 'claude',
  sourceSessionIds: ['source-session'],
  entries: [{
    kind: 'message' as const,
    role: 'user' as const,
    content: [{ kind: 'text' as const, text: 'hello' }],
    timestamp: '2026-07-20T12:00:00.000Z',
    source: { provider: 'claude', line: 0, raw: {}, evidence: [] },
  }],
}

const projection = {
  profile: 'native-resume' as const,
  targetProvider: 'codex',
  providerProfile: { id: 'test', provider: 'codex', evidence: {} },
  values: [{ type: 'session_meta', payload: { id: 'target-session' } }],
  report: {
    profile: 'native-resume' as const,
    sourceProvider: 'claude',
    targetProvider: 'codex',
    changes: [],
    counts: {
      preserved: 0,
      dropped: 0,
      demoted: 0,
      synthesized: 0,
      repaired: 0,
      retargeted: 0,
      opaque: 0,
    },
  },
}

// A Claude-target projection for the Codex -> Claude cases. Only the target
// provider and its report header differ from `projection`; nothing in
// switchProvider reads past `values`, which is what write()/sessionId() receive.
const claudeProjection = {
  ...projection,
  targetProvider: 'claude',
  providerProfile: { id: 'test', provider: 'claude', evidence: {} },
  report: {
    ...projection.report,
    sourceProvider: 'codex',
    targetProvider: 'claude',
  },
}

describe('switchProvider neutral hub integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sourceRead.mockResolvedValue(conversation)
    mocks.targetProject.mockResolvedValue(projection)
    mocks.targetSessionId.mockReturnValue('target-session')
    mocks.targetWrite.mockResolvedValue('/target/rollout.jsonl')
    mocks.targetProfile.mockResolvedValue({
      model: 'gpt-current',
      modelProvider: 'openai',
      budgetCharacters: 1_000,
    })
  })

  it('composes source and target adapters without selecting a provider pair translator', async () => {
    const result = await switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/default',
      sourceCwd: '/source',
      targetCwd: '/target',
    })

    expect(mocks.sourceRead).toHaveBeenCalledWith('/source', 'source-session')
    expect(mocks.targetProfile).toHaveBeenCalledWith('/target')
    expect(mocks.targetProject).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        cwd: '/target',
        targetSessionId: '00000000-0000-4000-8000-000000000099',
      }),
    )
    expect(mocks.targetWrite).toHaveBeenCalledWith('/target', projection.values)
    expect(result).toEqual({
      kind: 'switched',
      targetKind: 'codex',
      targetProviderSessionId: 'target-session',
      targetFilePath: '/target/rollout.jsonl',
      compactedBeforeSwitch: false,
      truncatedBeforeSwitch: false,
      strategy: 'native',
      shrinkSummary: null,
    })
  })

  it.each([
    ['claude', 'opencode'],
    ['opencode', 'codex'],
  ] as const)('routes the %s → %s edge through the same neutral hub', async (sourceKind, targetKind) => {
    const result = await switchProvider({
      sourceKind,
      targetKind,
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })

    expect(mocks.sourceRead).toHaveBeenCalledWith('/project', 'source-session')
    expect(mocks.targetProject).toHaveBeenCalledOnce()
    expect(mocks.targetWrite).toHaveBeenCalledOnce()
    expect(result.targetKind).toBe(targetKind)
  })

  // Opt-in only since Stage 3: the default policy never asks the source to
  // compact itself, so this contract has to say so explicitly or it would be
  // asserting against a path the product no longer takes by default.
  it('runs native source compaction and retries planning before projection', async () => {
    const oversized = {
      ...conversation,
      entries: [{
        ...conversation.entries[0],
        content: [{ kind: 'text' as const, text: 'large '.repeat(300) }],
      }],
    }
    const compacted = {
      ...conversation,
      entries: [{
        kind: 'compaction' as const,
        summary: 'native summary',
        timestamp: null,
        source: { provider: 'claude', line: 10, raw: {}, evidence: [] },
      }, conversation.entries[0]],
    }
    const compactSource = vi.fn(async () => undefined)
    const onProgress = vi.fn()
    mocks.sourceRead
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(compacted)

    const result = await switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
      contextPolicy: { allowSourceTurns: true },
    }, { compactSource, onProgress })

    expect(compactSource).toHaveBeenCalledOnce()
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'compacting' }))
    expect(mocks.targetProject).toHaveBeenCalledWith(
      compacted,
      expect.objectContaining({
        targetProfile: expect.objectContaining({ model: 'gpt-current' }),
      }),
    )
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') throw new Error('expected a translated target session')
    expect(result.compactedBeforeSwitch).toBe(true)
    expect(result.truncatedBeforeSwitch).toBe(false)
  })

  it('reports a durable but empty source without writing a target transcript', async () => {
    mocks.sourceRead.mockResolvedValueOnce({
      ...conversation,
      entries: [],
    })

    await expect(switchProvider({
      sourceKind: 'opencode',
      targetKind: 'claude',
      sourceProviderSessionId: 'ses_precreated_but_empty',
      cwd: '/project',
    })).resolves.toEqual({
      kind: 'source-empty',
      targetKind: 'claude',
    })

    expect(mocks.targetProfile).not.toHaveBeenCalled()
    expect(mocks.targetProject).not.toHaveBeenCalled()
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  // `overflowPolicy: 'fail'` still means "refuse", even under the default
  // no-source-turn policy that would otherwise make this conversation fit.
  it('never truncates overflow unless the caller explicitly requests it', async () => {
    mocks.sourceRead.mockResolvedValueOnce({
      ...conversation,
      entries: [{
        ...conversation.entries[0],
        content: [{ kind: 'text' as const, text: 'large '.repeat(300) }],
      }],
    })

    await expect(switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      overflowPolicy: 'fail',
    })).rejects.toThrow('requires compaction')
    expect(mocks.targetProject).not.toHaveBeenCalled()
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  it('does not write a target file when projection fails', async () => {
    mocks.targetProject.mockRejectedValueOnce(new Error('profile rejected'))
    await expect(switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow('profile rejected')
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  it('requires an explicit target for providers outside the legacy pair', async () => {
    await expect(switchProvider({
      sourceKind: 'opencode',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow('targetKind is required')
  })

  // Stage 3 of docs/decomposition/quota-independent-provider-switch.md. Every
  // case below is driven by a decoded Stage 0 fixture rather than a literal,
  // because the behaviour under test is a reaction to real transcript SHAPE:
  // an encrypted Codex carrier with readable history behind it, a Claude
  // transcript too large for its target. A literal would only prove that the
  // host reacts to whatever the literal's author already believed.
  describe('quota-independent policy', () => {
    it('never asks for a source turn by default when the Codex source has encrypted compaction', async () => {
      // This is the shape that used to cost a live source turn: modern Codex
      // persisted an encrypted `compacted` record, so the old planner returned
      // `requires-portable-handoff` and the host asked the (possibly
      // rate-limited) source to summarize itself. The plaintext records the
      // carrier claims to replace are still in the file, so the default policy
      // strips the unreadable carrier and carries them instead.
      mocks.sourceRead.mockResolvedValue(await loadFixtureConversation('codex-sequence-compacted-once', 'codex'))
      mocks.targetProfile.mockResolvedValue({ model: 'claude-fable-5-1[1m]', budgetCharacters: 2_250_000 })
      mocks.targetProject.mockResolvedValue(claudeProjection)
      mocks.targetWrite.mockResolvedValue('/claude/target.jsonl')
      mocks.targetSessionId.mockReturnValue('target-session')
      const compactSource = vi.fn()

      const result = await switchProvider(
        { sourceKind: 'codex', targetKind: 'claude', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local' },
        { compactSource },
      )

      expect(compactSource).not.toHaveBeenCalled()
      expect(result).toMatchObject({ kind: 'switched', strategy: 'raw', shrinkSummary: null })
      const projected = mocks.targetProject.mock.calls[0]![0] as ConversationDocument
      expect(projected.entries.some(entry => entry.kind === 'compaction')).toBe(false)
    })

    it('carries the plaintext history a majority-shape Codex rollout kept ahead of its compaction', async () => {
      // `codex-sequence-compacted-once` has NOTHING before its compaction (it
      // is conversation entry 2 of 52), so on its own it cannot show that the
      // stripped carrier leaves real history behind. This fixture was recorded
      // for exactly that gap: census §"The two majority-shape fixtures" puts
      // its single compaction at entry 23 of 83, and 181 of 1,937 local
      // rollouts share the shape. The assertion is therefore that the 23
      // pre-compaction entries reach the projector.
      const source = await loadFixtureConversation('codex-sequence-compacted-history', 'codex')
      const compactionLine = source.entries.find(entry => entry.kind === 'compaction')!.source.line
      mocks.sourceRead.mockResolvedValue(source)
      mocks.targetProfile.mockResolvedValue({ model: 'claude-fable-5-1[1m]', budgetCharacters: 2_250_000 })
      mocks.targetProject.mockResolvedValue(claudeProjection)
      mocks.targetWrite.mockResolvedValue('/claude/target.jsonl')
      mocks.targetSessionId.mockReturnValue('target-session')
      const compactSource = vi.fn()

      const result = await switchProvider(
        { sourceKind: 'codex', targetKind: 'claude', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local' },
        { compactSource },
      )

      expect(compactSource).not.toHaveBeenCalled()
      expect(result).toMatchObject({ kind: 'switched', strategy: 'raw', shrinkSummary: null })
      const projected = mocks.targetProject.mock.calls[0]![0] as ConversationDocument
      expect(projected.entries.some(entry => entry.kind === 'compaction')).toBe(false)
      expect(projected.entries.filter(entry => entry.source.line < compactionLine)).toHaveLength(23)
    })

    it('reports shrunk with a summary and a shrinking progress phase when the history exceeds the target', async () => {
      // WHY the budget is derived instead of being the real 581,400-character
      // Codex budget the brief for this task proposed: census caveat 1 says the
      // committed fixtures are redacted to 0.3-2.4 % of their real byte totals.
      // `claude-sequence-oversized` really is over budget on disk (644,901
      // characters) but decodes to 3,037 here, so a literal budget would assert
      // that the REDACTOR shrank the file. `claude-sequence-oversized-turns` is
      // the 1,470-entry fixture recorded to force the drop rung; an eighth of
      // its decoded size is the smallest fraction that reaches that rung with
      // whole user turns in the dropped range (a quarter drops 130 entries but
      // zero complete turns, and the fixtures cannot reach the tool-payload
      // rungs at all - every redacted output is under the placeholder's own
      // length). The absolute number is meaningless; the RATIO is the fixture's.
      const source = await loadFixtureConversation('claude-sequence-oversized-turns', 'claude')
      mocks.sourceRead.mockResolvedValue(source)
      mocks.targetProfile.mockResolvedValue({
        model: 'gpt-6-astra',
        modelProvider: 'openai',
        budgetCharacters: Math.floor(estimateConversationCharacters(source) / 8),
      })
      mocks.targetProject.mockResolvedValue(projection)
      mocks.targetWrite.mockResolvedValue('/codex/target.jsonl')
      mocks.targetSessionId.mockReturnValue('target-session')
      const onProgress = vi.fn()
      const compactSource = vi.fn()

      const result = await switchProvider(
        { sourceKind: 'claude', targetKind: 'codex', sourceProviderSessionId: 'src', cwd: '/project', sourceSessionId: 'local' },
        { onProgress, compactSource },
      )

      expect(compactSource).not.toHaveBeenCalled()
      expect(result).toMatchObject({ kind: 'switched', strategy: 'shrunk', truncatedBeforeSwitch: true })
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'shrinking' }))
      expect((result as { shrinkSummary: string }).shrinkSummary).toMatch(/cleared|dropped/)
    })

    it('still runs the opt-in source path when allowSourceTurns is true', async () => {
      // The opt-in path is not deleted, only demoted: a user who still wants
      // the source to compact itself (and knows it has quota) gets exactly the
      // old transaction, native confirmation dialog included.
      mocks.sourceRead.mockResolvedValue(await loadFixtureConversation('codex-sequence-compacted-once', 'codex'))
      mocks.targetProfile.mockResolvedValue({ model: 'claude-fable-5-1[1m]', budgetCharacters: 2_250_000 })
      const compactSource = vi.fn(async () => await loadFixtureConversation('claude-sequence-compaction', 'claude'))
      mocks.targetProject.mockResolvedValue(claudeProjection)
      mocks.targetWrite.mockResolvedValue('/claude/target.jsonl')
      mocks.targetSessionId.mockReturnValue('target-session')

      const result = await switchProvider(
        {
          sourceKind: 'codex',
          targetKind: 'claude',
          sourceProviderSessionId: 'src',
          cwd: '/project',
          sourceSessionId: 'local',
          contextPolicy: { allowSourceTurns: true },
        },
        { compactSource },
      )

      expect(compactSource).toHaveBeenCalledOnce()
      expect(result).toMatchObject({ kind: 'switched', strategy: 'native' })
    })
  })
})
