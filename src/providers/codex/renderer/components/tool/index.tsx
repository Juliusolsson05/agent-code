// Codex generic tool component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).
//
// CodexToolRow is the provider's own fallback card: it understands Codex's
// function-call payload conventions (cmd arrays, apply_patch raw text,
// path-before-description precedence) and is the designated fallback for the
// specialized codex components (exec-command, apply-patch) when their
// adapters decline. It deliberately does NOT claim unknown tool names —
// dispatch returns undefined so the SHARED JsonToolRow fallback owns those
// (residue plan P1: one fallback, one behavior, all providers).

import { memo, useMemo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import type { ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import {
  boundedCommandParts,
  MAX_COMMAND_DISPLAY_CHARS,
  MAX_COMMAND_DISPLAY_LINES,
  truncateCommand,
} from '@providers/codex/renderer/adapters/command'

function summarizePatchTargets(input: unknown): string[] {
  const fullText =
    typeof input === 'string'
      ? input
      : typeof asRecord(input)?.raw === 'string'
        ? String(asRecord(input)?.raw)
        : ''
  if (!fullText) return []

  // WHY only scan one renderer page: this headline is a preview, not a patch
  // parser. Spreading matchAll over a generated megabyte patch allocates every
  // match before slice(0, 6) can discard them, and repeats during live deltas.
  const text = boundedTextPage(fullText).text
  const targets: string[] = []
  for (const match of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    targets.push(match[1])
    if (targets.length >= 6) break
  }
  return targets
}

function headlineForTool(block: ToolUseBlock): string | null {
  const input = asRecord(block.input)
  if (!input) return null

  if (block.name === 'write_stdin') {
    const chars = input.chars
    if (typeof chars === 'string' && chars.length > 0) return chars
    return null
  }

  if (block.name === 'exec_command') {
    const cmd = input.cmd
    if (typeof cmd === 'string') return cmd
    if (Array.isArray(cmd)) return boundedCommandParts(cmd)
  }

  if (block.name === 'apply_patch') {
    const targets = summarizePatchTargets(block.input)
    if (targets.length > 0) return targets.join('\n')
  }

  if (typeof input.command === 'string') return input.command
  // Path BEFORE description (corpus bug, plan-json-tool-rows §1b):
  // ai_workspace_attach_file showed its description gloss while hiding
  // the actual file path. A path is an identifier; a description is
  // commentary.
  if (typeof input.path === 'string') return input.path
  if (typeof input.description === 'string') return input.description
  if (typeof input.arguments === 'string') return input.arguments.slice(0, 160)
  if (typeof input.raw === 'string' && block.name !== 'apply_patch') return input.raw.slice(0, 160)
  return null
}

export const CodexToolRow = memo(function CodexToolRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const headline = useMemo(() => {
    const raw = headlineForTool(block)
    if (!raw) return null
    if (block.name === 'exec_command') return truncateCommand(raw)
    return boundedTextPage(raw, 0, MAX_COMMAND_DISPLAY_CHARS, MAX_COMMAND_DISPLAY_LINES).text
  }, [block])

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})
