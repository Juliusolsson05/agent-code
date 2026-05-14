import type * as Monaco from 'monaco-editor'

// Dedicated Monaco theme for the editor mode.
//
// WHY this is separate from `monacoRuntime.ts`:
//   The CodeBlock variant deliberately uses `--theme-code-bg` (#050507),
//   which is darker than the canvas — that contrast is what makes inline
//   code in transcripts read as a "slab". In editor mode the Monaco
//   instance IS the canvas; using the code-slab background made the file
//   editor feel sunk into the page. The editor theme below copies cc-shell
//   colours but pulls `editor.background` from `--theme-canvas` so the
//   editor visually continues the workbench surface.
//
// Side effect to be aware of:
//   Monaco's `setTheme` is global. While editor mode is open, every other
//   Monaco instance (e.g. CodeBlock instances rendered inside the pinned
//   agent rail) will also paint with this theme. That is intentional — in
//   editor mode the rail is a secondary surface, and the slight tone shift
//   is preferable to keeping the file editor as a darker pit. On exit the
//   caller must restore the previous global theme via `setTheme(previous)`.

const EDITOR_THEME_BASE_DARK = 'cc-shell-editor-dark'
const EDITOR_THEME_BASE_LIGHT = 'cc-shell-editor-light'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function currentModeIsLight(): boolean {
  return document.documentElement.dataset.mode?.startsWith('light') === true
}

function defineEditorThemes(monaco: typeof Monaco): void {
  const bg = readToken('--theme-canvas', '#0a0a0a')
  const fg = readToken('--theme-ink', '#e8e8e6')
  const muted = readToken('--theme-muted', '#5a5a56')
  const border = readToken('--theme-border', '#1a1a1c')
  const borderHi = readToken('--theme-border-hi', '#272729')
  const accent = readToken('--theme-accent', '#7dd3a0')

  const sharedColors = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorLineNumber.foreground': muted,
    'editorLineNumber.activeForeground': fg,
    'editor.selectionBackground': `${accent}33`,
    'editor.inactiveSelectionBackground': `${accent}22`,
    'editorCursor.foreground': accent,
    'editor.lineHighlightBackground': borderHi,
    'editor.lineHighlightBorder': border,
    'editorIndentGuide.background1': border,
    'editorIndentGuide.activeBackground1': muted,
    'editorWidget.background': bg,
    'editorWidget.border': borderHi,
    'editorHoverWidget.background': bg,
    'editorHoverWidget.border': borderHi,
    'editorGutter.background': bg,
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': `${muted}55`,
    'scrollbarSlider.hoverBackground': `${muted}88`,
    'scrollbarSlider.activeBackground': `${accent}aa`,
  }

  monaco.editor.defineTheme(EDITOR_THEME_BASE_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: sharedColors,
  })

  monaco.editor.defineTheme(EDITOR_THEME_BASE_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: sharedColors,
  })
}

// Module-level guard: defineTheme is idempotent for Monaco but cheap to
// avoid hitting on every editor mount. We also listen once for the
// `cc-shell:theme-changed` event the rest of the app fires when the user
// switches mode/accent, redefining the theme so the editor follows along.
let initialized = false
let themeListenerAttached = false

export function ensureEditorThemes(monaco: typeof Monaco): void {
  if (!initialized) {
    defineEditorThemes(monaco)
    initialized = true
  }
  if (!themeListenerAttached) {
    themeListenerAttached = true
    window.addEventListener('cc-shell:theme-changed', () => {
      defineEditorThemes(monaco)
      // Re-applying the same theme name nudges Monaco to repaint all live
      // editors with the freshly resolved colour tokens.
      monaco.editor.setTheme(currentEditorThemeName())
    })
  }
}

export function currentEditorThemeName(): string {
  return currentModeIsLight() ? EDITOR_THEME_BASE_LIGHT : EDITOR_THEME_BASE_DARK
}

// Mirror of `monacoRuntime.ts#currentThemeName`. Duplicated here on purpose so
// the editor feature can restore the global Monaco theme when editor mode
// exits without depending on a private export from the runtime module. If
// that helper is ever exported we can collapse this.
export function defaultCcShellThemeName(): string {
  const root = document.documentElement
  if (root.dataset.contrast === 'high') {
    return root.dataset.mode?.startsWith('light')
      ? 'cc-shell-high-contrast-light'
      : 'cc-shell-high-contrast-dark'
  }
  return root.dataset.mode?.startsWith('light') ? 'cc-shell-light' : 'cc-shell-dark'
}
