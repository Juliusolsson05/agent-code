import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CodeEditView } from './CodeEditView'
import type { CodeEditRenderModel } from './model'

function model(paths: string[]): CodeEditRenderModel {
  return {
    label: 'MultiEdit',
    files: paths.map(path => ({
      path,
      verb: 'Editing',
      lines: [],
      additions: 1,
      deletions: 0,
      streaming: true,
    })),
    status: 'streaming',
    partial: true,
  }
}

describe('CodeEditView operation identity', () => {
  it('keeps repeated paths unique and a closing streaming path mounted in place', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const view = render(<CodeEditView model={model(['', 'same.ts', 'same.ts'])} />)
      expect(error.mock.calls.some(call => call.join(' ').includes('same key'))).toBe(false)

      // DOM identity is the user-visible consequence of a stable React key:
      // the first operation begins unnamed, then receives its path without
      // remounting its streaming slab/disclosure state.
      const before = screen.getByText(/Editing …/)
      view.rerender(<CodeEditView model={model(['first.ts', 'same.ts', 'same.ts'])} />)
      const after = screen.getByText(/Editing first\.ts/)
      expect(after).toBe(before)
      expect(error.mock.calls.some(call => call.join(' ').includes('same key'))).toBe(false)
    } finally {
      error.mockRestore()
    }
  })
})
