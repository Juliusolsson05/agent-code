import { beforeEach, describe, expect, it, vi } from 'vitest'

// The shared loader must hand history for providers without a transcript file
// (OpenCode) to the provider's own source, and must never fall through to the
// JSONL reader for them — that fall-through is what served every parked
// OpenCode pane an empty history.

const registry = vi.hoisted(() => ({
  loadHistoryChunk: vi.fn(),
  resolveTranscriptPath: vi.fn(),
}))

vi.mock('@providers/registry.main.js', () => ({
  getMainProvider: (kind: string) =>
    kind === 'opencode'
      ? { loadHistoryChunk: registry.loadHistoryChunk, resolveTranscriptPath: registry.resolveTranscriptPath }
      : { resolveTranscriptPath: registry.resolveTranscriptPath },
}))
vi.mock('@main/providerSwitch/shared.js', () => ({
  resolveProviderTranscriptPath: registry.resolveTranscriptPath,
}))

const span = vi.hoisted(() => ({ end: vi.fn(), fail: vi.fn() }))
vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { span: () => span } }))

import { loadInitialHistoryChunk, loadOlderHistoryChunk } from './historyLoader.js'

describe('historyLoader with a provider-owned history source', () => {
  beforeEach(() => {
    span.end.mockReset()
    span.fail.mockReset()
    registry.loadHistoryChunk.mockReset()
    registry.resolveTranscriptPath.mockReset()
  })

  it('delegates the newest window and older pages, passing the page cursor through', async () => {
    registry.loadHistoryChunk.mockResolvedValue({ entries: [{ info: { id: 'msg_b' } }], hasMore: true, totalEntries: 9 })
    await expect(loadInitialHistoryChunk({ kind: 'opencode', cwd: '/w', providerSessionId: 'ses_1', limit: 120 }))
      .resolves.toEqual({ entries: [{ info: { id: 'msg_b' } }], hasMore: true, totalEntries: 9 })
    expect(registry.loadHistoryChunk).toHaveBeenLastCalledWith({ cwd: '/w', providerSessionId: 'ses_1', limit: 120 })

    registry.loadHistoryChunk.mockResolvedValue({ entries: [], hasMore: false })
    await loadOlderHistoryChunk({ kind: 'opencode', cwd: '/w', providerSessionId: 'ses_1', beforeMarker: 'msg_b', beforeOffset: 42, limit: 200 })
    // A byte offset means nothing to a database page; only the marker is passed.
    expect(registry.loadHistoryChunk).toHaveBeenLastCalledWith({ cwd: '/w', providerSessionId: 'ses_1', limit: 200, beforeMarker: 'msg_b' })
    expect(registry.resolveTranscriptPath).not.toHaveBeenCalled()
  })

  it.each(['initial', 'older'] as const)('fails the %s span and rethrows the source rejection', async mode => {
    const error = Object.assign(new Error('schema refused'), { code: 'unsupported_schema' })
    registry.loadHistoryChunk.mockRejectedValue(error)
    const params = { kind: 'opencode' as const, cwd: '/w', providerSessionId: 'ses_1', limit: 5 }
    const loading = mode === 'initial' ? loadInitialHistoryChunk(params)
      : loadOlderHistoryChunk({ ...params, beforeMarker: 'msg_b' })
    await expect(loading).rejects.toBe(error)
    expect(span.fail).toHaveBeenCalledExactlyOnceWith(error)
    expect(span.end).not.toHaveBeenCalled()
  })

  it('keeps file-backed providers on the JSONL path', async () => {
    registry.resolveTranscriptPath.mockResolvedValue(null)
    await expect(loadInitialHistoryChunk({ kind: 'claude', cwd: '/w', providerSessionId: 'x', limit: 5 }))
      .resolves.toEqual({ entries: [], hasMore: false, totalEntries: 0 })
    expect(registry.loadHistoryChunk).not.toHaveBeenCalled()
    expect(registry.resolveTranscriptPath).toHaveBeenCalledOnce()
  })
})
