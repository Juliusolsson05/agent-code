import type * as Monaco from 'monaco-editor'

import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import {
  normalizeMonacoThemeColor,
  normalizeMonacoThemeColorAlpha,
} from '@renderer/lib/code/monacoThemeColors'
import {
  editorThemeAcquired,
  editorThemeReleased,
  isEditorThemeActive,
} from '@renderer/lib/code/monacoThemeState'

// Dedicated Monaco theme for the editor mode.
//
// WHY this is separate from `monacoRuntime.ts`:
//   The CodeBlock variant deliberately uses `--theme-code-bg` (#050507),
//   which is darker than the canvas — that contrast is what makes inline
//   code in transcripts read as a "slab". In editor mode the Monaco
//   instance IS the canvas; using the code-slab background made the file
//   editor feel sunk into the page. The editor theme below copies Agent Code
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

const EDITOR_THEME_BASE_DARK = 'agent-code-editor-dark'
const EDITOR_THEME_BASE_LIGHT = 'agent-code-editor-light'

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function currentModeIsLight(): boolean {
  return document.documentElement.dataset.mode?.startsWith('light') === true
}

function defineEditorThemes(monaco: typeof Monaco): void {
  const bg = normalizeMonacoThemeColor(readToken('--theme-editor-bg', '#0a0a0a'), '#0a0a0a')
  const fg = normalizeMonacoThemeColor(readToken('--theme-editor-fg', '#e8e8e6'), '#e8e8e6')
  const muted = normalizeMonacoThemeColor(readToken('--theme-muted', '#5a5a56'), '#5a5a56')
  const border = normalizeMonacoThemeColor(readToken('--theme-border', '#1a1a1c'), '#1a1a1c')
  const borderHi = normalizeMonacoThemeColor(readToken('--theme-border-hi', '#272729'), '#272729')
  const accent = normalizeMonacoThemeColor(readToken('--theme-accent', '#7dd3a0'), '#7dd3a0')
  const selection = normalizeMonacoThemeColor(
    readToken('--theme-editor-selection-bg', ''),
    normalizeMonacoThemeColorAlpha(accent, '33', '#7dd3a0'),
  )
  const inactiveSelection = normalizeMonacoThemeColor(
    readToken('--theme-editor-selection-inactive-bg', ''),
    normalizeMonacoThemeColorAlpha(accent, '22', '#7dd3a0'),
  )
  const currentLine = normalizeMonacoThemeColor(
    readToken('--theme-editor-current-line-bg', ''),
    borderHi,
  )
  const scrollbarBackground = normalizeMonacoThemeColor(
    readToken('--theme-editor-scrollbar-bg', ''),
    normalizeMonacoThemeColorAlpha(muted, '55', '#5a5a56'),
  )
  const scrollbarHover = normalizeMonacoThemeColor(
    readToken('--theme-editor-scrollbar-hover-bg', ''),
    normalizeMonacoThemeColorAlpha(muted, '88', '#5a5a56'),
  )
  const scrollbarActive = normalizeMonacoThemeColor(
    readToken('--theme-editor-scrollbar-active-bg', ''),
    normalizeMonacoThemeColorAlpha(accent, 'aa', '#7dd3a0'),
  )

  const sharedColors = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editorLineNumber.foreground': muted,
    'editorLineNumber.activeForeground': fg,
    'editor.selectionBackground': selection,
    'editor.inactiveSelectionBackground': inactiveSelection,
    'editorCursor.foreground': accent,
    'editor.lineHighlightBackground': currentLine,
    'editor.lineHighlightBorder': border,
    'editorIndentGuide.background1': border,
    'editorIndentGuide.activeBackground1': muted,
    'editorWidget.background': bg,
    'editorWidget.border': borderHi,
    'editorHoverWidget.background': bg,
    'editorHoverWidget.border': borderHi,
    'editorGutter.background': bg,
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': scrollbarBackground,
    'scrollbarSlider.hoverBackground': scrollbarHover,
    'scrollbarSlider.activeBackground': scrollbarActive,
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
// Agent Code theme-changed event the rest of the app fires when the user
// switches mode/accent, redefining the theme so the editor follows along.
//
// The activation refcount itself lives in lib/code/monacoThemeState so
// monacoRuntime's slab-theme listener can consult it without a
// lib→features import — see that module's ownership contract (#513
// theme-war fix).
let initialized = false
let themeListenerAttached = false

export function ensureEditorThemes(monaco: typeof Monaco): void {
  if (!initialized) {
    defineEditorThemes(monaco)
    initialized = true
  }
  if (!themeListenerAttached) {
    themeListenerAttached = true
    window.addEventListener(THEME_CHANGED_EVENT, () => {
      defineEditorThemes(monaco)
      if (isEditorThemeActive()) {
        // Re-applying the same theme name nudges Monaco to repaint all live
        // editors with the freshly resolved colour tokens. Monaco themes are
        // global, so this must only happen while editor mode is actively using
        // the editor theme; otherwise a normal app theme change after closing
        // the file editor would force CodeBlock instances back onto the editor
        // canvas theme and override monacoRuntime's default theme listener.
        monaco.editor.setTheme(currentEditorThemeName())
      }
    })
  }
}

export function activateEditorTheme(monaco: typeof Monaco): void {
  // WHY keep a reference count instead of a boolean: Monaco's theme is global,
  // but React editor mounts are not guaranteed to be singletons forever. A
  // future split-editor view can mount multiple MonacoFileEditor instances; the
  // first one should switch the global theme to the editor palette, and the last
  // one should restore the default CodeBlock/runtime palette.
  editorThemeAcquired()
  ensureEditorThemes(monaco)
  monaco.editor.setTheme(currentEditorThemeName())
}

export function deactivateEditorTheme(monaco: typeof Monaco): void {
  editorThemeReleased()
  if (!isEditorThemeActive()) {
    monaco.editor.setTheme(defaultAgentCodeThemeName())
  }
}

export function currentEditorThemeName(): string {
  return currentModeIsLight() ? EDITOR_THEME_BASE_LIGHT : EDITOR_THEME_BASE_DARK
}

// Mirror of `monacoRuntime.ts#currentThemeName`. Duplicated here on purpose so
// the editor feature can restore the global Monaco theme when editor mode
// exits without depending on a private export from the runtime module. If
// that helper is ever exported we can collapse this.
export function defaultAgentCodeThemeName(): string {
  const root = document.documentElement
  if (root.dataset.contrast === 'high') {
    return root.dataset.mode?.startsWith('light')
      ? 'agent-code-high-contrast-light'
      : 'agent-code-high-contrast-dark'
  }
  return root.dataset.mode?.startsWith('light') ? 'agent-code-light' : 'agent-code-dark'
}
