import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { detectTrustDialog } from '../../../packages/claude-code-headless/src/parsers/TrustDialogParser'
import { buildClaudeTrustDialogCondition } from '../../../packages/claude-code-headless/src/conditions/trustDialog'
import { conditionBackendCapabilities } from './conditionControl'

// Recorded Claude 2.1.251 screen from debug bundle
// 2026-08-30T23-51-06-471-9bd68e14, as preserved in the pinned headless
// TrustDialogParser.test.ts (only its project path was neutralized upstream).
// Build the wire condition with the real parser/module: notably acceptance is
// a semantic resolver action, never the Enter byte that would choose "No".
const screen = readFileSync(new URL('../../../testing/fixtures/external-control/claude-trust-2.1.251.txt', import.meta.url), 'utf8')
const context = { requestId: 'condition-trial', caller: { kind: 'application' as const, id: 'renderer' }, owner: { kind: 'main' as const, generation: 'main' } }

it('routes the recorded trust choice intact and rejects stale process/dialog identity before input', async () => {
  const condition = buildClaudeTrustDialogCondition(detectTrustDialog(screen))!
  let runId = 'original-process'
  let current = condition
  const write = vi.fn().mockReturnValue(true)
  const resolveCondition = vi.fn().mockResolvedValue({ ok: true })
  const manager = {
    getBackendSnapshot: () => ({ sessionId: 'agent', sessionRunId: runId, cwd: '/tmp/fresh-project', kind: 'claude', lifecycle: 'live' }),
    getConditionsSnapshot: () => ({ provider: 'claude', conditions: { [current.kind]: current }, ts: Date.now() }),
    write, resolveCondition,
  } as unknown as Parameters<typeof conditionBackendCapabilities>[0]
  const capabilities = conditionBackendCapabilities(manager)
  const invoke = (id: string, input: unknown) => capabilities.find(item => item.descriptor.id === id)!.execute(input, context)
  const identity = { sessionId: 'agent', cwd: '/tmp/fresh-project', provider: 'claude' }
  const read = await invoke('sessions.conditionsRead', identity)
  if (!read.ok) throw new Error(JSON.stringify(read))
  const revision = (read.value as { revision: string }).revision
  const reply = { ...identity, kind: condition.kind, actionId: 'accept', revision }
  expect(await invoke('sessions.conditionsReply', reply)).toMatchObject({ ok: true, value: { accepted: true } })
  expect(resolveCondition).toHaveBeenCalledExactlyOnceWith('agent', condition.actions.find(action => action.id === 'accept'))
  expect(write).not.toHaveBeenCalled()
  runId = 'replacement-process'
  expect(await invoke('sessions.conditionsReply', reply)).toMatchObject({ ok: false, error: { code: 'stale_cursor', outcome: 'not_started' } })
  runId = 'original-process'
  current = { ...condition, state: { ...condition.state, workspace: '/different-project' } }
  expect(await invoke('sessions.conditionsReply', reply)).toMatchObject({ ok: false, error: { code: 'stale_cursor' } })
  expect(resolveCondition).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled()
})
