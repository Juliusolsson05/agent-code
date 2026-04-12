// Shared code-language helpers for renderer and main.
//
// Why this lives under src/core instead of renderer-only:
// Monaco needs a language id for tokenization, and the LSP broker needs
// to decide whether a snippet is worth sending to a language server.
// Keeping the normalization rules in one place prevents "Monaco thinks
// this is javascriptreact, LSP thinks it's plaintext" drift.

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cjs: 'javascript',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  md: 'markdown',
  mts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescriptreact',
  txt: 'plaintext',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

export function inferLanguageFromPath(filePath?: string | null): string | null {
  if (!filePath) return null
  const normalized = filePath.split(/[?#]/, 1)[0] ?? filePath
  const parts = normalized.split('.')
  if (parts.length < 2) return null
  const ext = parts[parts.length - 1]?.toLowerCase()
  if (!ext) return null
  return EXTENSION_TO_LANGUAGE[ext] ?? null
}

export function normalizeCodeLanguage(
  language?: string | null,
  filePath?: string | null,
): string {
  const direct = language?.toLowerCase().trim()
  if (direct) {
    if (direct === 'js') return 'javascript'
    if (direct === 'ts') return 'typescript'
    if (direct === 'jsx') return 'javascriptreact'
    if (direct === 'tsx') return 'typescriptreact'
    if (direct === 'shell' || direct === 'bash' || direct === 'zsh') {
      return 'shell'
    }
    if (direct === 'text') return 'plaintext'
    return direct
  }
  return inferLanguageFromPath(filePath) ?? 'plaintext'
}

export function supportsLsp(language: string): boolean {
  return (
    language === 'javascript' ||
    language === 'javascriptreact' ||
    language === 'typescript' ||
    language === 'typescriptreact'
  )
}

export function languageFileExtension(language: string): string {
  if (language === 'javascript') return 'js'
  if (language === 'javascriptreact') return 'jsx'
  if (language === 'typescript') return 'ts'
  if (language === 'typescriptreact') return 'tsx'
  if (language === 'json') return 'json'
  if (language === 'python') return 'py'
  if (language === 'rust') return 'rs'
  if (language === 'shell') return 'sh'
  return 'txt'
}
