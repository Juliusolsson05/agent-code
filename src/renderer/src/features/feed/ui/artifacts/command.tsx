import { memo, useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { useContext } from 'react'
import { formatToolFilePath } from '@shared/paths/displayPath'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { truncateBashCommand } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'

import type { CommandArtifact } from './types'

// CommandCard — the ONE command surface (spec §6). Claude Bash, Codex
// exec_command, Codex local_shell_call, and write_stdin all render
// here, live and committed, from the same CommandArtifact VM:
//
//   $ npm test                                   ✓ 1.2s
//     cwd: agent-code   run the unit tests
//   ⎿ <ANSI-colored output, 3 lines, expandable>
//
// Replaces: the JsonToolRow fallback Claude Bash fell into (2-line
// headline, params-in-details, output rendered separately by
// ToolResultRow), CodexExecCommandRow + CodexWriteStdinRow, and the
// bespoke live local_shell_call chip in BlockRow. What those never
// showed and this does: exit codes (parsed since forever, displayed
// never), ANSI colors, and live output streaming into the card as
// tool_output_delta arrives.
//
// Silent successes (exit 0, no output) render as the header-only row —
// command + ✓ — instead of being invisible. The header IS the record
// that the command ran.

export const CommandCard = memo(function CommandCard({ vm }: { vm: CommandArtifact }) {
  const [showFull, setShowFull] = useState(false)
  const { workspaceRoot } = useContext(CodeRenderContext)

  // Empty write_stdin renders NOTHING — preserved verbatim from the
  // CodexWriteStdinRow this card replaced. Codex emits empty stdin
  // writes as poll/continuation calls while a long PTY command drains;
  // they carry no user-visible content. renderUnits.ts's
  // isInvisibleWriteStdinBlock mirrors this so the render model and
  // the DOM agree the block owns no screen real estate — if you change
  // this, change that selector in the same commit. (Unified-exec
  // scripts polling with chars:"" classify as 'wait' instead and DO
  // render — see below — matching the native "Waited for background
  // terminal" rows; that path never enters this selector.)
  if (vm.sourceTool === 'write_stdin' && vm.stdinWrites.every(s => s.length === 0)) {
    return null
  }

  const truncated = truncateBashCommand(vm.command)
  const isTruncated = truncated !== vm.command
  const cwdBase = vm.cwd ? vm.cwd.split('/').filter(Boolean).pop() ?? vm.cwd : null
  const shown = showFull ? vm.command : truncated

  // Bash-highlight the command line, like the native TUI's
  // highlight_bash_to_lines — a shell pipeline reads far better with
  // its strings/flags tinted. Memoized on the shown text; commands are
  // short so this is micro-cost. Falls back to plain text on hljs
  // failure or for the wait pseudo-command.
  const commandHtml = useMemo(() => {
    if (vm.sourceTool === 'wait') return null
    try {
      return hljs.highlight(shown, { language: 'bash', ignoreIllegals: true }).value
    } catch {
      return null
    }
  }, [shown, vm.sourceTool])

  // Native-style slim wait row: "• Waited for background terminal"
  // (codex history_cell/exec.rs) — dim, no output well, duration chip
  // when known. These are frequent while long commands drain; a full
  // command card per poll would drown the feed.
  if (vm.sourceTool === 'wait') {
    return (
      <MarkerRow marker="⏺" tone="muted">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-[1.65]">
          <span className="text-ink-dim font-semibold">Waited for background terminal</span>
          {vm.durationMs != null && vm.durationMs > 0 ? (
            <span className="text-muted text-[11px]">
              {(vm.durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  // Verb header, native vocabulary: Running while the input streams /
  // awaits a result, Ran when done (exec_cell/render.rs). The ✓/exit
  // badge still carries success; the verb carries tense.
  const verb = vm.status === 'streaming' || vm.status === 'running' ? 'Running' : 'Ran'

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-accent font-semibold text-[13px] leading-[1.55] select-none">
            {verb}
          </span>
          <pre
            className={`font-code text-[13px] leading-[1.55] text-ink m-0 whitespace-pre-wrap break-all inline min-w-0 ${isTruncated ? 'cursor-pointer' : ''}`}
            onClick={() => isTruncated && setShowFull(v => !v)}
            title={isTruncated && !showFull ? 'click to expand full command' : undefined}
          >
            {commandHtml !== null ? (
              <code
                className="hljs language-bash"
                dangerouslySetInnerHTML={{ __html: commandHtml }}
              />
            ) : (
              shown
            )}
          </pre>
          <StatusBadge
            status={vm.status}
            exitCode={vm.exitCode}
            durationMs={vm.durationMs}
          />
        </div>
        {(cwdBase || vm.description || vm.yieldTimeMs != null) && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
            {cwdBase ? <span title={vm.cwd ?? undefined}>cwd: {cwdBase}</span> : null}
            {vm.description ? <span className="italic">{vm.description}</span> : null}
            {vm.yieldTimeMs != null ? <span>yield {vm.yieldTimeMs}ms</span> : null}
            {vm.maxOutputTokens != null ? <span>max {vm.maxOutputTokens} tokens</span> : null}
          </div>
        )}
        {vm.stdinWrites.map((chars, i) => (
          <div key={i} className="mt-0.5 text-[11px] text-muted font-code break-all">
            stdin → {chars.slice(0, 120)}
            {chars.length > 120 ? '…' : ''}
          </div>
        ))}
        {vm.output && vm.parsedRead ? (
          // Codex classified this exec as a file read/search — a
          // one-line summary with the source behind a lazy expand reads
          // far better than N raw lines (ported from the old
          // ExpandableCodeResult; Monaco stays first-open gated).
          <MarkerRow marker="⎿" tone="muted">
            <ExpandSection
              summary={(() => {
                const lineCount = vm.output.trim() ? vm.output.split('\n').length : 0
                const noun = lineCount === 1 ? 'line' : 'lines'
                const displayPath = vm.parsedRead.path
                  ? formatToolFilePath(vm.parsedRead.path, workspaceRoot)
                  : null
                return vm.parsedRead.kind === 'read'
                  ? displayPath
                    ? `Read ${lineCount} ${noun} from ${displayPath}`
                    : `Read ${lineCount} ${noun}`
                  : displayPath
                    ? `Search results: ${lineCount} ${noun} in ${displayPath}`
                    : `Search results: ${lineCount} ${noun}`
              })()}
            >
              <CodeBlock
                code={vm.output}
                path={vm.parsedRead.path}
                workspaceRoot={workspaceRoot}
                codeId={`cmd-read:${vm.id}`}
                engine="monaco"
                allowAutoDetect
              />
            </ExpandSection>
          </MarkerRow>
        ) : vm.output ? (
          <OutputWell text={vm.output} isError={vm.status === 'error'} ansi />
        ) : null}
      </div>
    </MarkerRow>
  )
})
