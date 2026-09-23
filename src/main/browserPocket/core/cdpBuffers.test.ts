import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { RING_SIZE, emptyBuffers, entriesSince, reduceCdpEvent } from './cdpBuffers'

// Replays real Chrome event streams (Stage-1 recordings) through the reducer.
function replay(page: string) {
  const lines = readFileSync(join(__dirname, '..', '__fixtures__', `cdp-events.${page}.jsonl`), 'utf8').trim().split('\n').slice(1)
  const buffers = emptyBuffers()
  lines.forEach((line, i) => {
    const { method, params } = JSON.parse(line)
    reduceCdpEvent(buffers, method, params, i)
  })
  return buffers
}

describe('recorded broken page', () => {
  const b = replay('errors')

  it('reports each failed resource once, in the network ring only', () => {
    // Recorded: 404 image, 500 fetch, and a blocked fetch — each also arrives
    // as a network-sourced Log.entryAdded.
    expect(b.network.map(n => [n.url.replace(/:\d{4,5}\//, ':PORT/'), n.status ?? n.error])).toEqual([
      ['http://127.0.0.1:PORT/missing.png', 404],
      ['http://127.0.0.1:PORT/api/nope', 500],
      ['http://127.0.0.1:9/unreachable', 'net::ERR_UNSAFE_PORT'],
    ])
    expect(b.console.some(c => c.text.startsWith('Failed to load resource'))).toBe(false)
  })

  it('recovers the URL of a loadingFailed request, which carries only a requestId', () => {
    expect(b.network.find(n => n.status === null)?.url).toBe('http://127.0.0.1:9/unreachable')
  })

  it('keeps console levels and renders object arguments from their preview', () => {
    const byLevel = (level: string) => b.console.filter(c => c.level === level).map(c => c.text)
    expect(byLevel('log')).toContain('boot')
    expect(byLevel('warning')).toContain('deprecated thing')
    expect(byLevel('error')).toContain('render failed {code: 42}')
  })

  it('names uncaught exceptions and rejections by their message, not just "Uncaught"', () => {
    const errors = b.console.filter(c => c.level === 'error').map(c => c.text)
    expect(errors).toContain('Uncaught (in promise): Error: unhandled rejection')
    expect(errors).toContain('Uncaught: Error: uncaught in timeout')
  })
})

it('a clean recorded page produces empty buffers, even though Chrome\'s own favicon request 404s', () => {
  for (const page of ['form', 'spa']) {
    const b = replay(page)
    expect(b.network).toEqual([])
    expect(b.console.filter(c => c.level === 'error')).toEqual([])
  }
})

it('rings are bounded and keep the newest entries', () => {
  const b = emptyBuffers()
  for (let i = 0; i < RING_SIZE + 25; i++) reduceCdpEvent(b, 'Log.entryAdded', { entry: { source: 'javascript', level: 'error', text: `e${i}` } }, i)
  expect(b.console).toHaveLength(RING_SIZE)
  expect(b.console[0]!.text).toBe('e25')
  expect(entriesSince(b.console, b.seq - 5).map(e => e.text)).toEqual(['e220', 'e221', 'e222', 'e223', 'e224'])
})
