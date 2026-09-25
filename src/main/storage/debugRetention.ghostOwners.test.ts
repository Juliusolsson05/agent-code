import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

// The production path of #732's fix (#1223 review A): provider -> policy ->
// prune, over real files. Every other test calls runPrunePasses or
// ghostLogOwnersFrom directly, so dropping the wiring (or making a throwing
// provider read as "no owners") left them all green. Only the state paths are
// redirected, into a temp dir.
const root = mkdtempSync(join(tmpdir(), 'ac-ghost-owners-'))
const ghostDir = join(root, 'ghost-logs')

vi.mock('@main/storage/paths.js', () => ({
  AUTOSAVE_DEBUG_BUNDLE_DIR: join(root, 'bundles-autosave'),
  DEBUG_BUNDLE_DIR: join(root, 'bundles'),
  FEED_DEBUG_DIR: join(root, 'feed-debug'),
  HEAP_SNAPSHOT_DIR: join(root, 'heap'),
  INCIDENT_RUNS_DIR: join(root, 'incidents'),
  MANUAL_DEBUG_BUNDLE_DIR: join(root, 'bundles-manual'),
  PERFORMANCE_RUNS_DIR: join(root, 'performance'),
  PROXY_EVENTS_DIR: join(root, 'proxy'),
  SESSION_RECORDING_DIR: join(root, 'recordings'),
  STATE_DIR: root,
}))
vi.mock('@main/ghostJournal.js', () => ({ ghostLogDir: () => ghostDir }))
vi.mock('@main/storage/debugBundleLog.js', () => ({
  DEBUG_BUNDLE_LOG_FILE: join(root, 'debug-bundles.jsonl'),
  isAutosaveDebugBundleReason: () => false,
}))

const { pruneDebugStorage, setGhostLogOwnersProvider } = await import('./debugRetention.js')

const DAY = 24 * 60 * 60 * 1000

function ghostLog(sessionId: string, ageMs: number): string {
  mkdirSync(ghostDir, { recursive: true })
  const path = join(ghostDir, `${sessionId}.ghost.jsonl`)
  writeFileSync(path, '{"uuid":"g1"}\n')
  const when = (Date.now() - ageMs) / 1000
  utimesSync(path, when, when)
  return path
}

afterEach(() => {
  setGhostLogOwnersProvider(null)
  rmSync(ghostDir, { recursive: true, force: true })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('ghost-log owners through the real prune entry point (#732, #1223)', () => {
  it('deletes an old orphan and keeps an old owned log', async () => {
    const orphan = ghostLog('gone-1', 3 * DAY)
    const owned = ghostLog('live-1', 3 * DAY)
    setGhostLogOwnersProvider(() => new Set(['live-1']))

    await pruneDebugStorage('test')

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(owned)).toBe(true)
  })

  it('deletes nothing when the owners are unknown', async () => {
    const orphan = ghostLog('gone-1', 3 * DAY)
    setGhostLogOwnersProvider(() => null)

    await pruneDebugStorage('test')

    expect(existsSync(orphan)).toBe(true)
  })

  it('deletes nothing when the provider throws', async () => {
    // A store or manager touched during teardown can throw. That must read
    // as unknown, never as "no owners".
    const orphan = ghostLog('gone-1', 3 * DAY)
    setGhostLogOwnersProvider(() => { throw new Error('store disposed') })

    await pruneDebugStorage('test')

    expect(existsSync(orphan)).toBe(true)
  })
})
