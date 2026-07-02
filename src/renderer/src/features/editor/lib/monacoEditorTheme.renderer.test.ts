import { beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'

type FakeMonaco = {
  editor: {
    defineTheme: ReturnType<typeof vi.fn>
    setTheme: ReturnType<typeof vi.fn>
  }
}

function fakeMonaco(): FakeMonaco {
  return {
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
  }
}

async function loadThemeModule(): Promise<typeof import('./monacoEditorTheme')> {
  vi.resetModules()
  return import('./monacoEditorTheme')
}

describe('monaco editor theme activation', () => {
  beforeEach(() => {
    document.documentElement.dataset.mode = 'dark'
    document.documentElement.dataset.contrast = 'normal'
  })

  it('does not force the editor theme on app theme changes until editor mode is active', async () => {
    const monaco = fakeMonaco()
    const themes = await loadThemeModule()

    themes.ensureEditorThemes(monaco as never)
    monaco.editor.setTheme.mockClear()

    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT))

    expect(monaco.editor.setTheme).not.toHaveBeenCalled()
  })

  it('restores the default runtime theme after the last editor deactivates', async () => {
    const monaco = fakeMonaco()
    const themes = await loadThemeModule()

    themes.activateEditorTheme(monaco as never)
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('agent-code-editor-dark')

    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT))
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('agent-code-editor-dark')

    themes.deactivateEditorTheme(monaco as never)
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith('agent-code-dark')

    monaco.editor.setTheme.mockClear()
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT))

    expect(monaco.editor.setTheme).not.toHaveBeenCalled()
  })
})
