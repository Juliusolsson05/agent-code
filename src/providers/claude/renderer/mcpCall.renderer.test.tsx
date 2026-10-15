import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireEvent, render, screen } from '@testing-library/react'
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

  it('only a payload-free acknowledgement is absorbed (review A1, B1)', () => {
    for (const tool of ['goal_set', 'tldr_update']) {
      expect(decide('ack', tool).toolResult, tool).toMatchObject({ action: 'absorb' })
    }
    // browser_open answers {ok, state, url}: the final URL is a payload, so
    // the line gets its ✓ and the result row stays.
    expect(decide('ack', 'browser_open').toolResult).toMatchObject({ action: 'fallback' })
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
    expect(screen.getByText(/✕ refused disabled/)).toBeTruthy()
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

// ---------------------------------------------------------------------------
// Review round on #1520. Mechanical mutations of the recorded samples,
// each named for the finding it pins.
// ---------------------------------------------------------------------------
function mutated(kind: string, tool: string, change: { name?: string; content?: unknown; is_error?: boolean; input?: Record<string, unknown> }) {
  const { toolUse, result } = pair(kind, tool)
  const use = { ...toolUse, ...(change.name ? { name: change.name } : {}), ...(change.input ? { input: change.input } : {}) } as ToolUseBlock
  const res = { ...result, ...(change.content !== undefined ? { content: change.content } : {}), ...(change.is_error !== undefined ? { is_error: change.is_error } : {}) } as ToolResultBlock
  return { use, res }
}

describe('nothing a user needs is hidden behind a ✓ (review round)', () => {
  it('an Agent Code read\'s payload keeps its row (A1: browser_console\'s entries)', () => {
    const { use, res } = mutated('ack', 'goal_set', { name: 'mcp__agent_code__browser_console', input: {}, content: [{ type: 'text', text: '{"ok":true,"entries":[{"level":"error","text":"TypeError: x is undefined"}]}' }] })
    expect(renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false }).toolResult).toMatchObject({ action: 'fallback' })
  })

  it('a third-party server\'s ok:true reply keeps its row (A3)', () => {
    const { use, res } = mutated('ack', 'goal_set', { name: 'mcp__github__set_goal' })
    expect(renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false }).toolResult).toMatchObject({ action: 'fallback' })
  })

  it('an acknowledgement with an image part keeps its row (A4)', () => {
    const { result } = pair('ack', 'goal_set')
    const { use, res } = mutated('ack', 'goal_set', { content: [...(result.content as unknown[]), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] })
    expect(renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false }).toolResult).toMatchObject({ action: 'fallback' })
  })

  it('an error\'s full text is one click away on the line (A5)', () => {
    decide('error', 'goal_set')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/expected string, received undefined at text/, { selector: 'pre' })).toBeTruthy()
  })

  it('the arguments are one click away (B9)', () => {
    decide('ack', 'goal_set')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/"text": "Build an accurate picture/, { selector: 'pre' })).toBeTruthy()
  })
})

describe('states (review round)', () => {
  it('a committed call with no result does not claim to be running (B2)', () => {
    const { toolUse } = pair('ack', 'goal_set')
    const decision = renderClaudeOperation({ toolUse, result: null, live: false, streaming: false })
    if (decision.toolUse.action === 'render') render(<>{decision.toolUse.node}</>)
    expect(screen.queryByText('◌')).toBeNull()
  })

  it('a user\'s decline reads as declined, not as a red error (B4)', () => {
    const { use, res } = mutated('error', 'goal_set', { content: "The user doesn't want to proceed with this tool use. The tool use was rejected." })
    const decision = renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false })
    if (decision.toolUse.action === 'render') render(<>{decision.toolUse.node}</>)
    expect(screen.getByText('declined')).toBeTruthy()
    expect(screen.queryByText('✕ error')).toBeNull()
  })

  it('keeps the result row for an error longer than the disclosure holds (review of #1523)', () => {
    // Mechanical mutation of the recorded goal_set error, padded past 16 KiB:
    // the line's disclosure would cut the tail, the shared row pages it all.
    const { use, res } = mutated('error', 'goal_set', { content: `MCP error -32602: ${'z'.repeat(17_000)} END-OF-DIAGNOSTIC` })
    const decision = renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false })
    expect(decision.toolResult).toMatchObject({ action: 'fallback' })
  })

  it('a drifted Agent Code orchestration call keeps the visible generic fallback (A2)', () => {
    const { use, res } = mutated('ack', 'goal_set', { name: 'mcp__agent_code__orchestration_read_agent', input: {} })
    const decision = renderClaudeOperation({ toolUse: use, result: res, live: false, streaming: false })
    if (decision.toolUse.action === 'render') {
      const { container } = render(<>{decision.toolUse.node}</>)
      expect(container.querySelector('[data-mcp-call]')).toBeNull()
    }
    expect(decision.toolResult).not.toMatchObject({ action: 'absorb' })
  })

  it('a verdict has words for a screen reader (B6)', () => {
    decide('ack', 'goal_set')
    expect(screen.getByText('succeeded')).toBeTruthy()
  })
})
