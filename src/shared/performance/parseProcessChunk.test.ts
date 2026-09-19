import { describe, expect, it } from 'vitest'
import { parseProcessChunk } from './parseProcessChunk.js'

const row = { identity: '1:100', pid: 1, parentPid: 0, creationTime: 100, type: 'agent', provider: 'claude',
  sessionIds: ['a'], sharedSessionCount: 1, cpuPercent: 100, memoryBytes: 1024, quality: 'ok' }
const chunk = { generation: 1, offset: 0, complete: true, rows: [row], summary: {
  sampledAt: 100, count: 1, cpuPercent: 100, memoryBytes: 1024, quality: 'ok', sessionCount: 1, missingRoots: 0, truncated: false,
} }

describe('bounded process snapshots', () => {
  it('copies a valid frame and rejects sparse owners, malformed metrics and oversized frames', () => {
    const result = parseProcessChunk(chunk)
    expect(result).toEqual(chunk)
    expect(result?.rows[0]).not.toBe(row)
    expect(parseProcessChunk({ ...chunk, rows: [{ ...row, sessionIds: new Array(4) }] })).toBeNull()
    expect(parseProcessChunk({ ...chunk, rows: [{ ...row, cpuPercent: NaN }] })).toBeNull()
    expect(parseProcessChunk({ ...chunk, rows: Array(121).fill(row) })).toBeNull()
    expect(parseProcessChunk({ ...chunk, rows: [{ ...row, provider: 'private text' }] })).toBeNull()
  })
})
