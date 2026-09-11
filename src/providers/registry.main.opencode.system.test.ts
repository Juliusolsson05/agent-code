import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProjectionDatabase } from 'opencode-terminal-headless/testing'

// Listing has no process dependency. Keep factories importable without
// loading their Electron PTY bindings; the registry and SQLite store are real.
vi.mock('@providers/claude/runtime/claudeSession', () => ({ ClaudeSession: class {} }))
vi.mock('@providers/codex/runtime/codexSession', () => ({ CodexSession: class {} }))
vi.mock('@providers/opencode/runtime/opencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('@providers/opencode/runtime/opencodeTerminalSession', () => ({ OpencodeTerminalSession: class {} }))

import { getMainProvider } from './registry.main'
import { createOpencodeDatabase, opencodeDatabase, type OpencodeDatabase } from './opencode/runtime/opencodeDatabase'
import { DatabaseSync } from './opencode/runtime/opencodeDatabase.testSupport'

let dir = ''
let database: OpencodeDatabase | undefined
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-session-list-')) })
afterEach(() => {
  vi.restoreAllMocks()
  database?.release()
  database = undefined
  rmSync(dir, { recursive: true, force: true })
})

function seed() {
  const path = join(dir, 'opencode.db')
  createProjectionDatabase([], path)
  const writer = new DatabaseSync(path)
  try {
    // The package fixture intentionally omits the unrelated project table.
    writer.exec('PRAGMA foreign_keys = OFF')
    // Deliberately insert out of order and make the child newest. These rows
    // are the independent oracle for cwd filtering, root-only discovery,
    // limit-after-filter, and the registry's user-visible metadata projection.
    const insert = writer.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [id, parent, cwd, title, updated] of [
      ['ses_older', null, '/project/a', 'Older root', 100],
      ['ses_other', null, '/project/b', 'Other directory', 400],
      ['ses_child', 'ses_newer', '/project/a', 'Task child', 900],
      ['ses_newer', null, '/project/a', 'Newest root', 300],
    ] as const) insert.run(id, 'project', parent, id, cwd, title, '1.18.30', 1, updated)
  } finally { writer.close() }
  database = createOpencodeDatabase({ resolveDbPath: async () => path })
  // Only path discovery is substituted: never run an installed `opencode db`
  // command or read the developer's real sessions in a deterministic test.
  vi.spyOn(opencodeDatabase, 'store').mockImplementation(() => database!.store())
}

it('lists only the requested directory roots, newest first, with picker metadata', async () => {
  seed()
  const provider = getMainProvider('opencode')
  await expect(provider.listSessions('/project/a', 20)).resolves.toEqual([
    { sessionId: 'ses_newer', summary: 'Newest root', lastModified: 300, fileSize: 0, cwd: '/project/a' },
    { sessionId: 'ses_older', summary: 'Older root', lastModified: 100, fileSize: 0, cwd: '/project/a' },
  ])
  await expect(provider.listSessions('/project/a', 1)).resolves.toEqual([
    { sessionId: 'ses_newer', summary: 'Newest root', lastModified: 300, fileSize: 0, cwd: '/project/a' },
  ])
  await expect(provider.listSessions('/project/b', 20)).resolves.toEqual([
    { sessionId: 'ses_other', summary: 'Other directory', lastModified: 400, fileSize: 0, cwd: '/project/b' },
  ])
  await expect(provider.listSessions('/missing', 20)).resolves.toEqual([])
})

it('lists every project newest-first for the no-cwd native history control', async () => {
  seed()
  const provider = getMainProvider('opencode')
  // The global control has no ambient cwd, so each row must carry its OWN
  // directory: resuming one of these spawns OpenCode there, and inheriting the
  // caller's directory instead would silently move the session's project.
  await expect(provider.listAllSessions!(20)).resolves.toEqual([
    { sessionId: 'ses_other', summary: 'Other directory', lastModified: 400, fileSize: 0, cwd: '/project/b' },
    { sessionId: 'ses_newer', summary: 'Newest root', lastModified: 300, fileSize: 0, cwd: '/project/a' },
    { sessionId: 'ses_older', summary: 'Older root', lastModified: 100, fileSize: 0, cwd: '/project/a' },
  ])
  // The task child is newest of all and still absent: a child is an
  // implementation detail of its parent's turn, not a resumable conversation.
  await expect(provider.listAllSessions!(1)).resolves.toEqual([
    { sessionId: 'ses_other', summary: 'Other directory', lastModified: 400, fileSize: 0, cwd: '/project/b' },
  ])
})
