import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// This is intentionally a test, not another production dependency. Resolve the
// actual TypeScript graph so barrels, aliases, .js-to-.ts resolution, and type
// imports cannot turn the approved isolation boundary into naming convention.
const root = resolve(import.meta.dirname, '../..')
const config = ts.readConfigFile(resolve(root, 'tsconfig.node.json'), ts.sys.readFile)
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
const sdk = 'src/control-sdk/'
const mcp = 'src/main/externalControlMcp/'
const hostConsumers = new Set([
  'src/main/control/createControlHost.ts',
  'src/renderer/src/control/registerRendererHost.ts',
])

function specifiers(source: string): Array<string | null> {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports: Array<string | null> = []
  const add = (node: ts.Node | undefined) => imports.push(node && ts.isStringLiteralLike(node) ? node.text : null)
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier)
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return imports
}

function violation(from: string, target: string | undefined, specifier: string | null): string | undefined {
  const integration = /\/control(?:\.ts|\/)/.test(from)
  if (specifier === null) {
    return from.startsWith(sdk) || from.startsWith(mcp) || integration ? 'computed import hides control dependency' : undefined
  }
  if (from.startsWith(sdk) && !target?.startsWith(sdk) && !/^zod(?:\/|$)/.test(specifier)) {
    return 'neutral SDK may depend only on itself and schema contracts'
  }
  if (target?.startsWith(sdk) && !from.startsWith(sdk)) {
    if (target === `${sdk}host.ts` && hostConsumers.has(from)) return
    if (target !== `${sdk}index.ts`) return 'consume the explicit SDK entry point, not private modules'
  }
  if (from.startsWith(mcp) && target?.startsWith('src/') && !target.startsWith(mcp) && target !== `${sdk}index.ts`) {
    return 'MCP must invoke the SDK, not application implementation'
  }
  if (integration && (specifier.startsWith('@modelcontextprotocol/') || target?.startsWith('src/mcp/') || target?.startsWith(mcp))) {
    return 'feature control integration must not depend on MCP'
  }
  if (target?.startsWith(mcp) && !from.startsWith(mcp) && from !== 'src/main/index.ts') {
    return 'only app composition may install the external MCP adapter'
  }
  if (integration && from.startsWith('src/renderer/') && target?.startsWith('src/main/')) return 'renderer capability cannot import main'
  if (integration && from.startsWith('src/main/') && target?.startsWith('src/renderer/')) return 'main capability cannot import renderer'
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.[cm]?tsx?$/.test(path) && !/\.test\.[cm]?tsx?$/.test(path) ? [path] : []
  })
}

describe('control SDK dependency boundary', () => {
  it('finds type, re-export, side-effect, dynamic, and CommonJS imports without matching comments', () => {
    expect(specifiers(`
      // import 'not-real'
      import type { A } from './a'
      export { b } from './b'
      export * from './c'
      import './d'
      type E = import('./e').E
      const f = import('./f')
      import G = require('./g')
      const h = require('./h')
      import(variable)
    `)).toEqual(['./a', './b', './c', './d', './e', './f', './g', './h', null])
  })

  it('blocks realistic coupling attempts including type-only and relative private imports', () => {
    expect(violation(`${sdk}core/example.ts`, 'src/main/sessionManager.ts', '@main/sessionManager')).toBeTruthy()
    expect(violation('src/renderer/src/features/example/control.ts', `${sdk}core/registry.ts`, '../../../../../control-sdk/core/registry')).toBeTruthy()
    expect(violation(`${mcp}tools.ts`, 'src/renderer/src/workspace/store.ts', '@renderer/workspace/store')).toBeTruthy()
    expect(violation('src/renderer/src/features/example/control.ts', undefined, '@modelcontextprotocol/sdk')).toBeTruthy()
    expect(violation('src/renderer/src/features/example/control.ts', `${sdk}index.ts`, '@control-sdk')).toBeUndefined()
  })

  it('keeps the shipped source graph inside the approved boundary', () => {
    const failures: string[] = []
    for (const file of sourceFiles(resolve(root, 'src'))) {
      const from = relative(root, file)
      for (const specifier of specifiers(readFileSync(file, 'utf8'))) {
        const resolved = specifier === null ? undefined : ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
        const target = resolved ? relative(root, resolved) : undefined
        const reason = violation(from, target, specifier)
        if (reason) failures.push(`${from}: ${specifier} → ${target ?? 'external/unresolved'}: ${reason}`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
