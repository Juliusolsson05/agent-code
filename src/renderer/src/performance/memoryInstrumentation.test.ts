import { beforeEach, describe, expect, it, vi } from 'vitest'

import { appendFeedDebugLog } from '@renderer/session-runtime/feedDebug'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { codeBlockRegistrySize } from '@renderer/features/copy-code-block/lib/codeBlockRegistry'
import { monacoModelCount } from '@renderer/lib/code/monacoModelProbe'

import * as perf from './client'
import { emitRendererMemoryGauges, estimateJsonBytesSampled } from './memoryInstrumentation'

vi.mock('./client', () => ({ getPerformanceConfig: vi.fn(), gauge: vi.fn() }))
vi.mock('@renderer/features/copy-code-block/lib/codeBlockRegistry', () => ({ codeBlockRegistrySize: vi.fn() }))
vi.mock('@renderer/lib/code/monacoModelProbe', () => ({ monacoModelCount: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(perf.getPerformanceConfig).mockReturnValue({
    enabled: false, verbose: false, slowSpanMs: 50, runId: null, runDir: null,
  })
  vi.mocked(codeBlockRegistrySize).mockReturnValue(7)
  vi.mocked(monacoModelCount).mockReturnValue(3)
})

describe('renderer memory instrumentation work budget', () => {
  it('performs no runtime, UUID, or registry traversal when diagnostics are disabled', () => {
    // Checking emitted records alone misses the original regression: gauge()
    // could discard them after expensive argument serialization had happened.
    // Throw at the first traversal so the gate must protect the work itself.
    const failTraversal = (): never => { throw new Error('disabled instrumentation traversed state') }
    const runtimes = new Proxy<Record<string, SessionRuntime>>({}, { ownKeys: failTraversal, get: failTraversal })
    const seen = new Proxy<Record<string, Set<string>>>({}, { ownKeys: failTraversal, get: failTraversal })
    expect(() => emitRendererMemoryGauges(runtimes, seen)).not.toThrow()
    expect(perf.gauge).not.toHaveBeenCalled()
    expect(codeBlockRegistrySize).not.toHaveBeenCalled()
    expect(monacoModelCount).not.toHaveBeenCalled()
  })

  it('emits representative session and global gauges when enabled', () => {
    vi.mocked(perf.getPerformanceConfig).mockReturnValue({
      enabled: true, verbose: false, slowSpanMs: 50, runId: 'run', runDir: '/diagnostics',
    })
    const runtime = appendFeedDebugLog(emptyRuntime(), {
      layer: 'STATE', kind: 'test', summary: 'one retained diagnostic', data: { rows: 2 },
    })
    runtime.totalEntries = 12
    emitRendererMemoryGauges({ active: runtime, empty: emptyRuntime() }, { active: new Set(['a', 'b']) })

    expect(perf.gauge).toHaveBeenCalledWith('renderer.session.memory.entries', 0, {
      sessionId: 'active', bytesEstimate: 0, totalEntries: 12,
    })
    expect(perf.gauge).toHaveBeenCalledWith('renderer.session.memory.feedDebugLog', 1, {
      sessionId: 'active', bytesEstimate: JSON.stringify(runtime.feedDebugLog[0]).length,
    })
    expect(perf.gauge).toHaveBeenCalledWith('renderer.session.memory.seenUuids', 2, {
      sessionId: 'active', trimmedUuids: 0,
    })
    expect(perf.gauge).toHaveBeenCalledWith('renderer.global.memory.codeBlockRegistry', 7)
    expect(perf.gauge).toHaveBeenCalledWith('renderer.global.memory.monacoModels', 3)
    expect(vi.mocked(perf.gauge).mock.calls.some(([, , data]) => data?.sessionId === 'empty')).toBe(false)
  })

  it('keeps the serialization cap at 64 for the problematic 127-item collection', () => {
    const visited: number[] = []
    const items = Array.from({ length: 127 }, (_, index) => ({
      toJSON: () => { visited.push(index); return { payload: 'same-sized record' } },
    }))
    const result = estimateJsonBytesSampled(items)
    expect(visited.length).toBeLessThanOrEqual(64)
    expect(visited.length).toBeGreaterThan(0)
    expect(new Set(visited).size).toBe(visited.length)
    // Equal-size rows give an exact extrapolation independently of the chosen
    // sample indices; coverage of both halves catches accidental head sampling.
    expect(result).toBe(JSON.stringify({ payload: 'same-sized record' }).length * 127)
    expect(visited.some(index => index < 32)).toBe(true)
    expect(visited.some(index => index > 95)).toBe(true)
  })

  it('estimates empty and small collections without sampling error', () => {
    expect(estimateJsonBytesSampled([])).toBe(0)
    const items = [{ text: 'short' }, { text: 'a somewhat longer row' }, null, 4]
    expect(estimateJsonBytesSampled(items)).toBe(
      items.reduce<number>((bytes, item) => bytes + JSON.stringify(item).length, 0),
    )
  })
})
