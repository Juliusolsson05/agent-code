import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openFileInGlobalEditor = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, opened: true })))
vi.mock('@renderer/features/global-editor/openFileInGlobalEditor', () => ({ openFileInGlobalEditor }))

import { ContentSearchOverlay } from './ContentSearchOverlay'

// Search in Files on the shared list keys (plan S23): ⌃N and PageDown move
// through results from the input, Enter opens the highlighted match, and the
// keys are shown in the status bar.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
  openFileInGlobalEditor.mockClear()
})

describe('Search in Files', () => {
  it('moves through results with ⌃N / PageDown and opens the highlighted match', async () => {
    const matches = Array.from({ length: 20 }, (_, i) => ({
      path: `src/a${i}.ts`, line: i + 1, column: 1, preview: 'needle here', previewMatchOffset: 0, matchLength: 6,
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        editorSearchContent: vi.fn(async () => ({ ok: true, matches, truncated: false, filesScanned: 20, errorCount: 0, stopReason: 'complete' })),
      },
    })
    render(<ContentSearchOverlay root="/repo" onClose={vi.fn()} />)
    const input = screen.getByRole('combobox', { name: 'Search in files' })
    fireEvent.change(input, { target: { value: 'needle' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(20))
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'content-search-option-11')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(openFileInGlobalEditor).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/a11.ts', line: 12 })))
    expect(document.querySelector('[data-slot="kbd-legend"]')).not.toBeNull()
  })
})
