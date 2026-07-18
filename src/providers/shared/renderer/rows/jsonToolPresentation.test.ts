import { describe, expect, it } from 'vitest'

import {
  jsonResultSummary,
  prettifyToolName,
  smartHeadline,
  tryExtractJson,
} from '@providers/shared/renderer/rows/jsonToolPresentation'
import { stripCodexTransportEnvelope } from '@providers/codex/renderer/adapters/command'

// Payload shapes below are lifted from the debug-bundle corpus
// (docs/rendering/research-2026-07/plan-json-tool-rows.md §1) — the exact
// tools users filed bundles about.

describe('prettifyToolName', () => {
  it('splits the claude MCP naming convention', () => {
    expect(prettifyToolName('mcp__agent_code__orchestration_create_agent')).toEqual({
      display: 'orchestration_create_agent',
      mcpServer: 'agent_code',
    })
  })
  it('passes bare codex names through', () => {
    expect(prettifyToolName('orchestration_read_agent')).toEqual({
      display: 'orchestration_read_agent',
      mcpServer: null,
    })
  })
})

describe('smartHeadline', () => {
  it('prefers path over description (the ai_workspace_attach_file bug)', () => {
    const h = smartHeadline({
      description: 'Implementation plan from the fold reviewer',
      path: '/Users/x/plans/fold.md',
    })
    expect(h).toEqual({ key: 'path', value: '/Users/x/plans/fold.md' })
  })
  it('surfaces MCP payload keys the legacy chain missed (title)', () => {
    const h = smartHeadline({ kind: 'claude', title: 'Consult: AUQ keystroke driver' })
    expect(h?.value).toBe('Consult: AUQ keystroke driver')
  })
  it('keeps command first for Bash-shaped inputs', () => {
    expect(smartHeadline({ command: 'ls -la', description: 'list' })?.key).toBe('command')
  })
  it('null on empty input', () => {
    expect(smartHeadline(null)).toBeNull()
    expect(smartHeadline({})).toBeNull()
  })
})

describe('tryExtractJson', () => {
  it('unwraps the MCP text envelope one level', () => {
    const wire = JSON.stringify([{ type: 'text', text: '{"ok":true,"agent_id":"a1"}' }])
    expect(tryExtractJson(wire)).toEqual({ ok: true, agent_id: 'a1' })
  })
  it('unwraps the codex wall-time wrapper', () => {
    const wire = 'Wall time: 2.1 s\nOutput:\n[{"type":"text","text":"{\\"ok\\":false}"}]'
    expect(tryExtractJson(wire)).toEqual({ ok: false })
  })
  it('unwraps a full MCP CallToolResult carrying nested JSON', () => {
    // This is the current Codex orchestration return shape: the function-call
    // output serializes the SDK result object, whose text block serializes the
    // actual tool protocol response. The renderer should show the agents, not
    // force users to mentally decode two escaped JSON layers.
    const wire = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            agents: [{ sessionId: 'agent-1', lifecycleState: 'running' }],
          }),
        },
      ],
    })
    expect(tryExtractJson(wire)).toEqual({
      ok: true,
      agents: [{ sessionId: 'agent-1', lifecycleState: 'running' }],
    })
  })
  it('formats nested JSON after the current unified-exec transport is removed', () => {
    const payload = JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true,"agents":[]}' }],
    })
    const wire = `Script completed\nWall time 16.9 seconds\nOutput:\n\n${payload}`
    expect(tryExtractJson(stripCodexTransportEnvelope(wire))).toEqual({
      ok: true,
      agents: [],
    })
  })
  it('retains unfamiliar CallToolResult siblings instead of discarding semantics', () => {
    const wire = JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { authoritative: true },
    })
    expect(tryExtractJson(wire)).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
      structuredContent: { authoritative: true },
    })
  })
  it('retains a CallToolResult transport error instead of hiding it inside the exact source', () => {
    const wire = JSON.stringify({
      content: [{ type: 'text', text: '{"message":"provider failed"}' }],
      isError: true,
    })
    expect(tryExtractJson(wire)).toEqual({
      content: [{ type: 'text', text: '{"message":"provider failed"}' }],
      isError: true,
    })
  })
  it('keeps the envelope when the inner text is not JSON', () => {
    const wire = JSON.stringify([{ type: 'text', text: 'plain prose result' }])
    expect(tryExtractJson(wire)).toEqual([{ type: 'text', text: 'plain prose result' }])
  })
  it('returns null for non-JSON text (falls through to truncated rendering)', () => {
    expect(tryExtractJson('total 48\ndrwxr-xr-x 12 …')).toBeNull()
    expect(tryExtractJson('')).toBeNull()
  })
})

describe('jsonResultSummary', () => {
  it('keys off ok and styles danger on ok:false', () => {
    expect(jsonResultSummary({ ok: false, error: 'no such agent' })).toEqual({
      label: 'ok: false',
      isError: true,
    })
    expect(jsonResultSummary({ ok: true })).toEqual({ label: 'ok: true', isError: false })
    expect(jsonResultSummary({ isError: true, content: [] })).toEqual({
      label: 'isError: true',
      isError: true,
    })
  })
  it('counts keys and items otherwise', () => {
    expect(jsonResultSummary({ a: 1 }).label).toBe('1 key')
    expect(jsonResultSummary({ a: 1, b: 2 }).label).toBe('2 keys')
    expect(jsonResultSummary([1, 2, 3]).label).toBe('3 items')
  })
})
