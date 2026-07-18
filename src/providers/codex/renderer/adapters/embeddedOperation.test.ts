import { describe, expect, it } from 'vitest'

import {
  fromCodexEmbeddedOperation,
  fromCodexWaitOperation,
} from './embeddedOperation'
import type { ToolUseBlock } from '@shared/types/transcript'

function exec(raw: string): ToolUseBlock {
  return { type: 'tool_use', id: 'call-1', name: 'exec', input: { raw } }
}

describe('fromCodexEmbeddedOperation', () => {
  it('recovers the captured workflow status identity while leaving projection open', () => {
    const toolUse = exec(`const r = await tools.mcp__agent_code__workflow_run_status({
      runId: "run-123"
    });
    const payload = r.content.find(c => c.type === "text")?.text ?? "";
    try { const d = JSON.parse(payload); text(JSON.stringify({status:d.run.status,cursor:d.run.cursor})) }
    catch { text(payload) }`)

    expect(fromCodexEmbeddedOperation({ toolUse, result: null })).toMatchObject({
      operationId: 'call-1',
      toolName: 'mcp__agent_code__workflow_run_status',
      action: 'Check workflow status',
      subject: 'run-123',
      input: { runId: 'run-123' },
    })
  })

  it('parses bounded JSON-compatible literals used by events and orchestration', () => {
    const toolUse = exec('const r = await tools.mcp__agent_code__workflow_run_events({runId:"run-1",after:191,limit:20,filters:["warning",null],includeHealth:true}); text(r)')
    expect(fromCodexEmbeddedOperation({ toolUse, result: null })?.input).toEqual({
      runId: 'run-1',
      after: 191,
      limit: 20,
      filters: ['warning', null],
      includeHealth: true,
    })
  })

  it('declines examples, ambiguous calls, dynamic arguments, and executable templates', () => {
    const scripts = [
      'text("tools.mcp__agent_code__workflow_run_status({})")',
      '// tools.mcp__agent_code__workflow_run_status({})\ntext("example")',
      'const a = await tools.mcp__agent_code__workflow_run_status({runId:"a"}); const b = await tools.mcp__agent_code__workflow_run_events({runId:"a"})',
      'const r = await tools.mcp__agent_code__workflow_run_status(args); text(r)',
      'if (ready) await tools.mcp__agent_code__workflow_run_status({runId:"a"})',
      'const r = await tools.mcp__agent_code__workflow_run_status({runId:`run-${id}`})',
      'const r = await tools.mcp__agent_code__workflow_run_status({__proto__:{runId:"spoof"}})',
      `const r = await tools.mcp__agent_code__workflow_run_status({values:[${Array.from({ length: 65 }, (_, index) => index).join(',')}]})`,
      `const r = await tools.mcp__agent_code__workflow_run_status({runId:"${'x'.repeat(256 * 1024)}"})`,
    ]
    for (const raw of scripts) {
      expect(fromCodexEmbeddedOperation({ toolUse: exec(raw), result: null })).toBeNull()
    }
  })
})

describe('fromCodexWaitOperation', () => {
  it('admits only the captured continuation grammar', () => {
    expect(fromCodexWaitOperation({
      toolUse: {
        type: 'tool_use', id: 'wait-1', name: 'wait',
        input: { cell_id: 'cell-9', yield_time_ms: 30_000, max_tokens: 10_000 },
      },
      result: null,
    })).toMatchObject({ cellId: 'cell-9', yieldTimeMs: 30_000, maxTokens: 10_000 })
    expect(fromCodexWaitOperation({
      toolUse: { type: 'tool_use', id: 'wait-2', name: 'wait', input: { cell_id: 'x', extra: true } },
      result: null,
    })).toBeNull()
  })
})
