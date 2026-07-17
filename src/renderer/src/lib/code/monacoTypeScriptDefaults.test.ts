import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'

import { configureMonacoTypeScriptDefaults } from './monacoTypeScriptDefaults'

describe('configureMonacoTypeScriptDefaults', () => {
  it('keeps built-in intelligence enabled for models without an LSP context', () => {
    const createDefaults = () => ({
      getCompilerOptions: vi.fn(() => ({ strict: true })),
      setCompilerOptions: vi.fn(),
      setDiagnosticsOptions: vi.fn(),
      setModeConfiguration: vi.fn(),
    })
    const typescriptDefaults = createDefaults()
    const javascriptDefaults = createDefaults()
    const monaco = {
      languages: {
        typescript: {
          typescriptDefaults,
          javascriptDefaults,
          JsxEmit: { ReactJSX: 4 },
          ScriptTarget: { ESNext: 99 },
        },
      },
    } as unknown as typeof Monaco

    configureMonacoTypeScriptDefaults(monaco)

    for (const defaults of [typescriptDefaults, javascriptDefaults]) {
      expect(defaults.setCompilerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          strict: true,
          allowJs: true,
          allowNonTsExtensions: true,
        }),
      )
      expect(defaults.setDiagnosticsOptions).toHaveBeenCalledWith({
        noSemanticValidation: true,
        noSyntaxValidation: false,
      })
      // The regression disabled completion/hover/navigation here globally.
      // Not calling this setter is the invariant: LSP must remain additive.
      expect(defaults.setModeConfiguration).not.toHaveBeenCalled()
    }
  })
})
