import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const RECORDINGS = mkdtempSync(join(tmpdir(), 'render-shape-sidecar-'))

vi.mock('@main/storage/paths.js', () => ({
  SESSION_RECORDING_DIR: RECORDINGS,
}))

const { readRenderShapeSightings } = await import('./renderShapeSidecar.js')

function writeRecording(recordingId: string, records: string[]): void {
  const directory = join(RECORDINGS, recordingId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'events.jsonl'), records.join('\n'))
}

function shapeLine(sightings: unknown[]): string {
  return JSON.stringify({ ch: '__render_shape', sightings })
}

beforeEach(() => {
  rmSync(RECORDINGS, { recursive: true, force: true })
  mkdirSync(RECORDINGS, { recursive: true })
})

afterAll(() => {
  rmSync(RECORDINGS, { recursive: true, force: true })
})

describe('readRenderShapeSightings', () => {
  it('selects recordings newest-first and stops before the oldest recording cap overflow', async () => {
    for (let index = 0; index < 61; index += 1) {
      const recordingId = `recording-${String(index).padStart(3, '0')}`
      writeRecording(recordingId, [shapeLine([{ index }])])
    }

    const result = await readRenderShapeSightings()

    expect(result.recordingsScanned).toBe(60)
    expect(result.truncated).toBe(true)
    expect(result.sightings).toHaveLength(60)
    expect(result.sightings[0]).toEqual({ index: 60, sourceRecordingId: 'recording-060' })
    expect(result.sightings.at(-1)).toEqual({ index: 1, sourceRecordingId: 'recording-001' })
  })

  it('skips malformed and torn records while injecting the authoritative recording id', async () => {
    writeRecording('recording-good', [
      '{not json}',
      JSON.stringify({ ch: '__render_shape', sightings: 'not-an-array' }),
      shapeLine([
        { structuralFingerprint: 'fp2-good', sourceRecordingId: 'untrusted-carrier-value' },
        'primitive sightings cross this trust boundary unchanged',
      ]),
      // A live writer may leave a partial tail. It must not poison the valid
      // committed records that precede it.
      '{"ch":"__render_shape","sightings":[',
    ])

    const result = await readRenderShapeSightings()

    expect(result).toEqual({
      sightings: [
        { structuralFingerprint: 'fp2-good', sourceRecordingId: 'recording-good' },
        'primitive sightings cross this trust boundary unchanged',
      ],
      recordingsScanned: 1,
      truncated: false,
    })
  })

  it('caps sightings within a record and reports that older evidence was truncated', async () => {
    writeRecording(
      'recording-cap',
      [shapeLine(Array.from({ length: 20_001 }, (_, index) => ({ index })))],
    )

    const result = await readRenderShapeSightings()

    expect(result.sightings).toHaveLength(20_000)
    expect(result.sightings[0]).toEqual({ index: 0, sourceRecordingId: 'recording-cap' })
    expect(result.sightings.at(-1)).toEqual({ index: 19_999, sourceRecordingId: 'recording-cap' })
    expect(result.truncated).toBe(true)
  })

  it('drops an oversized line while streaming and resumes at the next committed record', async () => {
    const oversized = `{"ch":"__render_shape","padding":"${'x'.repeat(4 * 1024 * 1024)}"}`
    writeRecording('recording-oversized', [
      oversized,
      shapeLine([{ structuralFingerprint: 'fp2-after-oversized' }]),
    ])

    const result = await readRenderShapeSightings()

    expect(result).toEqual({
      sightings: [
        {
          structuralFingerprint: 'fp2-after-oversized',
          sourceRecordingId: 'recording-oversized',
        },
      ],
      recordingsScanned: 1,
      truncated: false,
    })
  })

  it('accepts CRLF framing and one complete-file final record without a trailing newline', async () => {
    const directory = join(RECORDINGS, 'recording-framing')
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'events.jsonl'),
      `${shapeLine([{ index: 1 }])}\r\n${shapeLine([{ index: 2 }])}`,
    )

    const result = await readRenderShapeSightings()

    expect(result.sightings).toEqual([
      { index: 1, sourceRecordingId: 'recording-framing' },
      { index: 2, sourceRecordingId: 'recording-framing' },
    ])
  })
})
