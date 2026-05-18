import type * as Monaco from 'monaco-editor'

import {
  normalizeCodeLanguage,
  supportsLsp,
} from '@shared/code/language'
import { APP_SLUG } from '@shared/appIdentity'

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

const semanticLegends = new Map<
  string,
  { tokenTypes: string[]; tokenModifiers: string[] }
>()
const registeredLanguages = new Set<string>()
const pendingSemanticProviders = new Map<string, Promise<void>>()

let monacoPromise: Promise<typeof Monaco> | null = null
let themeListenerInstalled = false

function currentThemeName(): string {
  const root = document.documentElement
  if (root.dataset.contrast === 'high') {
    return root.dataset.mode?.startsWith('light')
      ? 'agent-code-high-contrast-light'
      : 'agent-code-high-contrast-dark'
  }
  return root.dataset.mode?.startsWith('light') ? 'agent-code-light' : 'agent-code-dark'
}

function defineThemes(monaco: typeof Monaco): void {
  const styles = getComputedStyle(document.documentElement)
  const bg = styles.getPropertyValue('--theme-code-bg').trim() || '#12120f'
  const fg = styles.getPropertyValue('--theme-code-ink').trim() || '#e8e8e6'
  const muted =
    styles.getPropertyValue('--theme-code-ink-dim').trim() || '#a8a8a4'
  const border = styles.getPropertyValue('--theme-code-border').trim() || '#262622'
  const accent = styles.getPropertyValue('--theme-accent').trim() || '#7dd3a0'

  monaco.editor.defineTheme('agent-code-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': fg,
      'editor.selectionBackground': `${accent}33`,
      'editor.inactiveSelectionBackground': `${accent}22`,
      'editorCursor.foreground': accent,
      'editor.lineHighlightBorder': border,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': muted,
    },
  })

  monaco.editor.defineTheme('agent-code-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorLineNumber.foreground': muted,
      'editorLineNumber.activeForeground': fg,
      'editor.selectionBackground': `${accent}33`,
      'editor.inactiveSelectionBackground': `${accent}22`,
      'editorCursor.foreground': accent,
      'editor.lineHighlightBorder': border,
      'editorIndentGuide.background1': border,
      'editorIndentGuide.activeBackground1': muted,
    },
  })

  monaco.editor.defineTheme('agent-code-high-contrast-dark', {
    base: 'hc-black',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorCursor.foreground': accent,
    },
  })

  monaco.editor.defineTheme('agent-code-high-contrast-light', {
    base: 'hc-light',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorCursor.foreground': accent,
    },
  })

  monaco.editor.setTheme(currentThemeName())
}

function installThemeListener(monaco: typeof Monaco): void {
  if (themeListenerInstalled) return
  themeListenerInstalled = true
  window.addEventListener(`${APP_SLUG}:theme-changed`, () => {
    defineThemes(monaco)
  })
}

export async function getMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = import('monaco-editor')
  }
  const monaco = await monacoPromise
  const monacoWindow = window as Window & {
    MonacoEnvironment?: {
      getWorker: (_moduleId: string, label: string) => Worker
    }
  }
  if (!monacoWindow.MonacoEnvironment) {
    monacoWindow.MonacoEnvironment = {
      getWorker(_moduleId: string, label: string) {
        if (label === 'typescript' || label === 'javascript') {
          return new tsWorker()
        }
        if (label === 'json') return new jsonWorker()
        if (label === 'css' || label === 'scss' || label === 'less') {
          return new cssWorker()
        }
        if (label === 'html' || label === 'handlebars' || label === 'razor') {
          return new htmlWorker()
        }
        return new editorWorker()
      },
    }
  }
  defineThemes(monaco)
  installThemeListener(monaco)
  return monaco
}

export async function ensureSemanticProvider(
  monaco: typeof Monaco,
  workspaceRoot: string | null | undefined,
  language: string,
): Promise<void> {
  const normalized = normalizeCodeLanguage(language)
  if (!workspaceRoot || !supportsLsp(normalized)) return
  if (registeredLanguages.has(normalized)) return

  const pending = pendingSemanticProviders.get(normalized)
  if (pending) return pending

  // WHY provider registration is promise-coalesced even though the final
  // provider is global per language: transcript rendering can mount dozens of
  // Monaco code blocks in the same tick. Without this in-flight guard, every
  // block sees `registeredLanguages` as false before `ensureLspLegend` returns,
  // so they all perform duplicate IPC and register duplicate semantic-token
  // providers. Monaco keeps those providers alive globally; the cheapest and
  // safest fix is to let the first mount own registration while later mounts
  // await the same promise.
  const registration = (async () => {
    const legend = await window.api.ensureLspLegend(workspaceRoot, normalized)
    if (!legend) return

    semanticLegends.set(normalized, legend)
    registeredLanguages.add(normalized)
    monaco.languages.registerDocumentSemanticTokensProvider(normalized, {
      getLegend() {
        const current = semanticLegends.get(normalized)
        return {
          tokenTypes: current?.tokenTypes ?? [],
          tokenModifiers: current?.tokenModifiers ?? [],
        }
      },
      async provideDocumentSemanticTokens(model) {
        const result = await window.api.getLspSemanticTokens(model.uri.toString())
        if (!result) return null
        return { data: Uint32Array.from(result.data) }
      },
      releaseDocumentSemanticTokens() {},
    })
  })().finally(() => {
    pendingSemanticProviders.delete(normalized)
  })
  pendingSemanticProviders.set(normalized, registration)
  return registration
}
