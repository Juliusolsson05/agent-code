// Live gate against the real `agy acp` on this machine, with the user's own
// Antigravity login. Opt-in only: ANTIGRAVITY_LIVE=1 (and AGY_BINARY to point
// at a non-PATH install). It runs two short prompts on the user's plan:
//
//   npx vitest run --config vitest.live.config.ts packages/antigravity-acp-headless
//
// What it proves end to end: session/new, streamed text, a tool turn whose
// permission request is answered through respondPermission, rows committed
// with ordinal keys, and session/load replaying the SAME rows under the SAME
// keys in a fresh process (the property history and reloads depend on).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { AntigravityAcpSession } from './AntigravityAcpSession.js'
import type { AntigravityRow, AntigravitySemanticEvent } from './transcript/assembler.js'

const LIVE = process.env.ANTIGRAVITY_LIVE === '1'
const AGY = process.env.AGY_BINARY ?? 'agy'

const children: ChildProcessWithoutNullStreams[] = []
const dirs: string[] = []
afterAll(() => {
  for (const child of children) child.kill()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function startAgy(cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(AGY, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  return child
}

describe.skipIf(!LIVE)('AntigravityAcpSession against real agy', () => {
  it('runs, asks permission, commits rows and replays them identically', async () => {
    // Any folder works: agy acp opens sessions in folders the user never
    // trusted in agy's TUI, and does not add them to its trusted list
    // (recorded on 1.5.15). ANTIGRAVITY_LIVE_CWD pins a folder to inspect
    // afterwards; otherwise a fresh temp dir is used and removed.
    const cwd = process.env.ANTIGRAVITY_LIVE_CWD ?? mkdtempSync(join(tmpdir(), 'agy-live-'))
    if (!process.env.ANTIGRAVITY_LIVE_CWD) dirs.push(cwd)
    writeFileSync(join(cwd, 'live-note.txt'), 'antigravity-live-ok\n')

    const child = startAgy(cwd)
    const session = new AntigravityAcpSession({ input: child.stdout, output: child.stdin, cwd })
    const rows: AntigravityRow[] = []
    const semantic: AntigravitySemanticEvent[] = []
    session.on('row', row => rows.push(row))
    session.on('semantic', event => semantic.push(event))
    const asked: string[] = []
    session.on('conditions', snapshot => {
      const permission = snapshot.conditions['antigravity.permission']
      const state = permission?.state as { requestKey: string; options: Array<{ optionId: string; kind: string }> } | undefined
      if (!state) return
      asked.push(state.requestKey)
      const allow = state.options.find(option => option.kind === 'allow_once') ?? state.options[0]!
      session.respondPermission(state.requestKey, allow.optionId)
    })

    const { sessionId } = await session.start()
    expect(sessionId).toMatch(/[0-9a-f-]{36}/)
    const first = session.prompt('Reply with exactly the word: pong')
    await first.accepted
    expect(await first.finished).toBe('end_turn')
    const second = session.prompt('Run the shell command `cat live-note.txt` and reply with its output only.')
    expect(await second.finished).toBe('end_turn')
    await session.stop()
    child.kill()

    expect(asked.length).toBeGreaterThan(0)
    expect(semantic.some(event => event.type === 'text_delta')).toBe(true)
    expect(semantic.some(event => event.type === 'tool_result')).toBe(true)
    expect(rows.find(row => row.role === 'user')?.text).toBe('Reply with exactly the word: pong')
    const tool = rows.find(row => row.role === 'tool')
    expect(tool?.tool?.status).toBe('completed')
    expect(tool?.tool?.output ?? '').toContain('antigravity-live-ok')

    // A fresh process replays the conversation into the same keys.
    const replayChild = startAgy(cwd)
    const replay = new AntigravityAcpSession({ input: replayChild.stdout, output: replayChild.stdin, cwd, resumeSessionId: sessionId })
    const replayed: AntigravityRow[] = []
    replay.on('row', row => replayed.push(row))
    await replay.start()
    await replay.stop()
    replayChild.kill()
    const textKeys = (list: AntigravityRow[]) => list.filter(row => row.role !== 'thought').map(row => `${row.key}:${row.role}`)
    expect(textKeys(replayed.sort((a, b) => a.ordinal - b.ordinal))).toEqual(textKeys(rows.sort((a, b) => a.ordinal - b.ordinal)))
    if (process.env.ANTIGRAVITY_LIVE_RECORD) {
      writeFileSync(process.env.ANTIGRAVITY_LIVE_RECORD, JSON.stringify({ rows, replayed, semantic }, null, 1))
    }
    expect(readFileSync(join(cwd, 'live-note.txt'), 'utf8')).toBe('antigravity-live-ok\n')
  }, 240_000)
})
