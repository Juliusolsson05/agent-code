import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openFileInGlobalEditor = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, opened: true })))
vi.mock('@renderer/features/global-editor/openFileInGlobalEditor', () => ({ openFileInGlobalEditor }))

import { QuickOpenOverlay } from './QuickOpenOverlay'

// Quick Open on the shared list keys (plan S22): the combobox input is the
// focus owner, ⌃N/⌃P and PageDown move like every other list, Enter opens,
// and the keys are shown instead of living in an sr-only description.

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  // Unmount FIRST: the overlay's cleanup tells main to stop indexing through
  // window.api, which must still be the mock at that point.
  cleanup()
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
  openFileInGlobalEditor.mockClear()
})

async function harness() {
  const files = Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.ts`)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      editorListFilesRecursive: vi.fn(async () => ({ ok: true, files, truncated: false, errorCount: 0 })),
      editorCancelListFilesRecursive: vi.fn(),
    },
  })
  const onClose = vi.fn()
  render(<QuickOpenOverlay root="/repo" onClose={onClose} />)
  await act(async () => { await Promise.resolve() })
  const input = screen.getByRole('combobox', { name: 'Go to file' })
  return { input, onClose }
}

describe('Quick Open', () => {
  it('moves with ⌃N and PageDown from the input and opens the highlighted file on Enter', async () => {
    const { input } = await harness()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'n', ctrlKey: true })
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-open-option-1')
    fireEvent.keyDown(input, { key: 'PageDown' })
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-open-option-11')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(openFileInGlobalEditor).toHaveBeenCalledWith({ root: '/repo', path: 'src/file-11.ts' }))
  })

  it('leaves Home/End to the caret in the search box', async () => {
    const { input } = await harness()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(fireEvent.keyDown(input, { key: 'End' })).toBe(true)
    expect(input).toHaveAttribute('aria-activedescendant', 'quick-open-option-1')
  })

  it('shows its keys as a chip legend', async () => {
    await harness()
    expect(screen.getByText('open')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="kbd-legend"]')).not.toBeNull()
  })
})
