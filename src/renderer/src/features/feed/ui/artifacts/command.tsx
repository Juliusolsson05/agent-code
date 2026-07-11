import { memo, useState } from 'react'

import { truncateBashCommand } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'

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

  // Empty write_stdin renders NOTHING — preserved verbatim from the
  // CodexWriteStdinRow this card replaced. Codex emits empty stdin
  // writes as poll/continuation calls while a long PTY command drains;
  // they carry no user-visible content. renderUnits.ts's
  // isInvisibleWriteStdinBlock mirrors this so the render model and
  // the DOM agree the block owns no screen real estate — if you change
  // this, change that selector in the same commit.
  if (vm.sourceTool === 'write_stdin' && vm.stdinWrites.every(s => s.length === 0)) {
    return null
  }

  const truncated = truncateBashCommand(vm.command)
  const isTruncated = truncated !== vm.command
  const cwdBase = vm.cwd ? vm.cwd.split('/').filter(Boolean).pop() ?? vm.cwd : null

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <pre
            className={`font-code text-[13px] leading-[1.55] text-ink m-0 whitespace-pre-wrap break-all inline ${isTruncated ? 'cursor-pointer' : ''}`}
            onClick={() => isTruncated && setShowFull(v => !v)}
            title={isTruncated && !showFull ? 'click to expand full command' : undefined}
          >
            <span className="text-accent select-none">$ </span>
            {showFull ? vm.command : truncated}
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
        {vm.output ? (
          <OutputWell text={vm.output} isError={vm.status === 'error'} ansi />
        ) : null}
      </div>
    </MarkerRow>
  )
})
