// LSP IPC payload contracts.
//
// WHY shared: `LspManager` (main) produces diagnostics + the semantic-token
// legend, preload bridges them, and Monaco-backed code blocks in the renderer
// consume them. The shapes were declared twice (main `lspManager.ts` and
// preload `api/types.ts`); a severity-union or field change on one side could
// silently diverge. One definition closes that gap.
//
// INVARIANT: the severity union stays exactly 'error' | 'warning' | 'info' |
// 'hint' — Monaco maps each to a marker severity. Adding a value here without
// updating the renderer's marker mapping would render an unknown severity.

export type LspDiagnostic = {
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
}

export type LspDiagnosticsEvent = {
  clientUri: string
  diagnostics: LspDiagnostic[]
}

/** Token type/modifier legend returned by `lsp:ensure-legend`; the renderer
 *  needs it to decode the flat semantic-tokens int array Monaco receives. */
export type LspSemanticLegend = {
  tokenTypes: string[]
  tokenModifiers: string[]
}
