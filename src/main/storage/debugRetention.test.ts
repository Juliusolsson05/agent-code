import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { collectSessionRecordingDirs } from './debugRetention.js'

// Folder-atomic session-recording retention (plan §4, #388/#467).
//
// The one property that MUST hold: retention treats a recording folder as a
// single deletable unit, never as a bag of files. If the collector ever
// emitted per-file artifacts, a prune pass could shed events.jsonl and orphan
// meta.json — a half-recording that no longer loads and no longer counts
// against the bucket. These tests pin the collection layer where that bug
// would live (kind:'dir', one artifact per folder), which is what routes the
// prune to removeArtifact's `rm -rf` branch downstream.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rec-retention-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeRecording(id: string, eventsBytes: number): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ v: 1, recordingId: id, sessionId: id, startedAtWall: Date.now() }),
  )
  // A non-trivial events file so byte accounting is observable — the folder's
  // reported size must include BOTH files, proving whole-folder accounting.
  writeFileSync(join(dir, 'events.jsonl'), 'x'.repeat(eventsBytes))
}

describe('collectSessionRecordingDirs', () => {
  it('emits exactly one dir-kind artifact per recording folder', async () => {
    makeRecording('2026-07-07T00-00-00-000-s1', 1000)
    makeRecording('2026-07-07T00-01-00-000-s2', 2000)

    const artifacts = await collectSessionRecordingDirs(root)

    expect(artifacts).toHaveLength(2)
    // Every artifact is a directory: this is the whole-folder-atomic guarantee.
    // removeArtifact(kind:'dir') is the only branch that does rm -rf, so a
    // recording is deleted as one unit iff it arrives here as kind:'dir'.
    for (const artifact of artifacts) {
      expect(artifact.kind).toBe('dir')
      expect(artifact.bucket).toBe('session-recordings')
    }
  })

  it('accounts the whole folder (meta.json + events.jsonl), not a single file', async () => {
    makeRecording('2026-07-07T00-00-00-000-s1', 5000)

    const [artifact] = await collectSessionRecordingDirs(root)

    // The events file alone is 5000 bytes; meta.json adds more. If the
    // collector were per-file (the bug we guard against) it could report just
    // one file's size. Whole-folder accounting must exceed the events size.
    expect(artifact.bytes).toBeGreaterThan(5000)
  })

  it('returns nothing when the recordings root does not exist', async () => {
    // First app run, or recording never enabled: the dir is absent. Retention
    // must treat that as an empty bucket, not throw and abort the whole sweep.
    const artifacts = await collectSessionRecordingDirs(join(root, 'does-not-exist'))
    expect(artifacts).toEqual([])
  })
})
