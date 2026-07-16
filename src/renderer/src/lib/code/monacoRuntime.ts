import type * as Monaco from 'monaco-editor'

import {
  monacoLanguageId,
  normalizeCodeLanguage,
  supportsLsp,
} from '@shared/code/language'
import { APP_SLUG } from '@shared/appIdentity'
import {
  normalizeMonacoThemeColor,
  normalizeMonacoThemeColorAlpha,
} from './monacoThemeColors'
import { registerMonacoModelCountProbe } from './monacoModelProbe'
import { isEditorThemeActive } from './monacoThemeState'

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'

// Installed at MODULE SCOPE, not inside getMonaco(): Monaco resolves
// MonacoEnvironment lazily when a language service first needs a worker,
// but nothing guarantees every model/editor creation site awaits
// getMonaco() first (a future direct import of 'monaco-editor' from
// anywhere else would race it). The worker getter has no dependency on
// the loaded monaco module, so there is no reason to defer installing it
// — and a missing environment doesn't throw, it silently degrades to
// no-tokenization, which is the worst possible failure mode to debug
// (#513 "highlighting is blank half the time").
const monacoWindow = window as Window & {
  MonacoEnvironment?: {
    getWorker: (moduleId: string, label: string) => Worker
  }
}
monacoWindow.MonacoEnvironment ??= {
  getWorker(_moduleId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    return new editorWorker()
  },
}

const semanticLegends = new Map<
  string,
  { tokenTypes: string[]; tokenModifiers: string[] }
>()
const registeredLanguages = new Set<string>()
// Guard keyed on the MONACO language id, separate from
// `registeredLanguages` (keyed on the LSP id): 'typescript' and
// 'typescriptreact' both collapse onto Monaco 'typescript', and Monaco
// keeps every registered provider alive globally — a second registration
// for the same Monaco language would double every semantic-tokens
// request.
const registeredMonacoLanguages = new Set<string>()
const pendingSemanticProviders = new Map<string, Promise<void>>()

let monacoPromise: Promise<typeof Monaco> | null = null
let themeListenerInstalled = false
let themesDefined = false

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
  const bg = normalizeMonacoThemeColor(styles.getPropertyValue('--theme-code-bg'), '#12120f')
  const fg = normalizeMonacoThemeColor(styles.getPropertyValue('--theme-code-ink'), '#e8e8e6')
  const muted = normalizeMonacoThemeColor(
    styles.getPropertyValue('--theme-code-ink-dim'),
    '#a8a8a4',
  )
  const border = normalizeMonacoThemeColor(
    styles.getPropertyValue('--theme-code-border'),
    '#262622',
  )
  const accent = normalizeMonacoThemeColor(styles.getPropertyValue('--theme-accent'), '#7dd3a0')
  const selection = normalizeMonacoThemeColor(
    styles.getPropertyValue('--theme-code-selection-bg'),
    normalizeMonacoThemeColorAlpha(accent, '33', '#7dd3a0'),
  )
  const inactiveSelection = normalizeMonacoThemeColor(
    styles.getPropertyValue('--theme-code-selection-inactive-bg'),
    normalizeMonacoThemeColorAlpha(muted, '33', '#5a5a56'),
  )
  const currentLine = normalizeMonacoThemeColor(
    styles.getPropertyValue('--theme-code-current-line-bg'),
    border,
  )

  monaco.editor.defineTheme('agent-code-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
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
    },
  })

  monaco.editor.defineTheme('agent-code-light', {
    // WHY light UI still inherits a dark Monaco token base: code-block slabs
    // intentionally stay dark in light mode so static highlight.js output and
    // embedded Monaco blocks share one visual model. Using Monaco's `vs` base
    // put light-theme token colors on `--theme-code-bg`, which made strings,
    // comments, and identifiers unreadable. The full file editor has its own
    // theme that uses `--theme-canvas`; this runtime is only for dark slabs.
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
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
    base: 'hc-black',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': bg,
      'editor.foreground': fg,
      'editorCursor.foreground': accent,
    },
  })

  // Only assert the slab theme when the editor-canvas theme isn't in
  // charge. defineThemes used to end with an unconditional setTheme,
  // which meant every getMonaco() call (i.e. every CodeBlock mount) and
  // every app-theme change yanked the GLOBAL theme back to the slab
  // palette even while the file editor was open — the "editor randomly
  // flips dark" half of #513. Ownership contract lives in
  // monacoThemeState.ts.
  if (!isEditorThemeActive()) {
    monaco.editor.setTheme(currentThemeName())
  }
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
  // Memory-gauge probe (#375 part A): registered HERE, after the lazy chunk
  // resolved, so the gauges can count live models without ever being able
  // to trigger the Monaco load themselves. See monacoModelProbe.ts for the
  // dependency-direction rationale.
  registerMonacoModelCountProbe(() => monaco.editor.getModels().length)
  // JSX/TSX support for the built-in TypeScript worker. Without `jsx` set,
  // the worker parses `.tsx` model content as plain TS and floods it with
  // syntax errors on the first `<`. `allowNonTsExtensions` lets the worker
  // attach to models whose URIs don't end in .ts/.tsx (transcript snippets
  // use synthetic URIs).
  //
  // Semantic validation is intentionally OFF: the worker sees one file at a
  // time, so every cross-file import resolves to "cannot find module"
  // noise. Real semantic diagnostics come from the typescript-language-
  // server via LspManager (which sees the whole project); the worker keeps
  // only syntax validation, which is reliable single-file.
  const tsDefaults = [
    monaco.languages.typescript.typescriptDefaults,
    monaco.languages.typescript.javascriptDefaults,
  ]
  for (const defaults of tsDefaults) {
    defaults.setCompilerOptions({
      ...defaults.getCompilerOptions(),
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowJs: true,
      allowNonTsExtensions: true,
      target: monaco.languages.typescript.ScriptTarget.ESNext,
    })
    defaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    })
  }
  // Define-once: getMonaco() is called by every CodeBlock mount, and
  // re-deriving all four themes from getComputedStyle on each mount is
  // wasted layout work. Theme *changes* re-derive via the listener.
  if (!themesDefined) {
    themesDefined = true
    defineThemes(monaco)
  }
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
    const monacoId = monacoLanguageId(normalized)
    if (registeredMonacoLanguages.has(monacoId)) return
    registeredMonacoLanguages.add(monacoId)
    // Models are created with the MONACO id (monacoLanguageId, task 1 of
    // #513); registering the provider under the raw LSP id
    // ('typescriptreact') would attach it to a language no model uses.
    // The legend request above still uses `normalized` because tsserver
    // keys its behavior on the LSP id.
    monaco.languages.registerDocumentSemanticTokensProvider(monacoId, {
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
