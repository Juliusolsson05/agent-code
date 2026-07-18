import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'

import { CodexApplyPatchRow } from './index'

function files(count: number): CodeEditFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `f${index}.ts`,
    verb: 'Editing',
    lines: [],
    additions: 0,
    deletions: 0,
    streaming: false,
  }))
}

function model(overrides: Partial<CodeEditRenderModel> = {}): CodeEditRenderModel {
  return {
    label: 'apply_patch',
    files: files(1),
    status: 'success',
    partial: false,
    ...overrides,
  }
}

describe('CodexApplyPatchRow exact patch disclosure', () => {
  it('offers short raw evidence when CodeEditView hides operation 25', () => {
    const rawPatch = '*** Begin Patch\n*** End Patch'

    render(
      <CodexApplyPatchRow
        model={model({ files: files(25), totalFiles: 25 })}
        rawPatch={rawPatch}
      />,
    )

    expect(screen.getByText('Showing 24 of 25 file operations.')).toBeInTheDocument()
    expect(screen.getByText('Rich preview is partial · view exact paged patch')).toBeInTheDocument()
    expect(screen.getByText((_, element) => (
      element?.tagName === 'PRE' && element.textContent === rawPatch
    ))).toBeInTheDocument()
  })

  it('does not offer disclosure for a complete short model within the cap', () => {
    render(
      <CodexApplyPatchRow
        model={model({ files: files(24), totalFiles: 24 })}
        rawPatch={'*** Begin Patch\n*** End Patch'}
      />,
    )

    expect(screen.queryByText('Rich preview is partial · view exact paged patch')).not.toBeInTheDocument()
  })

  it('trusts adapter truncation metadata without measuring raw patch text', () => {
    render(
      <CodexApplyPatchRow
        model={model({
          files: files(2),
          totalFiles: 2,
          filesTruncated: true,
        })}
        rawPatch={'*** Begin Patch\n*** End Patch'}
      />,
    )

    expect(screen.getByText('Rich preview is partial · view exact paged patch')).toBeInTheDocument()
  })
})
