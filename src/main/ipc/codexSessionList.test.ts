import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { listCodexSessions } from 'codex-headless'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true }),
  ))
})

describe('Codex resume session listing', () => {
  it('finds a cwd match when session_meta exceeds the historical byte-head limit', async () => {
    const codexRoot = await mkdtemp(join(tmpdir(), 'agent-code-codex-list-'))
    temporaryRoots.push(codexRoot)
    vi.stubEnv('CODEX_HOME', codexRoot)
    const dateDir = join(codexRoot, 'sessions', '2026', '08', '30')
    await mkdir(dateDir, { recursive: true })
    const sessionId = '01a0557d-f1a7-7830-bb44-e567be592195'
    const cwd = '/repo/.worktrees/codex-live-continuity'
    const file = join(
      dateDir,
      `rollout-2026-08-30T18-45-12-${sessionId}.jsonl`,
    )
    const meta = {
      timestamp: '2026-08-30T18:45:12.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd,
        timestamp: '2026-08-30T18:45:12.000Z',
        git: { branch: 'fix/codex-live-continuity' },
        base_instructions: 'x'.repeat(64 * 1024),
      },
    }
    const prompt = {
      timestamp: '2026-08-30T18:45:13.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'resume me after restart' },
    }
    await writeFile(file, `${JSON.stringify(meta)}\n${JSON.stringify(prompt)}\n`, 'utf8')

    const sessions = await listCodexSessions({ cwd, limit: 20 })

    // WHY the size assertion belongs beside the behavior assertion: a tidy
    // fixture can accidentally shrink below the old 16 KiB boundary and leave
    // the test green while no longer exercising the production failure.
    expect(JSON.stringify(meta).length).toBeGreaterThan(16 * 1024)
    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId,
        cwd,
        summary: 'resume me after restart',
        gitBranch: 'fix/codex-live-continuity',
      }),
    ])
  })
})
