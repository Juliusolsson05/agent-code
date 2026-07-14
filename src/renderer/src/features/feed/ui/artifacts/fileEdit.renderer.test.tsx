import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ToolUseBlock } from '@shared/types/transcript'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import { STREAMING_EDIT_PREVIEW_LINES } from '@providers/claude/renderer/extractors'

import { CodeRenderContext } from '@renderer/features/feed/context'

import { DiffCard, fileEditFromCommitted, fileEditFromLive } from './fileEdit'

function openDetails(summary: HTMLElement) {
  const details = summary.closest('details')
  if (!details) throw new Error('expected summary to belong to details')
  details.open = true
  fireEvent(details, new Event('toggle'))
}

describe('DiffCard source accountability', () => {
  it('keeps the exact decoded patch grammar behind a lazy debug disclosure', () => {
    const source = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      '-const oldValue = true',
      '+const newValue = true',
      '*** End Patch',
    ].join('\n')
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'patch-source-1',
      name: 'apply_patch',
      input: { raw: source },
    }
    const vm = fileEditFromCommitted(tool, null, 'codex')

    expect(vm.parsedPatchSource).toBe(source)
    render(
      <CodeRenderContext.Provider value={{ sessionId: 'test', workspaceRoot: '/workspace' }}>
        <DiffCard vm={vm} toolName="apply_patch" />
      </CodeRenderContext.Provider>,
    )

    const summary = screen.getByText('Parsed patch source (debug)')
    expect(summary.closest('details')?.querySelector('[data-code-block-id]')).toBeNull()
    openDetails(summary)
    expect(summary.closest('details')?.textContent).toContain(source)
  })

  it('bounds live Edit rows, labels the cap, and keeps exact provider bytes lazy', () => {
    const replacement = Array.from(
      { length: STREAMING_EDIT_PREVIEW_LINES + 120 },
      (_, index) => `line ${index}`,
    ).join('\n')
    const raw = JSON.stringify({
      file_path: 'src/generated.ts',
      old_string: '',
      new_string: replacement,
    })
    const block: SemanticLiveTurn['blocks'][number] = {
      blockIndex: 0,
      kind: 'tool_use',
      toolName: 'Edit',
      toolUseId: 'bounded-edit',
      inputJson: raw,
      finalized: false,
    }
    const vm = fileEditFromLive(block, null, 'claude')

    expect(vm.previewState).toBe('capped')
    expect(vm.diffs.flat()).toHaveLength(STREAMING_EDIT_PREVIEW_LINES)
    expect(vm.sourceInput).toBe(raw)

    render(
      <CodeRenderContext.Provider value={{ sessionId: 'test', workspaceRoot: '/workspace' }}>
        <DiffCard vm={vm} toolName="Edit" />
      </CodeRenderContext.Provider>,
    )

    expect(screen.getByText(/Live diff preview paused at its safety limit/)).toBeTruthy()
    const sourceSummary = screen.getByText('Exact source input (debug)')
    expect(sourceSummary.closest('details')?.querySelector('[data-code-block-id]')).toBeNull()
    openDetails(sourceSummary)
    expect(sourceSummary.closest('details')?.textContent).toContain('line 519')
  })

  it('does not apply live-preview limits to authoritative parsed input', () => {
    const replacement = Array.from(
      { length: STREAMING_EDIT_PREVIEW_LINES + 20 },
      (_, index) => `exact ${index}`,
    ).join('\n')
    const parsedInput = {
      file_path: 'src/exact.ts',
      old_string: '',
      new_string: replacement,
    }
    const block: SemanticLiveTurn['blocks'][number] = {
      blockIndex: 0,
      kind: 'tool_use',
      toolName: 'Edit',
      toolUseId: 'exact-edit',
      inputJson: JSON.stringify(parsedInput),
      parsedInput,
      finalized: true,
    }
    const vm = fileEditFromLive(block, null, 'claude')

    expect(vm.previewState).toBe('exact')
    expect(vm.diffs.flat()).toHaveLength(STREAMING_EDIT_PREVIEW_LINES + 20)
    expect(vm.sourceInput).toBeNull()
  })
})
