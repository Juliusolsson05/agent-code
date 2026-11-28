import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexLaunchHooks } from '@providers/shared/runtime/tldrHooks.js'

const root = await mkdtemp(join(tmpdir(), 'codex-launch-id-'))
const hooks: NonNullable<Awaited<ReturnType<typeof createCodexLaunchHooks>>>[] = []
afterEach(async () => {
  await Promise.all(hooks.splice(0).map(hook => hook.dispose()))
  await rm(root, { recursive: true, force: true })
})

async function launch() {
  const hook = (await createCodexLaunchHooks([], root, true))!
  hooks.push(hook)
  const command = JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(hook.args.find(arg => arg.startsWith('hooks.SessionStart='))!)![1]!)
  const send = (session_id: string, override = {}) => execFileSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ session_id, source: 'startup', hook_event_name: 'SessionStart', ...override }),
  })
  const observed: string[] = []
  const owner = {
    observeProviderThreadIdentity: (id: string) => { observed.push(id) },
    getSessionMeta: () => observed[0] ? { id: observed[0] } : null,
  }
  return { hook, send, observed, owner }
}

it('keeps simultaneous private launches separate and waits for the root rollout to become durable', async () => {
  const [a, b] = await Promise.all([launch(), launch()])
  const sessions = join(root, 'sessions')
  await mkdir(sessions)
  const [idA, idB, child, stale] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()] as const
  async function writeRollout(id: string, source: unknown = 'cli') {
    await writeFile(join(sessions, `rollout-2026-11-28T12-00-00-${id}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/same/workspace', source } }) + '\n')
  }
  await Promise.all([writeRollout(idB), writeRollout(child, { subagent: {} }), writeRollout(stale)])
  a.send(stale, { source: 'resume' })
  a.send(stale, { hook_event_name: 'SubagentStart', agent_id: stale })
  a.send(stale, { transcript_path: `/elsewhere/rollout-date-${idB}.jsonl` })
  a.send(child)
  a.send(idA)
  a.hook.startup!.start(sessions, a.owner)
  b.hook.startup!.start(sessions, b.owner)
  b.send(idB)
  await vi.waitFor(() => expect(b.observed).toEqual([idB]))
  expect(a.observed).toEqual([])
  await writeRollout(idA)
  await vi.waitFor(() => expect(a.observed).toEqual([idA]))
})

it('revokes an observed startup hint when its launch ends before rollout creation', async () => {
  const a = await launch()
  const id = randomUUID()
  const sessions = join(root, 'sessions')
  await mkdir(sessions)
  a.hook.startup!.start(sessions, a.owner)
  a.send(id)
  await a.hook.dispose()
  await writeFile(join(sessions, `rollout-date-${id}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id, source: 'cli' } }) + '\n')
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(a.observed).toEqual([])
})
