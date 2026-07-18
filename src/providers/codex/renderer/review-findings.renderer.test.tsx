import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  fromCodexApplyPatch,
  parseApplyPatch,
} from '@providers/codex/renderer/adapters/codeEdit'
import {
  fromCodexCommandGroupOperation,
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
  it('correlates the captured numbered Promise.all fan-out without detaching its result', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'captured-numbered-fanout',
      name: 'exec',
      input: {
        raw: `const results = await Promise.all([
  tools.exec_command({
    cmd: "git status --short --branch && git rev-parse HEAD && git rev-parse origin/main",
    workdir: "/repo",
    yield_time_ms: 10000,
    max_output_tokens: 10000
  }),
  tools.exec_command({
    cmd: "gh pr view 560 --json state,mergedAt,mergeCommit,url",
    workdir: "/repo",
    yield_time_ms: 10000,
    max_output_tokens: 10000
  })
]);
results.forEach((r,i)=>{text(\`--- \${i+1} ---\`);text(r.output)});`,
      },
    }
    const sha = 'ad6043439dc794efe6da0928300ab98d2a0f5609'
    const framedOutput = [
      '--- 1 ---',
      '## main...origin/main',
      sha,
      sha,
      '',
      '--- 2 ---',
      '{"state":"MERGED","url":"https://github.com/example/repo/pull/560"}',
      '',
    ].join('\n')
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Script completed\nWall time 0.7 seconds\nOutput:\n\n${framedOutput}`,
      is_error: false,
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }

    const group = fromCodexCommandGroupOperation({ toolUse, result })
    expect(group).toMatchObject({
      ownsResult: true,
      exactOutput: framedOutput,
      commands: [
        {
          rawCommand: 'git status --short --branch && git rev-parse HEAD && git rev-parse origin/main',
          model: { status: 'unknown', output: expect.stringContaining('## main...origin/main') },
        },
        {
          rawCommand: 'gh pr view 560 --json state,mergedAt,mergeCommit,url',
          model: { status: 'unknown', output: expect.stringContaining('"state":"MERGED"') },
        },
      ],
    })

    const decision = renderCodexOperation({ toolUse, result, live: false, streaming: false })
    expect(decision.toolResult).toMatchObject({
      action: 'absorb',
      ownerRenderId: 'codex.rows.dispatch',
    })
    if (decision.toolUse.action !== 'render') throw new Error('expected grouped command owner')
    const { container } = render(decision.toolUse.node)
    expect(screen.getByText('git status workflow')).toBeInTheDocument()
    expect(container.textContent).toContain('gh pr view 560')
    expect(screen.getAllByText('exit unknown')).toHaveLength(2)
    expect(container.textContent).toContain('"state":"MERGED"')

    const exact = screen.getByText(/view exact grouped output/).closest('details')!
    fireEvent.click(exact.querySelector('summary')!)
    expect(exact.textContent).toContain('--- 1 ---')
    expect(exact.textContent).toContain('--- 2 ---')
  })

  it('leaves noncanonical fan-out output separately visible', () => {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'ambiguous-numbered-fanout',
      name: 'exec',
      input: {
        raw: 'const results = await Promise.all([tools.exec_command({cmd:"git status"}),tools.exec_command({cmd:"npm test"})]); text(JSON.stringify(results));',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script completed\nOutput:\n\n[{"output":"clean"},{"output":"passed"}]',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }

    expect(fromCodexCommandGroupOperation({ toolUse, result })).toBeNull()
    expect(renderCodexOperation({ toolUse, result, live: false, streaming: false }).toolResult)
      .not.toMatchObject({ action: 'absorb' })
  })

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

    // WHY status is "unknown" and not "success": "Script completed" proves
    // only that the wrapper JavaScript ran. The text(r.output) carrier drops
    // the inner exit code, so success is unprovable on this transport even
    // though the output bytes are fully owned and absorbable.
    expect(operation).toMatchObject({
      rawCommand: 'npm test',
      ownsResult: true,
      model: {
        cwd: '/repo',
        status: 'unknown',
        exitCode: null,
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

  it('never reports success for a failed inner command on the direct-output carrier', () => {
    // The inner command exits 1, but code mode still says "Script completed"
    // because the JavaScript itself did not throw, and no exit code survives
    // the text(r.output) carrier. The old mapping rendered this green.
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'unified-hidden-failure',
      name: 'exec',
      input: {
        raw: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script completed\nWall time 1.2 seconds\nOutput:\n\nFAIL src/a.test.ts\nTests  1 failed',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }
    const operation = fromCodexCommandOperation({ toolUse, result })

    expect(operation?.model.status).toBe('unknown')
    expect(operation?.model.status).not.toBe('success')
    expect(operation?.model.output).toBe('FAIL src/a.test.ts\nTests  1 failed')
    expect(operation?.ownsResult).toBe(true)
  })

  it('treats a yielded "Script running" envelope as partial, never as an owned terminal result', () => {
    // Codex's notify() can inject MORE custom_tool_call_output items for this
    // call_id after a yield. Absorbing the partial flush would both claim a
    // terminal outcome and orphan the continuation output.
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'unified-yielded',
      name: 'exec',
      input: {
        raw: 'const r = await tools.exec_command({cmd:"npm run dev",yield_time_ms:5000}); text(r.output);',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script running with cell ID cell-3\nWall time 5.0 seconds\nOutput:\n\nserver starting…',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }
    const operation = fromCodexCommandOperation({ toolUse, result })

    expect(operation?.ownsResult).toBe(false)
    expect(operation?.model.status).toBe('running')

    const decision = renderCodexOperation({ toolUse, result, live: false, streaming: false })
    expect(decision.toolResult?.action).not.toBe('absorb')
  })

  it('keeps native exec_command output verbatim even when it begins with transport text', () => {
    // `cat` of a captured unified-exec transcript legitimately starts with
    // "Script completed…Output:". Native results are the command's own bytes;
    // stripping them here would destroy the only copy once the result row is
    // absorbed.
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'native-envelope-lookalike',
      name: 'exec_command',
      input: { cmd: 'cat exec-transcript.log' },
    }
    const content = 'Script completed\nWall time 0.2 seconds\nOutput:\n\nreal payload line'
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content,
      is_error: false,
      codex: { kind: 'exec_command_end', exitCode: 0 },
    } as ToolResultBlock & { codex: { kind: string; exitCode: number } }

    expect(fromCodexCommandOperation({ toolUse, result })?.model).toMatchObject({
      status: 'success',
      output: content,
    })
  })

  it('summarizes an unowned failed script from its visible result text', () => {
    // Fan-out scripts never own their result, but the failure headline should
    // still quote the real first error line instead of a generic "command
    // failed" — the separate result row keeps every byte either way.
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'fanout-failure',
      name: 'exec',
      input: {
        raw: 'await Promise.all([tools.exec_command({cmd:"npm run lint"}), tools.exec_command({cmd:"npm test"})]);',
      },
    }
    const result = {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: 'Script failed\nWall time 0.4 seconds\nOutput:\n\nlint: 3 errors found\nScript error:\nExecution failed',
      codex: { kind: 'custom_tool_call_output' },
    } as ToolResultBlock & { codex: { kind: string } }
    const model = fromCodexExecScript(toolUse, { result })

    expect(model).toMatchObject({
      status: 'failure',
      errorSummary: 'lint: 3 errors found',
    })

    const decision = renderCodexOperation({ toolUse, result, live: false, streaming: false })
    expect(decision.toolResult?.action).not.toBe('absorb')
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
      content: 'tests failed\n42 assertions did not hold',
      is_error: true,
      codex: { exitCode: 7 },
    } as ToolResultBlock & { codex: { exitCode: number } }
    // Native exec_command results are the command's own bytes — no code-mode
    // envelope exists on this transport, so nothing is stripped and the first
    // line of the real output becomes the failure headline.
    expect(fromCodexExecCommand(toolUse, { result: failure })).toMatchObject({
      status: 'failure',
      exitCode: 7,
      output: 'tests failed\n42 assertions did not hold',
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
