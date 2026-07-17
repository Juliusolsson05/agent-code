// Shared code-language helpers for renderer and main.
//
// Why this lives under src/core instead of renderer-only:
// Monaco needs a language id for tokenization, and the LSP broker needs
// to decide whether a snippet is worth sending to a language server.
// Keeping the normalization rules in one place prevents "Monaco thinks
// this is javascriptreact, LSP thinks it's plaintext" drift.

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  bash: 'shell',
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  diff: 'diff',
  env: 'shell',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'javascriptreact',
  lock: 'plaintext',
  log: 'plaintext',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mk: 'makefile',
  mts: 'typescript',
  nix: 'nix',
  patch: 'diff',
  php: 'php',
  pl: 'perl',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescriptreact',
  txt: 'plaintext',
  vue: 'html',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
}

function inferLanguageFromShebang(content?: string | null): string | null {
  // UTF-8 BOM is file metadata preserved for round-trip fidelity. It is not
  // part of the executable shebang and must not make an otherwise ordinary
  // extensionless script fall back to plaintext.
  const source = content?.startsWith('\ufeff') ? content.slice(1) : content
  if (!source?.startsWith('#!')) return null
  const shebang = source.slice(0, source.indexOf('\n') === -1 ? 256 : source.indexOf('\n'))
  // WHY match executable tokens instead of the whole line: portable scripts
  // commonly use `/usr/bin/env`, sometimes with `-S` and extra flags. The
  // interpreter is still authoritative, but its position is not. Word
  // boundaries also keep `node` from accidentally matching an unrelated path.
  if (/\b(?:python|python\d+(?:\.\d+)?)\b/i.test(shebang)) return 'python'
  if (/\b(?:node|deno|bun)\b/i.test(shebang)) return 'javascript'
  if (/\b(?:bash|zsh|dash|ksh|sh)\b/i.test(shebang)) return 'shell'
  if (/\bruby\b/i.test(shebang)) return 'ruby'
  if (/\bperl\b/i.test(shebang)) return 'perl'
  if (/\bphp\b/i.test(shebang)) return 'php'
  return null
}

export function inferLanguageFromPath(
  filePath?: string | null,
  content?: string | null,
): string | null {
  if (!filePath) return inferLanguageFromShebang(content)
  const normalized = filePath.split(/[?#]/, 1)[0] ?? filePath
  const basename = normalized.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  // WHY basenames precede extension parsing: these conventional files have
  // language semantics despite having no suffix. Treating them as plaintext
  // disabled both Monaco behavior and the LSP without any visible explanation.
  if (basename === 'makefile' || basename === 'gnumakefile') return 'makefile'
  if (basename === 'dockerfile' || basename === 'containerfile') return 'dockerfile'
  if (basename === '.bashrc' || basename === '.zshrc' || basename === '.profile') return 'shell'
  const parts = normalized.split('.')
  if (parts.length < 2) return inferLanguageFromShebang(content)
  const ext = parts[parts.length - 1]?.toLowerCase()
  if (!ext) return inferLanguageFromShebang(content)
  return EXTENSION_TO_LANGUAGE[ext] ?? inferLanguageFromShebang(content)
}

export function normalizeCodeLanguage(
  language?: string | null,
  filePath?: string | null,
  content?: string | null,
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
  return inferLanguageFromPath(filePath, content) ?? 'plaintext'
}

// Languages the LSP layer will ATTEMPT to serve. This is the renderer-
// visible candidate list, deliberately optimistic: actual availability is
// decided in main by serverRegistry.resolveCommand() (PATH detection).
// The renderer fails open — a candidate language with no installed server
// just gets no legend/diagnostics, identical to before multi-language
// support existed. tsserver ships as an npm dependency, so the TS family
// is always real; the rest require the user to have the server installed
// (pyright-langserver / rust-analyzer / gopls on PATH).
export const LSP_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'python',
  'rust',
  'go',
])

export function supportsLsp(language: string): boolean {
  return LSP_LANGUAGES.has(language)
}

// Transcript blocks are snippets, not real project documents. Starting
// pyright/rust-analyzer/gopls for every rendered answer can index an entire
// repository just to color a read-only excerpt; only the bundled TS server is
// predictable and lightweight enough for this enhancement surface.
export function supportsTranscriptLsp(language: string): boolean {
  return (
    language === 'javascript' ||
    language === 'javascriptreact' ||
    language === 'typescript' ||
    language === 'typescriptreact'
  )
}

// Monaco does not ship `typescriptreact` / `javascriptreact` languages —
// those are VS Code language IDs. Monaco's own `typescript` / `javascript`
// tokenizers handle JSX/TSX syntax natively. Creating a model with an
// unregistered language ID silently selects the *plaintext* tokenizer,
// which is exactly the "highlighting is completely blank for .tsx files"
// bug (#513). Everything that talks TO MONACO (createModel, provider
// registration) must translate through this; everything that talks to the
// LSP keeps the react-variant IDs because tsserver distinguishes them
// (languageId drives JSX parsing on the server side).
export function monacoLanguageId(language: string): string {
  if (language === 'typescriptreact') return 'typescript'
  if (language === 'javascriptreact') return 'javascript'
  return language
}

export function languageFileExtension(language: string): string {
  if (language === 'javascript') return 'js'
  if (language === 'javascriptreact') return 'jsx'
  if (language === 'typescript') return 'ts'
  if (language === 'typescriptreact') return 'tsx'
  if (language === 'json') return 'json'
  if (language === 'python') return 'py'
  if (language === 'rust') return 'rs'
  if (language === 'go') return 'go'
  if (language === 'shell') return 'sh'
  return 'txt'
}
