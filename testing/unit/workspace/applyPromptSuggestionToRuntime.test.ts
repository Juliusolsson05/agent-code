import { describe, it, expect } from 'vitest'

import { applyPromptSuggestionToRuntime } from '@renderer/workspace/hook/ipc/applyPromptSuggestionToRuntime'
import {
  applyJsonlProviderSessionId,
  hasDurableProviderSession,
  resumableProviderSessionId,
  shouldMarkProviderSessionDisconnected,
  withoutProvisionalProviderSession,
} from '@renderer/workspace/providerSessionIdentity'
import type { SessionMeta } from '@renderer/workspace/types'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'

// We don't need a full runtime — the helper touches exactly one field. Cast a
// minimal object so the test stays focused and doesn't depend on emptyRuntime
// pulling in heavy renderer deps.
const base = { promptSuggestion: null } as unknown as SessionRuntime

describe('applyPromptSuggestionToRuntime', () => {
  it('stores trimmed suggestion text + receivedAt', () => {
    const next = applyPromptSuggestionToRuntime(base, { text: '  run the tests  ', ts: 5 })
    expect(next.promptSuggestion).toEqual({ text: 'run the tests', receivedAt: 5 })
  })

  it('returns the SAME reference for empty/whitespace text (no-op short-circuit)', () => {
    expect(applyPromptSuggestionToRuntime(base, { text: '   ' })).toBe(base)
    expect(applyPromptSuggestionToRuntime(base, {})).toBe(base)
  })

  it('defaults receivedAt to 0 when ts is missing', () => {
    const next = applyPromptSuggestionToRuntime(base, { text: 'commit this' })
    expect(next.promptSuggestion).toEqual({ text: 'commit this', receivedAt: 0 })
  })
})

describe('provider session identity helpers', () => {
  const durableMeta = {
    cwd: '/repo',
    kind: 'claude',
    providerSessionId: 'durable-1',
    providerSessionIdSource: 'jsonl-entry',
  } satisfies SessionMeta
  const provisionalMeta = {
    cwd: '/repo',
    kind: 'claude',
    providerSessionId: 'proxy-1',
    providerSessionIdSource: 'proxy-header',
  } satisfies SessionMeta

  it('treats proxy-header provider ids as non-resumable', () => {
    expect(hasDurableProviderSession(provisionalMeta)).toBe(false)
    expect(resumableProviderSessionId(provisionalMeta)).toBeUndefined()
    expect(withoutProvisionalProviderSession(provisionalMeta)).toEqual({
      cwd: '/repo',
      kind: 'claude',
    })
  })

  it('keeps jsonl-entry and legacy provider ids resumable', () => {
    expect(hasDurableProviderSession(durableMeta)).toBe(true)
    expect(resumableProviderSessionId(durableMeta)).toBe('durable-1')
    expect(hasDurableProviderSession({
      cwd: '/repo',
      kind: 'claude',
      providerSessionId: 'legacy-1',
    })).toBe(true)
  })

  it('upgrades a proxy-header id when JSONL confirms the same provider session', () => {
    const result = applyJsonlProviderSessionId(provisionalMeta, 'proxy-1')
    expect(result.status).toBe('updated')
    expect(result.meta).toMatchObject({
      providerSessionId: 'proxy-1',
      providerSessionIdSource: 'jsonl-entry',
    })
  })

  it('lets JSONL replace a provisional proxy-header id', () => {
    const result = applyJsonlProviderSessionId(provisionalMeta, 'jsonl-1')
    expect(result.status).toBe('updated')
    expect(result.meta).toMatchObject({
      providerSessionId: 'jsonl-1',
      providerSessionIdSource: 'jsonl-entry',
    })
  })

  it('rejects a conflicting durable JSONL id', () => {
    const result = applyJsonlProviderSessionId(durableMeta, 'other-1')
    expect(result.status).toBe('conflict')
    expect(result.meta).toBe(durableMeta)
    if (result.status === 'conflict') {
      expect(result.current).toBe('durable-1')
      expect(result.incoming).toBe('other-1')
    }
  })

  it('only marks disconnected before any durable transcript identity exists', () => {
    const emptyRuntime = {
      lastJsonlEntryAt: null,
      totalEntries: 0,
      transcriptStatus: 'idle',
    } as Pick<SessionRuntime, 'lastJsonlEntryAt' | 'totalEntries' | 'transcriptStatus'>
    expect(shouldMarkProviderSessionDisconnected(emptyRuntime, provisionalMeta)).toBe(true)
    expect(shouldMarkProviderSessionDisconnected(emptyRuntime, durableMeta)).toBe(false)
    expect(shouldMarkProviderSessionDisconnected({
      ...emptyRuntime,
      transcriptStatus: 'loading',
    }, provisionalMeta)).toBe(false)
  })
})
