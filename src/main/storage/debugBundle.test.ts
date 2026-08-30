import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const TMP = mkdtempSync(join(tmpdir(), 'debug-bundle-observations-'))
const MANUAL_ROOT = join(TMP, 'manual')
const AUTOSAVE_ROOT = join(TMP, 'autosave')
const INCIDENT_ROOT = join(TMP, 'incidents')
const APP_RUN_ID = 'run-stage0-test'
const CODEX_PANE_ID = '51515151-5151-4151-8151-515151515151'
const COMPLETE_JOURNAL_SOURCE = {
  appRunJournalCompleteness: {
    capped: false,
    bytesWritten: 4_096,
    droppedEvents: 0,
    flushFailed: false,
  },
  codexTranscriptObservationCompleteness: {
    gapTrackingCapped: false,
  },
} as const

vi.mock('@main/storage/paths.js', () => ({
  INCIDENT_RUNS_DIR: INCIDENT_ROOT,
}))
vi.mock('@main/incident/appRunIds.js', () => ({
  getAppRunId: () => APP_RUN_ID,
}))
vi.mock('@main/buildInfo.js', () => ({
  getBuildInfo: () => ({ commit: 'test', branch: 'test', dirty: false }),
}))
vi.mock('@main/storage/debugRetention.js', () => ({
  scheduleDebugStoragePrune: vi.fn(),
}))
vi.mock('@main/storage/debugBundleLog.js', () => ({
  appendDebugBundleSaved: vi.fn(async () => {}),
  isAutosaveDebugBundleReason: (reason?: string | null) =>
    typeof reason === 'string' && reason.startsWith('autosave-'),
  debugBundleRootForReason: (reason?: string | null) =>
    typeof reason === 'string' && reason.startsWith('autosave-')
      ? AUTOSAVE_ROOT
      : MANUAL_ROOT,
}))

const { saveDebugBundle } = await import('./debugBundle.js')

function journalEvent(params: {
  seq: number
  monotonicMs?: number
  sessionId: string
  name: string
  data?: Record<string, unknown>
  ids?: Record<string, unknown>
}): Record<string, unknown> {
  const ts = 1_700_000_000_000 + params.seq
  return {
    schemaVersion: 1,
    seq: params.seq,
    ts,
    tsIso: new Date(ts).toISOString(),
    monotonicMs: params.monotonicMs ?? params.seq,
    appRunId: APP_RUN_ID,
    area: 'session.lifecycle',
    name: params.name,
    severity: 'info',
    ids: { sessionId: params.sessionId, ...(params.ids ?? {}) },
    data: params.data,
  }
}

function bundleFiles(): Array<{ name: string; content: string }> {
  return [
    {
      name: 'manifest.json',
      content: JSON.stringify({ schemaVersion: 1, files: ['manifest.json'] }),
    },
  ]
}

beforeEach(() => {
  rmSync(MANUAL_ROOT, { recursive: true, force: true })
  rmSync(AUTOSAVE_ROOT, { recursive: true, force: true })
  rmSync(INCIDENT_ROOT, { recursive: true, force: true })
  const runDir = join(INCIDENT_ROOT, APP_RUN_ID)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, appRunId: APP_RUN_ID }),
  )
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('Codex transcript observation bundle export', () => {
  it('exports only the requested session and re-applies the content-safe schema', async () => {
    const source = [
      journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'submit.write',
        ids: { submissionId: 'sub-1', madeUpJoin: 'discard-me' },
        data: {
          phase: 'body',
          bytes: 81,
          ok: true,
          // The source journal should already have removed this, but the named
          // export is a privacy boundary in its own right and must not trust a
          // future direct AppRunJournal producer to remember that contract.
          prompt: 'private prompt bytes',
        },
      }),
      journalEvent({
        seq: 2,
        sessionId: 'another-pane',
        name: 'submit.surface',
        ids: { submissionId: 'sub-other' },
        data: { surface: 'queue-visible' },
      }),
      journalEvent({
        seq: 3,
        sessionId: CODEX_PANE_ID,
        name: 'wake.request',
        data: { caller: 'tile-leaf.send' },
      }),
      journalEvent({
        seq: 4,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.snapshot',
        data: { entryCount: 7, totalEntries: 11 },
      }),
      journalEvent({
        seq: 5,
        sessionId: CODEX_PANE_ID,
        name: 'submit.begin',
        data: { provider: 'claude', source: 'text-only' },
      }),
      journalEvent({
        seq: 6,
        sessionId: CODEX_PANE_ID,
        name: 'submit.begin',
        data: { provider: 'codex', source: 'text-only', runDisposition: 'current' },
      }),
      journalEvent({
        // Provider is renderer-observed and therefore insufficient by itself.
        // Lifecycle IPC adds runDisposition only after exact manager proof; a
        // generic legacy row without that main verdict must stay out.
        seq: 7,
        sessionId: CODEX_PANE_ID,
        name: 'submit.begin',
        data: { provider: 'codex', source: 'text-only' },
      }),
    ]
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${source.map(row => JSON.stringify(row)).join('\n')}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const observations = readFileSync(
      join(bundlePath, 'codex-transcript-observations.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(observations.map(row => row.name)).toEqual([
      'submit.write',
      'transcript.snapshot',
      'submit.begin',
    ])
    expect(observations[0]).toMatchObject({
      schemaVersion: 1,
      appRunId: APP_RUN_ID,
      ids: { sessionId: CODEX_PANE_ID, submissionId: 'sub-1' },
      data: { phase: 'body', ok: true },
    })
    expect(observations[0].ids).not.toHaveProperty('madeUpJoin')
    expect(observations[0].data).not.toHaveProperty('prompt')

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.files).toContain('codex-transcript-observations.jsonl')
    expect(manifest.codexTranscriptObservations).toMatchObject({
      source: 'app-run-journal',
      sourceAppRunId: APP_RUN_ID,
      sourceAvailable: true,
      matchedEvents: 3,
      writtenEvents: 3,
      truncated: false,
      sourceCompletenessAvailable: true,
      sourceCapped: false,
      sourceBytesWritten: 4_096,
      sourceDroppedEvents: 0,
      sourceFlushFailed: false,
      sourceGapTrackingStatusAvailable: true,
      sourceGapTrackingCapped: false,
      malformedJsonRows: 0,
      invalidChronologyRows: 0,
      sourceHasGaps: false,
    })
  })

  it('marks a missing journal source instead of making an empty export look complete', async () => {
    rmSync(join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'), { force: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    expect(readFileSync(
      join(bundlePath, 'codex-transcript-observations.jsonl'),
      'utf8',
    )).toBe('')
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      sourceAvailable: false,
      matchedEvents: 0,
      writtenEvents: 0,
      truncated: false,
      sourceHasGaps: true,
    })
    expect(warn).toHaveBeenCalledWith(
      '[debug-bundle] failed to export Codex transcript observations',
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('caps the named stream as a complete chronological prefix and marks the gap', async () => {
    // Boundary test, not a product-shape fixture: real lifecycle values are
    // tiny, but a corrupted/direct journal producer must still be unable to
    // turn bundle enrichment into an unbounded second archive.
    const source = Array.from({ length: 20_000 }, (_, seq) => journalEvent({
      seq,
      sessionId: CODEX_PANE_ID,
      name: 'transcript.candidate',
      ids: { candidateFingerprint: seq.toString(16).padStart(64, '0') },
      data: { phase: 'pre-lease', matched: seq % 2 === 0 },
    }))
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${source.map(row => JSON.stringify(row)).join('\n')}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const body = readFileSync(join(bundlePath, 'codex-transcript-observations.jsonl'), 'utf8')
    const rows = body.trim().split('\n').map(line => JSON.parse(line))
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(manifest.codexTranscriptObservations).toMatchObject({
      matchedEvents: 20_000,
      writtenEvents: rows.length,
      truncated: true,
      sourceHasGaps: true,
    })
    expect(rows.length).toBeLessThan(20_000)
    expect(rows.map(row => row.seq)).toEqual(
      Array.from({ length: rows.length }, (_, seq) => seq),
    )
  })

  it('separates upstream journal loss from projection truncation', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.snapshot',
        data: { entryCount: 1, totalEntries: 1 },
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, {
      appRunJournalCompleteness: {
        capped: true,
        bytesWritten: 50 * 1024 * 1024,
        droppedEvents: 37,
        flushFailed: false,
      },
      codexTranscriptObservationCompleteness: {
        gapTrackingCapped: true,
      },
    })

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      truncated: false,
      sourceCapped: true,
      sourceDroppedEvents: 37,
      sourceGapTrackingCapped: true,
      sourceHasGaps: true,
    })
  })

  it('marks an in-stream observation gap even when source snapshots are clean', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.observation-gap',
        data: { suppressed: 17 },
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      sourceCapped: false,
      sourceDroppedEvents: 0,
      rateLimitGapObserved: true,
      sourceHasGaps: true,
    })
  })

  it('marks malformed provider session metadata as an explicit source gap', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.entry',
        data: {
          source: 'session-meta',
          entryByteOffset: 22,
          providerSessionMetaValid: false,
        },
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      malformedProviderSessionMetaObserved: true,
      sourceHasGaps: true,
    })
  })

  it('marks suppressed attachment relations as an explicit source gap', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.attachment',
        data: { decision: 'hold', suppressed: 3 },
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      attachmentSuppressionObserved: true,
      sourceHasGaps: true,
    })
  })

  it('marks malformed JSON as global uncertainty while preserving complete rows', async () => {
    const valid = journalEvent({
      seq: 2,
      sessionId: CODEX_PANE_ID,
      name: 'transcript.snapshot',
      data: { entryCount: 1, totalEntries: 1 },
    })
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `{"schemaVersion":1\n${JSON.stringify(valid)}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const body = readFileSync(join(bundlePath, 'codex-transcript-observations.jsonl'), 'utf8')
    expect(body.trim().split('\n')).toHaveLength(1)
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      malformedJsonRows: 1,
      invalidChronologyRows: 0,
      matchedEvents: 1,
      sourceHasGaps: true,
    })
  })

  it('marks a scoped row with invalid chronology coordinates as a source gap', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        // A fractional sequence cannot order an append-only chronology even
        // though it is a finite JavaScript number. The exporter must not lend
        // authority to malformed direct journal producers.
        seq: 5.5,
        sessionId: CODEX_PANE_ID,
        name: 'transcript.snapshot',
        data: { entryCount: 99, totalEntries: 99 },
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      malformedJsonRows: 0,
      invalidChronologyRows: 1,
      matchedEvents: 0,
      writtenEvents: 0,
      sourceHasGaps: true,
    })
  })

  it('marks descending scoped chronology rows as a source gap', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      [
        journalEvent({
          seq: 8,
          monotonicMs: 80,
          sessionId: CODEX_PANE_ID,
          name: 'transcript.snapshot',
          data: { entryCount: 8, totalEntries: 8 },
        }),
        journalEvent({
          seq: 7,
          monotonicMs: 70,
          sessionId: CODEX_PANE_ID,
          name: 'transcript.snapshot',
          data: { entryCount: 7, totalEntries: 7 },
        }),
      ].map(row => JSON.stringify(row)).join('\n') + '\n',
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const observations = readFileSync(
      join(bundlePath, 'codex-transcript-observations.jsonl'),
      'utf8',
    ).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    expect(observations.map(row => row.seq)).toEqual([8])
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      invalidChronologyRows: 1,
      matchedEvents: 1,
      writtenEvents: 1,
      sourceHasGaps: true,
    })
  })

  it('fails the named observation projection closed for a non-UUID scope', async () => {
    const unsafeScope = '/private/path/that-could-contain-a-prompt'
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: unsafeScope,
        name: 'transcript.snapshot',
        data: { entryCount: 1 },
      }))}\n`,
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { bundlePath } = await saveDebugBundle({
      sessionId: unsafeScope,
      kind: 'codex',
      reason: 'manual',
      files: bundleFiles(),
    }, COMPLETE_JOURNAL_SOURCE)

    const namedBody = readFileSync(
      join(bundlePath, 'codex-transcript-observations.jsonl'),
      'utf8',
    )
    expect(namedBody).toBe('')
    expect(namedBody).not.toContain(unsafeScope)
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.codexTranscriptObservations).toMatchObject({
      scopeAccepted: false,
      matchedEvents: 0,
      sourceHasGaps: true,
    })
    warn.mockRestore()
  })

  it('keeps autosave identity-only even when observations exist', async () => {
    writeFileSync(
      join(INCIDENT_ROOT, APP_RUN_ID, 'events.jsonl'),
      `${JSON.stringify(journalEvent({
        seq: 1,
        sessionId: CODEX_PANE_ID,
        name: 'submit.write',
      }))}\n`,
    )

    const { bundlePath } = await saveDebugBundle({
      sessionId: CODEX_PANE_ID,
      kind: 'codex',
      reason: 'autosave-interval',
      files: bundleFiles(),
    })

    expect(existsSync(join(bundlePath, 'codex-transcript-observations.jsonl'))).toBe(false)
    const manifest = JSON.parse(readFileSync(join(bundlePath, 'manifest.json'), 'utf8'))
    expect(manifest.files).toEqual(['manifest.json'])
    expect(manifest).not.toHaveProperty('codexTranscriptObservations')
  })
})
