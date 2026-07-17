import type * as Monaco from 'monaco-editor'

/** Configure the standalone TS worker without taking capabilities away from
 * models that do not have an active project LSP context. Provider defaults are
 * process-global, so disabling them for the file editor also disables them for
 * transcript snippets, oversized files, and every editor whose server failed
 * to start. Monaco's provider ordering already gives our non-builtin LSP
 * provider first refusal and falls through when it has no result. */
export function configureMonacoTypeScriptDefaults(monaco: typeof Monaco): void {
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
}
