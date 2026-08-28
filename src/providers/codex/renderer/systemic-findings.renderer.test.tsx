import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCodexOperation } from './rows/dispatch'
import committedExecFixture from '../../../../testing/fixtures/rendering-shapes/codex/exec/committed.json'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

function result(toolUse: ToolUseBlock, output: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: `Script completed\nWall time 0.1 seconds\nOutput:\n\n${output}`,
    is_error: false,
    codex: { kind: 'custom_tool_call_output' },
  } as ToolResultBlock & { codex: { kind: string } }
}

describe('systemic Codex operation rendering', () => {
  it('renders the recorded repository-wide rg operation as Search with honest status', () => {
    const sample = committedExecFixture.cases.find(
      candidate => candidate.expectedReceipt?.protocolId === 'command.search',
    )
    if (!sample?.toolResult) throw new Error('recorded Search fixture missing')
    const decision = renderCodexOperation({
      toolUse: sample.toolUse as ToolUseBlock,
      result: sample.toolResult as ToolResultBlock,
      live: false,
      streaming: false,
    })
    expect(decision.toolUse).toMatchObject({
      action: 'render',
      receipt: { rendererId: 'shared.command', protocolId: 'command.search' },
    })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'shared.command',
      protocolId: 'command.search',
    })
    if (decision.toolUse.action !== 'render') throw new Error('expected Search operation')

    const rendered = render(decision.toolUse.node)
    expect(rendered.getByText('Search')).toBeInTheDocument()
    expect(rendered.getByText('exit code unavailable')).toBeInTheDocument()
    expect(rendered.container.textContent).toContain('Total output lines: 877')
    expect(rendered.container.textContent).toContain('yield 10000ms · max 50000 tok')
  })

  it('names a projected workflow status call and keeps its paired output visible', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use', id: 'status-1', name: 'exec',
      input: {
        raw: 'const r = await tools.mcp__agent_code__workflow_run_status({runId:"run-1"}); const d=JSON.parse(r.content[0].text); text(JSON.stringify({status:d.run.status,cursor:d.run.cursor,agents:d.health.agents}))',
      },
    }
    const paired = result(toolUse, '{"status":"running","cursor":203,"agents":{"completed":8}}')
    const decision = renderCodexOperation({ toolUse, result: paired, live: false, streaming: false })

    expect(decision.toolUse).toMatchObject({
      action: 'render', receipt: { protocolId: 'agent-code.embedded-operation' },
    })
    expect(decision.toolResult).toMatchObject({
      action: 'render', receipt: { protocolId: 'agent-code.embedded-operation' },
    })
    if (decision.toolUse.action !== 'render' || decision.toolResult?.action !== 'render') {
      throw new Error('expected named operation pair')
    }
    const invocation = render(decision.toolUse.node)
    expect(invocation.getByText('Check workflow status')).toBeInTheDocument()
    expect(invocation.getByText('run-1')).toBeInTheDocument()
    invocation.unmount()
    render(decision.toolResult.node)
    expect(screen.getByText('Check workflow status output')).toBeInTheDocument()
    expect(screen.getByText('status: running · cursor 203')).toBeInTheDocument()
  })

  it('turns projected workflow JSONL into scannable collapsed event rows', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use', id: 'events-1', name: 'exec',
      input: {
        raw: 'const r = await tools.mcp__agent_code__workflow_run_events({runId:"run-1",after:191,limit:20}); text(r)',
      },
    }
    const paired = result(toolUse, [
      '{"cursor":195,"type":"agent.completed","agentId":"agent_6","label":"Renderer audit","message":"Done"}',
      '{"cursor":196,"type":"phase.completed","label":"Independent audits"}',
    ].join('\n'))
    const decision = renderCodexOperation({ toolUse, result: paired, live: false, streaming: false })
    if (decision.toolResult?.action !== 'render') throw new Error('expected named result')
    render(decision.toolResult.node)
    expect(screen.getByText('Renderer audit · agent.completed · cursor 195')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.queryByText('JSON record')).not.toBeInTheDocument()
  })

  it('absorbs an empty embedded-operation acknowledgement instead of painting a detached box', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use', id: 'cancel-1', name: 'exec',
      input: {
        raw: 'const r = await tools.mcp__agent_code__workflow_run_cancel({runId:"run-1"}); text(r.output)',
      },
    }
    const paired = result(toolUse, '')
    const decision = renderCodexOperation({ toolUse, result: paired, live: false, streaming: false })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      protocolId: 'agent-code.embedded-operation',
    })
  })

  it('renders wait as a continuation and removes only its verified transport chrome', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use', id: 'wait-1', name: 'wait',
      input: { cell_id: 'cell-75', yield_time_ms: 30_000, max_tokens: 30_000 },
    }
    const paired = result(toolUse, 'Tests 203 passed')
    const decision = renderCodexOperation({ toolUse, result: paired, live: false, streaming: false })
    if (decision.toolUse.action !== 'render' || decision.toolResult?.action !== 'render') {
      throw new Error('expected wait pair')
    }
    const invocation = render(decision.toolUse.node)
    expect(invocation.getByText('Wait for command')).toBeInTheDocument()
    expect(invocation.getByText('cell-75')).toBeInTheDocument()
    invocation.unmount()
    const output = render(decision.toolResult.node)
    expect(output.container.textContent).toContain('Tests 203 passed')
    expect(output.container.textContent).not.toContain('Script completed')
    expect(output.container.textContent).not.toContain('Wall time')
  })

  it('preserves physical command lines in the specialized headline', () => {
    const { container } = render(<CommandView model={{
      label: 'exec',
      command: 'first command\nsecond command',
      status: 'unknown',
      exitCode: null,
    }} />)
    const headline = container.querySelector('.whitespace-pre-wrap')
    expect(headline).not.toBeNull()
    expect(headline?.textContent).toBe('first command\nsecond command')
    expect(headline).toHaveClass('line-clamp-2')
  })
})
