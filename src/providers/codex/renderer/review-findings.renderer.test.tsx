import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import {
  fromCodexApplyPatch,
  parseApplyPatch,
} from '@providers/codex/renderer/adapters/codeEdit'
import {
  fromCodexCommandOperation,
  fromCodexExecCommand,
  fromCodexExecScript,
} from '@providers/codex/renderer/adapters/command'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { CODEX_RENDER_SHAPES } from '@providers/codex/renderer/shapes'
import {
  buildFingerprintIndex,
  classifySighting,
} from '@renderer/rendering/evidence/catalogCoverage'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'

describe('Codex command review findings', () => {
  it('normalizes a transparent unified exec into the same owned command operation', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'unified-test',
      name: 'exec',
      input: {
        raw: 'const r = await tools.exec_command({cmd:"npm test",workdir:"/repo",yield_time_ms:30000,max_output_tokens:12000}); text(r.output);',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script completed\nWall time 0.2 seconds\nOutput:\n\nTests  12 passed',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }
    const operation = fromCodexCommandOperation({ toolUse, result })

    expect(operation).toMatchObject({
      rawCommand: 'npm test',
      ownsResult: true,
      model: {
        cwd: '/repo',
        status: 'success',
        output: 'Tests  12 passed',
        conclusion: 'Tests: 12 passed',
      },
    })
    const decision = renderCodexOperation({ toolUse, result, live: false, streaming: false })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'codex.rows.dispatch',
    })
  })

  it('extracts the captured serialized ExecCommandResult carrier without showing transport JSON', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'serialized-command',
      name: 'exec',
      input: {
        raw: 'const result = await tools.exec_command({cmd:"printf failed"}); text(JSON.stringify(result));',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: [
        'Script completed',
        'Wall time 0.2 seconds',
        'Output:',
        '',
        '{"exit_code":7,"output":"assertion failed\\nlast line","wall_time_seconds":0.2}',
      ].join('\n'),
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }

    expect(fromCodexCommandOperation({ toolUse, result })).toMatchObject({
      ownsResult: true,
      model: {
        status: 'failure',
        exitCode: 7,
        output: 'assertion failed\nlast line',
        errorSummary: 'assertion failed',
      },
    })
  })

  it('does not absorb a command-looking script with unrelated JavaScript output', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'ambiguous-command',
      name: 'exec',
      input: {
        raw: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output); text("unrelated");',
      },
    }
    expect(fromCodexCommandOperation({ toolUse, result: null })).toBeNull()
  })

  it('routes sentinel-only scripts with real commands and discloses calls beyond the cap', () => {
    const calls = Array.from(
      { length: 8 },
      (_, index) => `tools.exec_command({cmd: "printf ${index}"})`,
    ).join('; ')
    const script = [
      'const example = "*** Begin Patch\\n*** Add File: example.txt\\n+demo\\n*** End Patch";',
      calls,
    ].join('\n')
    const model = fromCodexExecScript({
      type: 'tool_use',
      id: 'exec-sentinel',
      name: 'exec',
      input: { raw: script },
    })

    expect(model?.command).toContain('printf 0')
    expect(model?.command).toContain('printf 5')
    expect(model?.command).not.toContain('printf 6')
    expect(model?.command).toContain('2 additional exec_command calls omitted from preview')
  })

  it('bounds live script admission and reports only a proven omitted-call lower bound', () => {
    const admittedCalls = Array.from(
      { length: 7 },
      (_, index) => `tools.exec_command({cmd: "printf admitted-${index}"})`,
    ).join('; ')
    const hiddenCalls = Array.from(
      { length: 200 },
      (_, index) => `tools.exec_command({cmd: "printf hidden-${index}"})`,
    ).join('; ')
    const script = `${admittedCalls}; ${'x'.repeat(64 * 1024)}; ${hiddenCalls}`

    const model = fromCodexExecScript({
      type: 'tool_use',
      id: 'exec-large-stream',
      name: 'exec',
      input: { raw: script },
    }, { streaming: true, live: true })

    // WHY this is stronger than checking a six-item cap alone: an unbounded
    // scan would discover all 201 omitted calls and print that exact count.
    // The bounded adapter can prove only the seventh call in its admitted page,
    // so the lower-bound wording also proves the large hidden tail was not
    // traversed merely to decorate a compact streaming card.
    expect(model?.command?.split('\n').slice(0, 6)).toEqual(
      Array.from({ length: 6 }, (_, index) => `printf admitted-${index}`),
    )
    expect(model?.command).not.toContain('hidden-0')
    expect(model?.command).toContain(
      'at least 1 additional exec_command call omitted from preview; hidden script tail not inspected',
    )
    expect(model?.command).not.toContain('201 additional')
  })

  it('derives command running/success/failure from correlated lifecycle evidence', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'exec-lifecycle',
      name: 'exec_command',
      input: { cmd: 'npm test' },
    }
    expect(fromCodexExecCommand(toolUse, { live: true })?.status).toBe('running')

    const silentSuccess = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: '',
      is_error: false,
      codex: { kind: 'exec_command_end', exitCode: 0 },
    } as ToolResultBlock & { codex: { kind: string; exitCode: number } }
    expect(fromCodexExecCommand(toolUse, { result: silentSuccess })?.status).toBe('success')

    const failure = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script failed\nWall time: 0.2 seconds\nOutput:\n\ntests failed',
      is_error: true,
      codex: { exitCode: 7 },
    } as ToolResultBlock & { codex: { exitCode: number } }
    expect(fromCodexExecCommand(toolUse, { result: failure })).toMatchObject({
      status: 'failure',
      exitCode: 7,
      errorSummary: 'tests failed',
    })
  })

  it('absorbs empty unified-exec output only behind an admitted command owner', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'exec-empty',
      name: 'exec',
      input: { raw: 'await tools.exec_command({cmd: "printf quiet"});' },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script completed\nWall time: 0.1 seconds\nOutput:\n\n',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }
    const decision = renderCodexOperation({
      toolUse,
      result,
      live: false,
      streaming: false,
    })

    expect(decision.toolUse.action).toBe('render')
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'codex.rows.dispatch',
    })
  })

  it('preserves result evidence when a patch-shaped result has no admitted invocation', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'malformed-patch',
      name: 'apply_patch',
      input: { raw: '*** Begin Patch\nnot a file header\n*** End Patch' },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: '',
      codex: { kind: 'patch_apply_end', success: true, changes: {} },
    } as ToolResultBlock & { codex: Record<string, unknown> }
    const decision = renderCodexOperation({
      toolUse,
      result,
      live: false,
      streaming: false,
    })

    expect(decision.toolUse.action).toBe('fallback')
    expect(decision.toolResult?.action).toBe('fallback')
  })
})

describe('Codex apply_patch review findings', () => {
  it('propagates bounded preview/file/count semantics into CodeEditRenderModel', () => {
    const largeBody = Array.from(
      { length: 500 },
      (_, index) => `+line ${index} ${'x'.repeat(80)}`,
    ).join('\n')
    const raw = [
      '*** Begin Patch',
      '*** Update File: first.ts',
      largeBody,
      '*** Add File: second.ts',
      '+second',
      '*** End Patch',
    ].join('\n')
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'large-patch',
      content: 'Success',
    }
    const model = fromCodexApplyPatch({
      type: 'tool_use',
      id: 'large-patch',
      name: 'apply_patch',
      input: { raw },
    }, { result })

    expect(model).toMatchObject({
      totalFiles: 1,
      fileCountTruncated: true,
      partial: true,
      status: 'success',
    })
    expect(model?.files).toHaveLength(1)
    expect(model?.files[0]).toMatchObject({
      previewTruncated: true,
      countsTruncated: true,
    })
    expect(model?.files[0].additions).toBeLessThan(500)

    render(<CodeEditView model={model!} />)
    expect(screen.getByText('≥1 file')).toBeInTheDocument()
    expect(screen.getByText(/File and change totals are lower bounds/)).toBeInTheDocument()
  })

  it('stops parsing at End Patch and leaves generated script suffixes out of the diff', () => {
    const files = parseApplyPatch({
      raw: [
        '*** Begin Patch',
        '*** Add File: kept.ts',
        '+kept',
        '*** End Patch',
        '+const leaked = true',
        '*** Add File: leaked.ts',
        '+leaked',
      ].join('\n'),
    })

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('kept.ts')
    expect(files[0].lines.map(line => line.text)).toEqual(['kept'])
  })

  it('does not label a committed patch without a result as successful', () => {
    const model = fromCodexApplyPatch({
      type: 'tool_use',
      id: 'interrupted-patch',
      name: 'apply_patch',
      input: {
        raw: '*** Begin Patch\n*** Add File: interrupted.ts\n+partial\n*** End Patch',
      },
    })
    expect(model?.status).toBe('running')
  })
})

describe('Codex catalog receipt alternates', () => {
  const index = buildFingerprintIndex([CODEX_RENDER_SHAPES])

  it('covers Git interception for both exec_command planes and committed empty polls', () => {
    const semanticExec = CODEX_RENDER_SHAPES['codex.semantic.exec-command.v1']
    const committedExec = CODEX_RENDER_SHAPES['codex.tool-use.exec-command.v1']
    const semanticUnifiedExec = CODEX_RENDER_SHAPES['codex.semantic.exec.v1']
    const committedUnifiedExec = CODEX_RENDER_SHAPES['codex.tool-use.exec.v1']
    const committedStdin = CODEX_RENDER_SHAPES['codex.tool-use.write-stdin.v1']

    expect(semanticExec.alternateDispositions).toContainEqual({
      kind: 'specialized',
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    expect(committedExec.alternateDispositions).toContainEqual({
      kind: 'specialized',
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    expect(semanticUnifiedExec.alternateDispositions).toContainEqual({
      kind: 'specialized',
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    expect(committedUnifiedExec.alternateDispositions).toContainEqual({
      kind: 'specialized',
      rendererId: 'shared.command',
      protocolId: 'command.git',
    })
    expect(committedStdin.alternateDispositions).toContainEqual(expect.objectContaining({
      kind: 'absorbed',
      ownerRendererId: 'codex.command-continuation',
      protocolId: 'command.continuation',
    }))
  })

  it.each([
    ['codex.semantic.apply-patch.v1', 'input-complete'],
    ['codex.tool-use.apply-patch.v1', 'durable'],
    ['codex.semantic.exec-command.v1', 'input-complete'],
    ['codex.tool-use.exec-command.v1', 'durable'],
  ] as const)('classifies the actual malformed-input fallback for %s', (shapeId, lifecycle) => {
    const definition = CODEX_RENDER_SHAPES[shapeId]

    // WHY classification is asserted, not merely catalog object shape: the
    // failure this protects against lives at the catalog/classifier seam.
    // Adapter-declined content shares the accepted payload's structural
    // fingerprint, so the declared alternate must turn the resulting generic
    // receipt into known-claimed rather than a false known-misrouted alert.
    expect(classifySighting({
      structuralFingerprint: definition.fingerprints[0],
      lifecycle,
      outcome: {
        kind: 'generic',
        shapeId,
        rendererId: 'shared.generic-tool',
      },
    }, index)).toEqual({ kind: 'known-claimed', shapeId })
  })
})
