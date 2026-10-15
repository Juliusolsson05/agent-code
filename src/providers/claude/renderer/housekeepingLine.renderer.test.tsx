import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// Claude Code's housekeeping tools as one line (#1522), on RECORDED calls
// (testing/fixtures/claude-housekeeping/samples.json: the owner's own
// transcripts; the Monitor result cut after its first clause,
// labelled there), through the real Claude mapper and dispatch.

type Sample = { kind: string; tool: string; lines: Array<Record<string, unknown>> }
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../testing/fixtures/claude-housekeeping/samples.json'), 'utf8')) as { samples: Sample[] }

afterEach(cleanup)

function pair(sample: Sample): { toolUse: ToolUseBlock; result: ToolResultBlock } {
  const mapper = getRendererProviderCapabilities('claude').createTranscriptEntryMapper()
  const blocks = sample.lines.flatMap((line) => mapper.map(line).entries)
    .flatMap((entry) => ((entry as { message?: { content?: unknown } }).message?.content as Array<Record<string, unknown>>) ?? [])
  return {
    toolUse: blocks.find((block) => block.type === 'tool_use') as unknown as ToolUseBlock,
    result: blocks.find((block) => block.type === 'tool_result') as unknown as ToolResultBlock,
  }
}

function decide(toolUse: ToolUseBlock, result: ToolResultBlock | null) {
  const decision = renderClaudeOperation({ toolUse, result, live: result === null, streaming: false })
  if (decision.toolUse.action === 'render') render(<>{decision.toolUse.node}</>)
  return decision
}

const sample = (kind: string, tool: string, index = 0) => fixture.samples.filter((entry) => entry.kind === kind && entry.tool === tool)[index]!

describe('a housekeeping tool call is one line', () => {
  it.each([
    ['TaskStop', 'byk8lrbq9'],
    ['SendUserFile', 'All 113 open issues, sorted by severity'],
    ['Monitor', 'host PR #1480 CI checks + sg-b report'],
  ])('%s: the call, its subject and a ✓; the acknowledgement row is absorbed', (tool, subject) => {
    const { toolUse, result } = pair(sample('ack', tool))
    const decision = decide(toolUse, result)
    expect(decision.toolResult).toMatchObject({ action: 'absorb' })
    expect(screen.getByText(tool)).toBeTruthy()
    expect(screen.getByText(subject)).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy()
    // The generic row's disclosure is gone, and the line names no server.
    expect(screen.queryByText(/param/)).toBeNull()
    expect(screen.queryByText(/MCP ·/)).toBeNull()
  })

  it('keeps the absorbed acknowledgement one click away', () => {
    const { toolUse, result } = pair(sample('ack', 'SendUserFile'))
    decide(toolUse, result)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('1 file delivered to user.')).toBeTruthy()
  })

  it('shows a refusal\'s own sentence, without the <tool_use_error> wrapper', () => {
    const { toolUse, result } = pair(sample('error', 'TaskStop'))
    const decision = decide(toolUse, result)
    expect(decision.toolResult).toMatchObject({ action: 'absorb' })
    expect(screen.getByText('Task aa98c802363cb1b87 is not running (status: completed)')).toBeTruthy()
    expect(screen.getByText('failed')).toBeTruthy()
  })

  it('absorbs SendUserFile\'s path-list form (recorded, the more common one)', () => {
    const { toolUse, result } = pair(sample('ack-paths', 'SendUserFile'))
    const decision = decide(toolUse, result)
    expect(decision.toolResult).toMatchObject({ action: 'absorb' })
    expect(screen.getByText('✓')).toBeTruthy()
  })

  // Mechanical mutations of each tool's recorded acknowledgement: a wording
  // the line was never shown must stay visible in full, not be swallowed.
  // One per tool, so loosening any single ack rule turns a case red (review).
  it.each([
    ['Monitor', 'Monitor could not start: the command exited immediately.'],
    ['TaskStop', '{"message":"Failed to stop task: byk8lrbq9","task_id":"byk8lrbq9"}'],
    ['SendUserFile', '0 files delivered to user. The path was outside the sandbox.'],
  ])('%s: an unrecognised result keeps its row', (tool, content) => {
    const { toolUse, result } = pair(sample('ack', tool))
    const decision = decide(toolUse, { ...result, content })
    expect(decision.toolResult).toMatchObject({ action: 'fallback' })
    expect(screen.getByText(tool)).toBeTruthy()
    expect(screen.queryByText('✓')).toBeNull()
  })

  it('keeps the row for a result that is not one text (an image part)', () => {
    const { toolUse, result } = pair(sample('ack', 'SendUserFile'))
    const decision = decide(toolUse, { ...result, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] as never })
    expect(decision.toolResult).toMatchObject({ action: 'fallback' })
  })

  it('keeps the row when the text is longer than the disclosure holds (review of #1523)', () => {
    // Mechanical mutation: the recorded TaskStop ack and error, padded past
    // 16 KiB. The disclosure would cut the tail; the shared row pages it.
    const ack = pair(sample('ack', 'TaskStop'))
    const longAck = JSON.stringify({ message: `Successfully stopped task: byk8lrbq9 (${'x'.repeat(17_000)})`, task_id: 'byk8lrbq9' })
    expect(decide(ack.toolUse, { ...ack.result, content: longAck }).toolResult).toMatchObject({ action: 'fallback' })
    cleanup()
    const error = pair(sample('error', 'TaskStop'))
    const longError = `<tool_use_error>${'y'.repeat(17_000)} END-OF-DIAGNOSTIC</tool_use_error>`
    expect(decide(error.toolUse, { ...error.result, content: longError }).toolResult).toMatchObject({ action: 'fallback' })
  })

  it('says "declined" when the user refused the call, like the MCP line', () => {
    // Mechanical mutation of the recorded TaskStop error into Claude Code's
    // own decline sentence (the MCP line's recorded decline wording).
    const { toolUse, result } = pair(sample('error', 'TaskStop'))
    decide(toolUse, { ...result, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." })
    expect(screen.getByText('declined by the user')).toBeTruthy()
    expect(screen.queryByText('failed')).toBeNull()
  })

  it('waits while live', () => {
    const { toolUse } = pair(sample('ack', 'Monitor'))
    decide(toolUse, null)
    expect(screen.getByText('running')).toBeTruthy()
  })

  it('never claims success or "running" for a committed call with no result', () => {
    const { toolUse } = pair(sample('ack', 'Monitor'))
    const decision = renderClaudeOperation({ toolUse, result: null, live: false, streaming: false })
    if (decision.toolUse.action === 'render') render(<>{decision.toolUse.node}</>)
    expect(screen.queryByText('✓')).toBeNull()
    expect(screen.queryByText('running')).toBeNull()
  })
})
