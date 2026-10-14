import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// One MCP call as one line (#1519) on RECORDED Claude calls
// (testing/fixtures/claude-mcp-calls/samples.json: the owner's own
// transcripts; acks, a validation error, a navigate failure with ANSI, a
// refusal), through the real Claude mapper and dispatch.

type Sample = { kind: string; tool: string; lines: Array<Record<string, unknown>> }
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../testing/fixtures/claude-mcp-calls/samples.json'), 'utf8')) as { samples: Sample[] }

function pair(kind: string, tool: string): { toolUse: ToolUseBlock; result: ToolResultBlock } {
  const sample = fixture.samples.find((entry) => entry.kind === kind && entry.tool.endsWith(`__${tool}`))
  if (!sample) throw new Error(`no recorded ${kind} ${tool}`)
  const mapper = getRendererProviderCapabilities('claude').createTranscriptEntryMapper()
  const blocks = sample.lines.flatMap((line) => mapper.map(line).entries)
    .flatMap((entry) => ((entry as { message?: { content?: unknown } }).message?.content as Array<Record<string, unknown>>) ?? [])
  return {
    toolUse: blocks.find((block) => block.type === 'tool_use') as unknown as ToolUseBlock,
    result: blocks.find((block) => block.type === 'tool_result') as unknown as ToolResultBlock,
  }
}

function decide(kind: string, tool: string, withResult = true) {
  const { toolUse, result } = pair(kind, tool)
  const decision = renderClaudeOperation({ toolUse, result: withResult ? result : null, live: !withResult, streaming: false })
  if (decision.toolUse.action === 'render') render(<>{decision.toolUse.node}</>)
  return decision
}

describe('an MCP call is one line', () => {
  it('an acknowledgement is the call and a ✓; its "ok: true" row is absorbed', () => {
    const decision = decide('ack', 'goal_set')
    expect(decision.toolResult).toMatchObject({ action: 'absorb' })
    expect(screen.getByText('goal_set')).toBeTruthy()
    expect(screen.getByText(/Build an accurate picture of what Agent Code is/)).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy()
    // The old chip and disclosures are gone from this call.
    expect(screen.queryByText(/1 param/)).toBeNull()
    expect(screen.queryByText(/ok: true/)).toBeNull()
  })

  it('every recorded acknowledgement is absorbed', () => {
    for (const tool of ['goal_set', 'tldr_update', 'browser_open']) {
      expect(decide('ack', tool).toolResult, tool).toMatchObject({ action: 'absorb' })
    }
  })

  it('an error says so, with its own sentence', () => {
    decide('error', 'goal_set')
    expect(screen.getByText('✕ error')).toBeTruthy()
    expect(screen.getByText(/Input validation error: Invalid arguments for tool goal_set/)).toBeTruthy()
  })

  it('an error\'s terminal escapes are not printed', () => {
    decide('error', 'browser_navigate')
    const message = screen.getByText(/page.reload: net::ERR_ABORTED/)
    expect(message.textContent).not.toMatch(/\u001b\[/)
  })

  it('a refusal ({"ok":false}) shows its message, not the JSON', () => {
    decide('refusal', 'browser_status')
    expect(screen.getByText('✕ refused')).toBeTruthy()
    expect(screen.getByText(/Browser Pocket is turned off/)).toBeTruthy()
    expect(screen.queryByText(/"code"/)).toBeNull()
  })

  it('a call still waiting shows it is waiting', () => {
    decide('ack', 'goal_set', false)
    expect(screen.getByText('◌')).toBeTruthy()
  })

  it('real content keeps the shared result row', () => {
    // Mechanical mutation of the recorded ack into a content-bearing result.
    const { toolUse, result } = pair('ack', 'browser_open')
    const content = { ...result, content: [{ type: 'text', text: 'Opened http://localhost:5199 in the pocket.' }] } as ToolResultBlock
    const decision = renderClaudeOperation({ toolUse, result: content, live: false, streaming: false })
    expect(decision.toolResult).toMatchObject({ action: 'fallback' })
  })
})
