import { describe, expect, it } from 'vitest'

import {
  classifyUnifiedExecScript,
  parseApplyPatch,
} from '@providers/codex/renderer/extractors'

describe('classifyUnifiedExecScript', () => {
  it('classifies a generated patch declaration before the invocation streams', () => {
    const prefix =
      'const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-old\\n+new\\n'

    expect(classifyUnifiedExecScript(prefix)).toEqual({
      kind: 'apply_patch',
      patchText:
        '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n',
    })
  })

  it('does not mistake a command that mentions the patch header for an edit', () => {
    const script =
      'const result = await tools.exec_command({"cmd":"rg \'*** Begin Patch\' src"});'

    expect(classifyUnifiedExecScript(script)).toMatchObject({
      kind: 'exec_command',
      input: { command: "rg '*** Begin Patch' src" },
    })
  })

  it('does not mistake a declared marker string for a patch before a command', () => {
    const script =
      'const marker = "*** Begin Patch"; const result = await tools.exec_command({"cmd":"rg marker src"});'

    expect(classifyUnifiedExecScript(script)).toMatchObject({
      kind: 'exec_command',
      input: { command: 'rg marker src' },
    })
  })

  it('keeps direct apply_patch calls working', () => {
    const script =
      'const result = await tools.apply_patch("*** Begin Patch\\n*** Add File: a.ts\\n+x\\n*** End Patch");'

    expect(classifyUnifiedExecScript(script)).toMatchObject({
      kind: 'apply_patch',
      patchText: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch',
    })
  })

  it('exposes other nested tool calls and their completed object arguments', () => {
    const script =
      'const result = await tools.update_plan({"explanation":"streaming UI","plan":[]});'

    expect(classifyUnifiedExecScript(script)).toEqual({
      kind: 'tool_call',
      toolName: 'update_plan',
      input: { explanation: 'streaming UI', plan: [] },
    })
  })

  it('classifies a nested tool as soon as its invocation appears', () => {
    expect(
      classifyUnifiedExecScript('const result = await tools.mcp__docs__lookup('),
    ).toEqual({
      kind: 'tool_call',
      toolName: 'mcp__docs__lookup',
      input: null,
    })
  })

  it('waits for write_stdin evidence instead of flashing a wait row', () => {
    expect(classifyUnifiedExecScript('const result = await tools.write_stdin(')).toBeNull()
    expect(
      classifyUnifiedExecScript('const result = await tools.write_stdin({"chars":"'),
    ).toBeNull()
    expect(
      classifyUnifiedExecScript('const result = await tools.write_stdin({"chars":"y'),
    ).toEqual({ kind: 'write_stdin', chars: 'y' })
    expect(
      classifyUnifiedExecScript(
        'const result = await tools.write_stdin({"chars":"\\uD83D',
      ),
    ).toBeNull()
    expect(
      classifyUnifiedExecScript(
        'const result = await tools.write_stdin({"chars":"\\uD83D\\uDE80',
      ),
    ).toEqual({ kind: 'write_stdin', chars: '🚀' })
    expect(
      classifyUnifiedExecScript('const result = await tools.write_stdin({"chars":""});'),
    ).toEqual({ kind: 'wait' })
  })
})

describe('parseApplyPatch', () => {
  it('does not turn the streaming newline cursor into a blank context row', () => {
    expect(
      parseApplyPatch(
        '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+const value = 1\n',
      ),
    ).toEqual([
      {
        action: 'Update',
        path: 'src/a.ts',
        lines: [{ kind: '+', text: 'const value = 1' }],
      },
    ])
  })

  it('keeps a proven blank context line once following grammar arrives', () => {
    expect(
      parseApplyPatch(
        '*** Begin Patch\n*** Update File: src/a.ts\n@@\n+before\n\n+after',
      )[0]?.lines,
    ).toEqual([
      { kind: '+', text: 'before' },
      { kind: 'ctx', text: '' },
      { kind: '+', text: 'after' },
    ])
  })
})
