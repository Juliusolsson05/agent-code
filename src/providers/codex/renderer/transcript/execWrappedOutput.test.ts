import { describe, expect, it } from 'vitest'

import fixture from '../../../../../testing/fixtures/codex-exec-output/wrapped-exec-command-output.json'

import { fromCodexCommandOperation } from '@providers/codex/renderer/adapters/command'
import { createCodexTranscriptEntryMapper } from '@providers/codex/renderer/transcript/mapper'
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
    // The exact metadata the event carrier stamps (#1395 review a: kind,
    // parsedCmd, command and cwd were unpinned; `kind` drives row absorption).
    expect((result as unknown as { codex: unknown }).codex).toEqual({
      kind: 'exec_command_end', parsedCmd: [], command: [], cwd: null, exitCode: 0,
    })

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
    // Marked running, with no exit claimed from the body's words.
    expect(block.codex).toEqual({ kind: 'exec_command_running' })
    expect(block.content).toBe('x\nProcess exited with code 0\n')
  })

  // A still-running chunk, as the fixture's real header shape with the
  // "running" line Codex writes in its place (9,896 in the local corpus).
  // Paired with the fixture's real exec_command call, so the adapter sees a
  // genuine invocation.
  const okCall = cases.ok.records[0]!
  const runningPair = () => [
    okCall,
    {
      type: 'response_item',
      timestamp: '2026-07-09T21:40:40.079Z',
      payload: {
        type: 'function_call_output',
        call_id: (okCall.payload as { call_id: string }).call_id,
        output: 'Chunk ID: aaaaaa\nWall time: 1.0000 seconds\nProcess running with session ID 42\nOriginal token count: 1\nOutput:\nworking\n',
      },
    },
  ]

  it('does not paint a still-running command as a success (#1395 review a, P1)', () => {
    const entries = runningPair().flatMap(record => mapCodexRolloutToFeedEntries(record))
    const blocks = entries.flatMap(entry => (entry as { message: { content: Array<Record<string, unknown>> } }).message.content)
    const toolUse = blocks.find(block => block.type === 'tool_use') as unknown as ToolUseBlock
    const result = blocks.find(block => block.type === 'tool_result') as unknown as ToolResultBlock

    const operation = fromCodexCommandOperation({ toolUse, result })
    // Its exit arrives on a later write_stdin result this card cannot see.
    expect(operation?.model.status).toBe('unknown')
    expect(operation?.model.exitCode).toBeNull()
  })

  // Extended-history rollouts (through rust-v0.136.0) can persist the event
  // next to the always-durable wrapper, with the same call_id. The wrapper is
  // the fuller carrier (the event's aggregated_output is sanitized to 10,000
  // bytes), so it must be the result the card ends up with (#1395 reviews a,
  // b). The feed's result index is later-wins.
  const cardResult = (records: Array<Record<string, unknown>>) => {
    const mapper = createCodexTranscriptEntryMapper()
    const results = records
      .flatMap(record => mapper.map(record).entries)
      .flatMap(entry => (entry as { message: { content: Array<Record<string, unknown>> } }).message.content)
      .filter(block => block.type === 'tool_result')
    return { results, card: results.at(-1) }
  }
  const [okCallRecord, okOutputRecord] = cases.ok.records
  const truncatedEvent = {
    type: 'event_msg',
    timestamp: '2026-07-09T21:40:40.000Z',
    payload: { type: 'exec_command_end', call_id: (okCallRecord!.payload as { call_id: string }).call_id, exit_code: 0, aggregated_output: 'truncated\n' },
  }
  const wrapperBody = () => String((okOutputRecord!.payload as { output: string }).output).split('\nOutput:\n')[1]

  it('hands the card the wrapper when the event came first (#1395 review b)', () => {
    const { card } = cardResult([okCallRecord!, truncatedEvent, okOutputRecord!])
    expect(card!.content).toBe(wrapperBody())
  })

  it('drops an event that arrives after its wrapper (#1395 review b)', () => {
    const { results } = cardResult([okCallRecord!, okOutputRecord!, truncatedEvent])
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toBe(wrapperBody())
  })

  it('makes no exit claim for a wrapper without its Output marker (#1395 review a, P3)', () => {
    const headerOnly = {
      type: 'response_item',
      timestamp: '2026-07-09T21:40:40.079Z',
      payload: {
        type: 'function_call_output',
        call_id: 'call-header-only',
        output: 'Chunk ID: aaaaaa\nWall time: 0.1000 seconds\nProcess exited with code 1\nOriginal token count: 0',
      },
    }
    const [entry] = mapCodexRolloutToFeedEntries(headerOnly)
    const block = (entry as { message: { content: Array<Record<string, unknown>> } }).message.content[0]!
    expect(block.codex).toEqual({ kind: 'exec_command_unparsed' })
  })

  it('shows an unparsed wrapper as unknown, never a success (#1395 review b)', () => {
    const unparsed = {
      type: 'response_item',
      timestamp: '2026-07-09T21:40:40.079Z',
      payload: {
        type: 'function_call_output',
        call_id: (okCall.payload as { call_id: string }).call_id,
        output: 'Chunk ID: aaaaaa\r\nWall time: 0.1000 seconds\r\nProcess exited with code 1\r\nOriginal token count: 0\r\nOutput:\r\nfailed\r\n',
      },
    }
    const blocks = [okCall, unparsed].flatMap(record => mapCodexRolloutToFeedEntries(record))
      .flatMap(entry => (entry as { message: { content: Array<Record<string, unknown>> } }).message.content)
    const toolUse = blocks.find(block => block.type === 'tool_use') as unknown as ToolUseBlock
    const result = blocks.find(block => block.type === 'tool_result') as unknown as ToolResultBlock
    const operation = fromCodexCommandOperation({ toolUse, result })
    expect(operation?.model.status).toBe('unknown')
    expect(operation?.model.exitCode).toBeNull()
  })
})
