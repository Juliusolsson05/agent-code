import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import {
  applyPatchText,
  parseApplyPatch,
} from '@providers/codex/renderer/rows/CodexRows'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'

// Codex wire → CodeEditRenderModel (renderer rewrite, PR #555; Phase 5
// adapter). Codex-PRIVATE — parses the apply_patch envelope (classic and
// the raw streaming text) plus patch_apply_end results; Claude never
// appears here. Reuses the battle-tested parseApplyPatch from CodexRows
// rather than a second patch parser (one decoder per wire shape, ever).
//
// STREAMING-FIRST: parseApplyPatch is prefix-tolerant by construction — a
// partial patch body simply yields the files/hunks streamed SO FAR, so a
// model exists from the moment `*** Begin Patch` + the first file header
// arrive. The trap this kills: waiting for the full JSON/patch to land
// before rendering anything (which reduces streaming to a spinner).

const VERB = { Add: 'Creating', Update: 'Editing', Delete: 'Deleting' } as const

function toFiles(input: unknown, streaming: boolean): CodeEditFile[] {
  return parseApplyPatch(input).map(f => ({
    path: f.movedTo ? `${f.path} → ${f.movedTo}` : f.path,
    verb: f.movedTo ? 'Moving' : VERB[f.action],
    lines: f.lines,
    additions: f.lines.filter(l => l.kind === '+').length,
    deletions: f.lines.filter(l => l.kind === '-').length,
    streaming,
  }))
}

export function fromCodexApplyPatch(
  block: ToolUseBlock,
  opts: { streaming?: boolean; result?: ToolResultBlock | null } = {},
): CodeEditRenderModel | null {
  const files = toFiles(block.input, opts.streaming === true)
  // No recognizable patch yet (input still streaming its preamble, or an
  // unexpected wrapper): decline — the caller's fallback stays visible.
  // The `*** Begin Patch` sentinel is what makes intent provable ASAP.
  if (files.length === 0) return null
  const failed = opts.result?.is_error === true
  return {
    label: 'apply_patch',
    files,
    status: opts.streaming ? 'streaming' : failed ? 'failure' : 'success',
    errorSummary: failed
      ? firstLine(opts.result)
      : undefined,
    partial: opts.streaming === true,
  }
}

/** Raw streaming patch TEXT (unified-exec/live plane) → model ASAP. */
export function fromCodexPartialPatchText(rawPatch: string): CodeEditRenderModel | null {
  return fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'apply_patch', input: { input: rawPatch } } as ToolUseBlock, {
    streaming: true,
  })
}

function firstLine(result: ToolResultBlock | null | undefined): string | undefined {
  const c = result?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? String((c[0] as { text?: unknown })?.text ?? '') : ''
  return text ? text.split('\n')[0].slice(0, 200) : 'patch failed'
}

export { applyPatchText }
