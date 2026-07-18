import { describe, expect, it } from 'vitest'

import { collapseCarriageReturns, hasAnsi, parseAnsi, stripAnsi } from '@shared/parsers/ansi'
import { analyzeCommandOutput } from '@providers/shared/renderer/protocols/command/formatters/index'
import { fileMutationFormatter } from '@providers/shared/renderer/protocols/command/formatters/file-mutation'
import {
  fromClaudeBashBlock,
  fromClaudeBashCodeEdit,
  fromClaudePartialBashCodeEdit,
  fromClaudePartialBashJson,
} from '@providers/claude/renderer/adapters/command'
import { extractShellHeredocWrite } from '@providers/shared/renderer/protocols/command/shellFileWrite'
import {
  fromCodexExecScript,
  stripCodexTransportEnvelope,
} from '@providers/codex/renderer/adapters/command'

// Phase 6 executable spec (PR #555). These tests OWN the ported #524 code:
// every behavior asserted here is this branch's contract, independent of
// the draft's history — per product-owner direction, the old PR is
// reference material, never a source of trust.

describe('ansi parser (ported, now ours)', () => {
  it('CRLF is a line terminator, not a progress rewrite — lines survive', () => {
    expect(collapseCarriageReturns('HTTP/2 200\r\ncontent-type: text/html\r\n')).toBe(
      'HTTP/2 200\ncontent-type: text/html\n',
    )
  })

  it('\\r progress rewrites keep only the final segment', () => {
    expect(collapseCarriageReturns('50%\r75%\r100%')).toBe('100%')
  })

  it('preserves terminal control state across a carriage-return rewrite', () => {
    const collapsed = collapseCarriageReturns('\x1b[31mold\rnew\x1b[0m')
    expect(collapsed).toBe('\x1b[31mnew\x1b[0m')
    expect(parseAnsi(collapsed).spans[0]).toMatchObject({ text: 'new', style: { fg: 1 } })
  })

  it('does not treat carriage returns inside OSC controls as display rewrites', () => {
    const source = '\x1b]0;build\rtitle\x07old\rnew'
    expect(collapseCarriageReturns(source)).toBe('\x1b]0;build\rtitle\x07new')
    expect(stripAnsi(collapseCarriageReturns(source))).toBe('new')
  })

  it('SGR reset-then-set in one sequence applies both', () => {
    const { spans } = parseAnsi('\x1b[0;31mred\x1b[0m plain')
    expect(spans[0].text).toBe('red')
    expect(spans[0].style.fg).toBe(1)
    expect(spans[1].style.fg).toBeNull()
  })

  it('256-color and 24-bit extended sequences resolve', () => {
    const { spans } = parseAnsi('\x1b[38;5;196mx\x1b[38;2;0;128;255my')
    expect(spans[0].style.fg).toBe('#ff0000')
    expect(spans[1].style.fg).toBe('#0080ff')
  })

  it('span creation is hard-capped — an escape bomb degrades styling, never content', () => {
    const bomb = 'x\x1b[31m'.repeat(10_000)
    const { spans } = parseAnsi(bomb)
    expect(spans.length).toBeLessThanOrEqual(4001)
    expect(spans.map(s => s.text).join('').replace(/x/g, '').length).toBe(0) // all content survives
  })

  it('non-SGR CSI, OSC, and charset designators strip clean', () => {
    const text = '\x1b[?25lspinner\x1b]0;title\x07\x1b(Bdone'
    expect(stripAnsi(text)).toBe('spinnerdone')
    expect(hasAnsi(text)).toBe(true)
    expect(hasAnsi('\x1b(Bcharset only')).toBe(true)
  })
})

describe('formatter registry — conservative by contract', () => {
  it('vitest totals produce a conclusion; conflicting reruns decline', () => {
    expect(
      analyzeCommandOutput('npx vitest run', 'Test Files  3 passed (3)\nTests  12 passed (12)', 0),
    ).toContain('12 passed')
    expect(
      analyzeCommandOutput(
        'npx vitest watch',
        'Tests  12 passed (12)\n…rerun…\nTests  13 passed (13)',
        0,
      ),
    ).toBeNull()
    expect(
      analyzeCommandOutput('echo docs', 'Tests are part of the release checklist', 0),
    ).toBeNull()
    expect(
      analyzeCommandOutput('echo docs', 'Tests  12 passed according to stale prose', 0),
    ).toBeNull()
    expect(analyzeCommandOutput('echo docs', 'Tests  12 passed', 0)).toBeNull()
    expect(
      analyzeCommandOutput('npx jest', 'Tests:  1 failed, 11 passed, 12 total', 1),
    ).toContain('12 total')
    expect(analyzeCommandOutput('npm test', 'Tests  12 passed', 0)).toBe('Tests: 12 passed')
  })

  it('complete JSON concludes; scalar and capped JSON decline', () => {
    expect(analyzeCommandOutput('curl api', '{"a":1,"b":2}', 0)).toBe('JSON output (2 keys)')
    expect(analyzeCommandOutput('echo', '42', 0)).toBeNull()
  })

  it('file-mutation shapes from our own dev session are named honestly', () => {
    const c = (cmd: string) =>
      fileMutationFormatter.conclude({ command: cmd, plainOutput: '', wasCapped: false, exitCode: 0 })
    expect(c("cat > temp/x.ts <<'EOF'\ncontent > not-a-file\nEOF")).toBe('writes temp/x.ts (heredoc)')
    expect(c("cat >> notes.md <<'EOF'\n…\nEOF")).toBe('appends to notes.md (heredoc)')
    expect(c("python3 - <<'EOF'\nio.open('x','w')\nEOF")).toContain('inline python3 script')
    expect(c("sed -i '' 's/a/b/' src/file.ts")).toBe('edits src/file.ts in place (sed -i)')
    expect(c("sed -i '' 's/a/b/' src/a.ts src/b.ts")).toBeNull()
    expect(c("sed -i '' 's/a/b/' src/file.ts > report.txt")).toBeNull()
    expect(c("sed -i.bak -e 's/a/b/' 'src/file with spaces.ts'")).toBe(
      'edits src/file with spaces.ts in place (sed -i)',
    )
    // Reads and pipes must never claim a mutation.
    expect(c('cat file.ts | grep foo')).toBeNull()
    expect(c("sed 's/a/b/' file.ts")).toBeNull()
    // THE STRONG CONTRACT (parse-fully-or-decline): quoted operators are
    // content; unmodeled shell aborts the whole conclusion; sinks are not
    // mutations. A wrong claim is worse than none.
    expect(c('echo "a > b"')).toBeNull()
    expect(c("printf 'x > y' | wc -l")).toBeNull()
    expect(c('npm test > /dev/null')).toBeNull()
    expect(c('echo $(date) > out.txt')).toBeNull() // substitution → decline
    expect(c('cmd 2>&1')).toBeNull() // fd redirection → decline
    expect(c('echo hi > a.txt > b.txt')).toContain('+1 more')
  })
})

describe('cat-heredoc write → code-edit protocol (not a command headline)', () => {
  const bash = (command: string) =>
    fromClaudeBashCodeEdit({ type: 'tool_use', id: 't', name: 'Bash', input: { command } } as never)

  it('quoted-delimiter cat heredoc becomes a Write card with the exact content', () => {
    const m = bash("cat > temp/x.ts <<'EOF'\nline one\nline two > not-a-redirect\nEOF")!
    expect(m.label).toBe('Bash')
    expect(m.files[0].verb).toBe('Writing')
    expect(m.files[0].path).toBe('temp/x.ts')
    expect(m.files[0].lines.map(l => l.text)).toEqual(['line one', 'line two > not-a-redirect'])
    expect(m.files[0].lines.every(l => l.kind === '+')).toBe(true)
    expect(m.status).toBe('success')
  })

  it('the mkdir -p … && cat > … idiom (our own dev shape) still routes as a write', () => {
    const m = bash("mkdir -p temp/showcase && cat > temp/showcase/a.ts <<'EOF'\nbody\nEOF")!
    expect(m.files[0].path).toBe('temp/showcase/a.ts')
    expect(m.files[0].lines.map(l => l.text)).toEqual(['body'])
  })

  it('>> heredoc is an Appending card', () => {
    const m = bash("cat >> notes.md <<'EOF'\nappended line\nEOF")!
    expect(m.files[0].verb).toBe('Appending')
  })

  it('DECLINES unquoted delimiters — the body would $-expand, bytes differ from text', () => {
    expect(bash('cat > x <<EOF\n$HOME\nEOF')).toBeNull()
  })

  it("DECLINES <<- heredocs because tab stripping makes the visible body inexact", () => {
    expect(bash("cat > x <<-'EOF'\n\tindented\n\tEOF")).toBeNull()
    expect(extractShellHeredocWrite("cat > x <<-'EOF'\nbody")).toBeNull()
  })

  it('DECLINES non-cat writers — grep transforms stdin, body is not the file content', () => {
    expect(bash("grep foo > out.txt <<'EOF'\nfoo\nbar\nEOF")).toBeNull()
  })

  it('DECLINES a cat with a file operand — that concatenates, body ≠ content', () => {
    expect(bash("cat header.txt > out.txt <<'EOF'\nbody\nEOF")).toBeNull()
  })

  it('DECLINES a command trailing the terminator — the write is not the whole story', () => {
    expect(bash("cat > x <<'EOF'\nbody\nEOF\nrm -rf x")).toBeNull()
  })

  it('DECLINES destructive/arbitrary compound prefixes and same-line suffixes', () => {
    expect(bash("rm -rf old && cat > x <<'EOF'\nbody\nEOF")).toBeNull()
    expect(bash("echo preparing && cat > x <<'EOF'\nbody\nEOF")).toBeNull()
    expect(bash("cat > x <<'EOF' ; deploy\nbody\nEOF")).toBeNull()
  })

  it('caps a huge heredoc preview while retaining exact paged content', () => {
    const body = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n')
    const model = bash(`cat > huge.txt <<'EOF'\n${body}\nEOF`)!
    expect(model.files[0].lines.length).toBeLessThanOrEqual(400)
    expect(model.files[0].previewTruncated).toBe(true)
    expect(model.files[0].exactSections?.[0]?.text).toBe(body)
  })

  it('a plain command is not a heredoc write — declines, command card owns it', () => {
    expect(bash('ls -la')).toBeNull()
    expect(bash('echo hi > out.txt')).toBeNull() // > write, but no heredoc body to show
  })

  it('STREAMING: partial JSON paints a growing write once the first line closes', () => {
    // command token still open, body mid-stream — first line HAS closed.
    const partial = '{"command":"cat > temp/s.ts <<\'EOF\'\\nfirst line\\nsecond li'
    const m = fromClaudePartialBashCodeEdit(partial)!
    expect(m.files[0].path).toBe('temp/s.ts')
    expect(m.files[0].streaming).toBe(true)
    expect(m.status).toBe('streaming')
    expect(m.files[0].lines.map(l => l.text)).toContain('first line')
  })

  it('extractor reports completeness honestly for the streaming boundary', () => {
    expect(extractShellHeredocWrite("cat > x <<'EOF'\na")!.complete).toBe(false)
    expect(extractShellHeredocWrite("cat > x <<'EOF'\na\nEOF")!.complete).toBe(true)
    // First line not closed yet → nothing trustworthy.
    expect(extractShellHeredocWrite("cat > x <<'EOF")).toBeNull()
  })
})

describe('claude bash adapter — streaming first', () => {
  it('no model before `command` closes; model the moment it does', () => {
    expect(fromClaudePartialBashJson('{"command":"git sta')).toBeNull()
    const m = fromClaudePartialBashJson('{"command":"git status","descri')
    expect(m).not.toBeNull()
    expect(m!.command).toBe('git status')
    expect(m!.status).toBe('streaming')
  })

  it('committed block maps; long commands bound to the display cap', () => {
    const m = fromClaudeBashBlock({
      type: 'tool_use', id: 't', name: 'Bash',
      input: { command: 'x'.repeat(500) },
    } as never)!
    expect(m.command.length).toBeLessThanOrEqual(161)
    expect(m.command.endsWith('…')).toBe(true)
  })
})

describe('codex exec wrapper — plain-command case', () => {
  it('extracts EVERY embedded exec_command (Promise.all fan-outs stay visible)', () => {
    const script =
      'await Promise.all([tools.exec_command({ cmd: "ls -la" }), tools.exec_command({ cmd: "git log" })]);'
    const m = fromCodexExecScript({ type: 'tool_use', id: '', name: 'exec', input: { cmd: script } } as never)!
    expect(m.command).toContain('ls -la')
    expect(m.command).toContain('git log')
  })

  it('declines patch scripts (codeEdit owns them) and commandless scripts', () => {
    expect(
      fromCodexExecScript({ type: 'tool_use', id: '', name: 'exec', input: { cmd: 'const p = "*** Begin Patch\\n";' } } as never),
    ).toBeNull()
    expect(
      fromCodexExecScript({ type: 'tool_use', id: '', name: 'exec', input: { cmd: 'console.log(1)' } } as never),
    ).toBeNull()
  })

  it('transport envelope strips; bare output passes through', () => {
    expect(
      stripCodexTransportEnvelope('Script completed\nWall time 0.1 seconds\nOutput:\n\nreal output'),
    ).toBe('real output')
    expect(stripCodexTransportEnvelope('just output')).toBe('just output')
    expect(stripCodexTransportEnvelope('Wall time 9 seconds\nOutput:\nlegitimate program output')).toBe(
      'Wall time 9 seconds\nOutput:\nlegitimate program output',
    )
    expect(stripCodexTransportEnvelope('Output:\nlegitimate header')).toBe('Output:\nlegitimate header')
    expect(stripCodexTransportEnvelope('Script completed\nnot an envelope')).toBe(
      'Script completed\nnot an envelope',
    )
  })
})
