import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { fromCodexScriptSteps, type ScriptStepsModel } from '@providers/codex/renderer/adapters/scriptSteps'
import { CodexScriptStepsRow } from '@providers/codex/renderer/components/script-steps'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

// Readable Codex exec scripts (#1510) on RECORDED scripts: the owner's own
// rollouts, one per script-shape × output-shape class
// (testing/fixtures/codex-exec-scripts/samples.json, provenance inside),
// driven through the REAL rollout mapper exactly as a reloaded conversation
// is, so the adapter sees the `{raw}` input and the '\n'-joined output the
// app actually has.

type Sample = { shape: string; output_shape: string; call: Record<string, unknown>; output: Record<string, unknown> }
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../testing/fixtures/codex-exec-scripts/samples.json'), 'utf8')) as { samples: Sample[] }

function mapped(sample: Sample): { toolUse: ToolUseBlock; result: ToolResultBlock } {
  const mapper = getRendererProviderCapabilities('codex').createTranscriptEntryMapper()
  const entries = [sample.call, sample.output].flatMap((payload, index) =>
    mapper.map({ timestamp: `2026-10-14T10:00:0${index}.000Z`, type: 'response_item', payload }).entries)
  const blocks = entries.flatMap((entry) => ((entry as { message?: { content?: unknown } }).message?.content as Array<Record<string, unknown>>) ?? [])
  const toolUse = blocks.find((block) => block.type === 'tool_use') as unknown as ToolUseBlock
  const result = blocks.find((block) => block.type === 'tool_result') as unknown as ToolResultBlock
  if (!toolUse || !result) throw new Error(`mapper produced no call/result for ${sample.shape}`)
  return { toolUse, result }
}

const sample = (shape: string, output: string) => {
  const found = fixture.samples.find((entry) => entry.shape === shape && entry.output_shape === output)
  if (!found) throw new Error(`no recorded sample ${shape} / ${output}`)
  return found
}
const model = (shape: string, output: string): ScriptStepsModel => {
  const { toolUse, result } = mapped(sample(shape, output))
  const built = fromCodexScriptSteps(toolUse, result)
  if (!built) throw new Error(`declined ${shape} / ${output}`)
  return built
}

describe('every recorded shape becomes steps a person can read', () => {
  it('admits all 12 recorded shapes and never shows JSON as open text', () => {
    for (const entry of fixture.samples) {
      const { toolUse, result } = mapped(entry)
      const built = fromCodexScriptSteps(toolUse, result)
      expect(built, `${entry.shape} / ${entry.output_shape}`).not.toBeNull()
      for (const item of built!.results) {
        if (item.kind !== 'text') continue
        const trimmed = item.text.trim()
        let parsed: unknown = null
        try { parsed = JSON.parse(trimmed) } catch { /* not JSON: fine */ }
        expect(parsed && typeof parsed === 'object', `${entry.shape}: open JSON "${trimmed.slice(0, 60)}"`).toBeFalsy()
      }
      // Every recorded byte stays reachable.
      expect(built!.exactOutput.length).toBeGreaterThan(0)
    }
  })

  it('the common single command: its output and exit code, not RUNNING and a JSON record', () => {
    const plain = model('inline-1', 'plain')
    expect(plain.steps).toEqual([expect.objectContaining({ kind: 'command' })])
    expect(plain.paired).toBe(true)
    expect(plain.results[0]).toMatchObject({ kind: 'command', exitCode: 0 })
    expect((plain.results[0] as { output: string }).output).toContain('GitBarSurface: Rendered more hooks')
    expect(model('inline-1', 'EXIT').results[0]).toMatchObject({ kind: 'command', exitCode: 2 })
    // Still running in a background session: no exit code is invented.
    expect(model('inline-1', 'BG').results[0]).toMatchObject({ kind: 'command', exitCode: null, sessionId: 53841 })
  })

  it('a fan-out pairs each command with its own labelled result', () => {
    const fanout = model('fanout:exec_command', 'plain')
    expect(fanout.steps.map((step) => step.kind)).toEqual(['command', 'command'])
    expect(fanout.paired).toBe(true)
    expect(fanout.results.map((item) => item.kind)).toEqual(['command', 'command'])
  })

  it('an MCP refusal is an error with its sentence; an ok acknowledgement is just ok', () => {
    const mixed = model('seq:exec_command+mcp', 'BG,MCPERR')
    expect(mixed.results[1]).toMatchObject({ kind: 'mcp', isError: true })
    expect(model('seq:mcp', 'plain').results[0]).toMatchObject({ kind: 'mcp', isError: false })
  })

  it('a tool-catalogue read is the names it looked up', () => {
    const catalogue = model('seq:exec_command+mcp', 'CATALOG')
    expect(catalogue.results.find((item) => item.kind === 'tools')).toEqual({ kind: 'tools', names: ['browser_console', 'browser_snapshot'] })
  })

  it('a failed script keeps its error apart from the steps', () => {
    const failed = model('seq:exec_command+mcp', 'FAILED')
    expect(failed.status).toBe('failed')
    expect(failed.paired).toBe(false)
    expect(failed.results.at(-1)).toMatchObject({ kind: 'script-error' })
  })

  it('a command\'s own truncation becomes a note, not output', () => {
    const cut = model('seq:write_stdin', 'TRUNC,EXIT').results[0]
    expect(cut).toMatchObject({ kind: 'command', exitCode: 130, truncatedTokens: 3136 })
    expect((cut as { output: string }).output.startsWith('Warning: truncated')).toBe(false)
  })
})

describe('dispatch', () => {
  it('admits the common single-command shape that used to fall to the generic rows', () => {
    const { toolUse, result } = mapped(sample('inline-1', 'plain'))
    const decision = renderCodexOperation({ toolUse, result, live: false, streaming: false })
    expect(decision.toolUse).toMatchObject({ action: 'render', receipt: { protocolId: 'codex.script-steps' } })
    expect(decision.toolResult).toMatchObject({ action: 'absorb', protocolId: 'codex.script-steps' })
  })

  it('leaves a script that has no result yet to the live command headline', () => {
    const { toolUse } = mapped(sample('inline-1', 'plain'))
    const decision = renderCodexOperation({ toolUse, result: null, live: true, streaming: true })
    expect(decision.toolUse).not.toMatchObject({ receipt: { protocolId: 'codex.script-steps' } })
  })
})

describe('the card', () => {
  it('shows the verdict a result carries, and keeps the exact output one click away', () => {
    render(<CodexScriptStepsRow model={model('inline-1', 'EXIT')} />)
    expect(screen.getByText('✕ exit 2')).toBeTruthy()
    expect(screen.getByText(/view exact output/)).toBeTruthy()
    expect(screen.queryByText(/RUNNING/i)).toBeNull()
    expect(screen.queryByText(/JSON record/)).toBeNull()
  })

  it('names the tools a catalogue read looked up', () => {
    render(<CodexScriptStepsRow model={model('seq:exec_command+mcp', 'CATALOG')} />)
    expect(screen.getByText('looked up 2 tools: browser_console, browser_snapshot')).toBeTruthy()
  })

  it('says a script failed', () => {
    render(<CodexScriptStepsRow model={model('seq:exec_command+mcp', 'FAILED')} />)
    expect(screen.getByText('script failed')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Review round on #1518. Each test names the finding it pins.
// ---------------------------------------------------------------------------

describe('evidence and honesty (review round)', () => {
  it('exact output is the whole result text every other consumer reads (A3)', () => {
    for (const entry of fixture.samples) {
      const { toolUse, result } = mapped(entry)
      const built = fromCodexScriptSteps(toolUse, result)
      if (built) expect(built.exactOutput, entry.shape).toBe(toolResultContentText(result.content))
    }
  })

  it('a script Codex truncated keeps its note, and the text it printed stays one block (A5, B3; recorded)', () => {
    const cut = model('inline-output-1', 'SCRIPT-TRUNC')
    expect(cut.truncatedTokens).toBe(1570)
    expect(cut.results).toHaveLength(1)
    expect(cut.results[0]!.kind).toBe('text')
    expect((cut.results[0] as { text: string }).text).toContain('scrollToLatestRequest: number')
  })

  it('a JSONL dump printed as one text() stays one block, not a row per line (B3)', () => {
    // Mechanical mutation of the recorded inline sample: its output part
    // replaced by 300 JSON lines, as `text(r.output)` of a .jsonl file.
    const base = sample('inline-1', 'plain')
    const jsonl = Array.from({ length: 300 }, (_, i) => JSON.stringify({ ts: i, type: 'event', payload: { n: i } })).join('\n')
    const header = (base.output.output as Array<{ text: string }>)[0]!
    const mutated = { ...base, output: { ...base.output, output: [header, { type: 'input_text', text: jsonl }] } }
    const { toolUse, result } = mapped(mutated)
    const built = fromCodexScriptSteps(toolUse, result)!
    // One readable text block (the lines are a log, not one JSON value).
    expect(built.results).toHaveLength(1)
    expect(built.results[0]!.kind).toBe('text')
  })

  it('an image result is left to the row that paints images (A2; recorded)', () => {
    const recorded = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../testing/fixtures/image-reads/codex-exec-single-image.json'), 'utf8')) as { entry: Record<string, unknown> }
    const mapper = getRendererProviderCapabilities('codex').createTranscriptEntryMapper()
    const payload = recorded.entry.payload as { call_id: string }
    const call = { type: 'custom_tool_call', call_id: payload.call_id, name: 'exec', input: 'const r = await tools.view_image({path:"/tmp/a.png"}); image(r.image_url);' }
    const blocks = [{ timestamp: '2026-07-23T17:50:47.000Z', type: 'response_item', payload: call }, recorded.entry]
      .flatMap((line) => mapper.map(line).entries)
      .flatMap((entry) => ((entry as { message?: { content?: unknown } }).message?.content as Array<Record<string, unknown>>) ?? [])
    const toolUse = blocks.find((block) => block.type === 'tool_use') as unknown as ToolUseBlock
    const result = blocks.find((block) => block.type === 'tool_result') as unknown as ToolResultBlock
    expect(fromCodexScriptSteps(toolUse, result)).toBeNull()
    expect(renderCodexOperation({ toolUse, result, live: false, streaming: false }).toolUse).not.toMatchObject({ receipt: { protocolId: 'codex.script-steps' } })
  })

  it('a live row is left to the live headline (B6)', () => {
    const { toolUse, result } = mapped(sample('inline-1', 'plain'))
    expect(fromCodexScriptSteps(toolUse, result, { live: true })).toBeNull()
  })
})

describe('a result is shown under a step only when it is that step\'s (review A1, A4)', () => {
  it('a fan-out printed in a different order is placed by its own index labels', () => {
    // Mechanical mutation of the recorded fan-out: its two `{i, result}` parts swapped.
    const base = sample('fanout:exec_command', 'plain')
    const parts = base.output.output as Array<{ text: string }>
    const mutated = { ...base, output: { ...base.output, output: [parts[0], parts[2], parts[1]] } }
    const { toolUse, result } = mapped(mutated)
    const built = fromCodexScriptSteps(toolUse, result)!
    expect(built.paired).toBe(true)
    expect((built.results[0] as { output: string }).output).toContain('startVitest')
  })

  it('a count coincidence does not pair an unprinted step with a trailing text("done")', () => {
    // Mechanical mutation: the recorded fan-out's script, with its results
    // replaced by one command record and a plain "done".
    const base = sample('fanout:exec_command', 'plain')
    const parts = base.output.output as Array<{ text: string }>
    const record = JSON.parse(parts[1]!.text) as { result: { value: unknown } }
    const mutated = { ...base, output: { ...base.output, output: [parts[0], { type: 'input_text', text: JSON.stringify(record.result.value) }, { type: 'input_text', text: 'done' }] } }
    const { toolUse, result } = mapped(mutated)
    expect(fromCodexScriptSteps(toolUse, result)!.paired).toBe(false)
  })

  it('results that cannot be attributed still show their own verdict (B4; recorded)', () => {
    const unpaired = model('fanout:exec_command+mcp', 'BG')
    expect(unpaired.paired).toBe(false)
    render(<CodexScriptStepsRow model={unpaired} />)
    expect(screen.getAllByText(/left running · session/)).toHaveLength(2)
  })
})
