import { describe, expect, it } from 'vitest'

import { codexExecScriptCalls } from './execScript'

// Which `tools.*` calls a Codex code-mode script makes (#1362, #1368).
// The reader-level behaviour is pinned by recorded rollouts in
// AgentTranscriptReader.system.test.ts. These cases pin the grammar edges a
// lexer gets wrong and a parse gets right, so a later "simplify it back to a
// scan" fails here.
describe('codexExecScriptCalls', () => {
  // #1368 verification b. A regex literal after an `if (...)` condition. A
  // lexer reads the `/` after `)` as division, and then either:
  it('does not read a regex after a control-flow condition as a call', () => {
    // invents the patch that the regex merely mentions,
    expect(codexExecScriptCalls('if (ready) /tools.apply_patch(fake)/.test(s); tools.exec_command({cmd:"ok"})'))
      .toEqual([{ tool: 'exec_command', argument: '{cmd:"ok"}' }])
    // or opens a phantom string at the regex's quote and loses the real call.
    expect(codexExecScriptCalls('if (ready) /tools.fake\\(\'foo/.test(s); tools.exec_command({cmd:"ok"})'))
      .toEqual([{ tool: 'exec_command', argument: '{cmd:"ok"}' }])
  })

  // #1368 verification c: two more places a lexer's regex guess fails in
  // valid code: division after an object literal, and a regex after `await`.
  it('keeps a call between divisions after `}` and after a regex following await', () => {
    expect(codexExecScriptCalls('const n = {} / 2; tools.exec_command({cmd:"echo real"}); const m = 6 / 2;'))
      .toEqual([{ tool: 'exec_command', argument: '{cmd:"echo real"}' }])
    expect(codexExecScriptCalls('await /\'/; tools.exec_command({cmd:"echo real"});'))
      .toEqual([{ tool: 'exec_command', argument: '{cmd:"echo real"}' }])
  })

  // The same characters as real division: the call in the middle runs.
  it('keeps a call written between two divisions', () => {
    expect(codexExecScriptCalls('const n = (x) / tools.apply_patch(foo) / 2'))
      .toEqual([{ tool: 'apply_patch', argument: 'foo' }])
  })

  // Recorded 2026-07-23 (Codex 0.144 rollout 019f8ed7…): the bracket form of
  // a tool call. The lexical scan never saw these five recorded calls.
  it('reads a recorded tools["name"](…) call', () => {
    expect(codexExecScriptCalls('const result = await tools["mcp__workflow_mcp__workflow_run_status"]({ runId: "run_1" });').map(call => call.tool))
      .toEqual(['mcp__workflow_mcp__workflow_run_status'])
  })

  // A script that does not parse never ran as written; it still gets the
  // lexical best effort rather than nothing.
  it('falls back to the lexical scan when the script does not parse', () => {
    expect(codexExecScriptCalls('text(await tools.exec_command({cmd:"ls"})); )').map(call => call.tool))
      .toEqual(['exec_command'])
  })
})
