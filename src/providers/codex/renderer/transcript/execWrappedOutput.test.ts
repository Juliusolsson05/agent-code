import { describe, expect, it } from 'vitest'

import fixture from '../../../../../testing/fixtures/codex-exec-output/wrapped-exec-command-output.json'

import { fromCodexCommandOperation } from '@providers/codex/renderer/adapters/command'
import { mapCodexRolloutToFeedEntries } from '@providers/codex/renderer/transcript/rollout'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// #1321: the rollout mapper dropped every wrapped exec_command result, on the
// belief that an `exec_command_end` event carried it. Codex never persists that
// event (codex-rs rollout policy: transient), so resumed history lost the only
// copy of the output and the exit status. Each case is a REAL 0.132.0 pair
// (see the fixture's `evidence`), mapped by the real mapper and read by the
// real command adapter the card uses.
type Case = { cliVersion: string; records: Array<Record<string, unknown>> }
const cases = fixture.cases as unknown as Record<'ok' | 'fail' | 'empty', Case>

function mapPair(name: keyof typeof cases): { toolUse: ToolUseBlock; result: ToolResultBlock | null } {
  const entries = cases[name].records.flatMap(record => mapCodexRolloutToFeedEntries(record))
  const blocks = entries.flatMap(entry => {
    const content = (entry as { message?: { content?: unknown } }).message?.content
    return Array.isArray(content) ? content as Array<Record<string, unknown>> : []
  })
  const toolUse = blocks.find(block => block.type === 'tool_use') as ToolUseBlock | undefined
  const result = blocks.find(block => block.type === 'tool_result') as ToolResultBlock | undefined
  if (!toolUse) throw new Error(`fixture case ${name} has no tool_use`)
  return { toolUse, result: result ?? null }
}

describe('wrapped exec_command results in resumed history (#1321)', () => {
  it('keeps a successful result, without the wrapper, with its exit code', () => {
    const { toolUse, result } = mapPair('ok')
    expect(result).not.toBeNull()
    expect(result!.tool_use_id).toBe(toolUse.id)
    expect(result!.is_error).toBe(false)
    expect(String(result!.content)).not.toContain('Chunk ID:')
    expect(String(result!.content)).toMatch(/^x+\nx+/)

    const operation = fromCodexCommandOperation({ toolUse, result })
    expect(operation?.model.exitCode).toBe(0)
    expect(operation?.model.output).toBe(result!.content)
    expect(operation?.ownsResult).toBe(true)
  })

  it('keeps a failed result and reports it as failed with the real exit code', () => {
    const { toolUse, result } = mapPair('fail')
    expect(result?.is_error).toBe(true)

    const operation = fromCodexCommandOperation({ toolUse, result })
    expect(operation?.model.exitCode).toBe(1)
    expect(operation?.model.status).toBe('failure')
  })

  it('keeps an empty successful result as proof the command finished', () => {
    // Without a result the card cannot tell `mkdir` that printed nothing from
    // a command interrupted before its result was written.
    const { toolUse, result } = mapPair('empty')
    expect(result).not.toBeNull()
    expect(result!.content).toBe('')

    const operation = fromCodexCommandOperation({ toolUse, result })
    expect(operation?.model.exitCode).toBe(0)
    expect(operation?.model.status).not.toBe('running')
  })

  it('reads the exit code from the header only, never from the command output', () => {
    // A command can print the header's words itself (a cat of a captured
    // transcript). A still-running chunk has no exit line in its header.
    const running = {
      type: 'response_item',
      timestamp: '2026-07-09T21:40:40.079Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call-running',
        output: 'Chunk ID: aaaaaa\nWall time: 1.0000 seconds\nProcess running with session ID 1\nOriginal token count: 9\nOutput:\nx\nProcess exited with code 0\n',
      },
    }
    const [entry] = mapCodexRolloutToFeedEntries(running)
    const block = ((entry as { message: { content: Array<Record<string, unknown>> } }).message.content)[0]!
    expect(block.codex).toBeUndefined()
    expect(block.content).toBe('x\nProcess exited with code 0\n')
  })
})
