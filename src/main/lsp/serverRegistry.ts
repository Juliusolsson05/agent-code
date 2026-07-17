import { access, constants } from 'fs/promises'
import { createRequire } from 'module'
import { delimiter, join } from 'path'

const require = createRequire(import.meta.url)

// Pluggable language-server registry.
//
// WHY a registry instead of the previous hardcoded tsserver spawn in
// LspManager: #513 scopes the editor at "TS fully wired, other languages
// plug-and-play". The pieces that vary per language are exactly (a) which
// languageIds a server owns and (b) how to spawn it; everything else
// (jsonrpc plumbing, doc sync, request fan-out) is language-agnostic and
// stays in LspManager. Adding a language should be one entry here, not a
// manager change.
//
// WHY no bundled binaries: repo policy (CLAUDE.md third_party/) — binaries
// are never committed, and bundling via manifest is a separate follow-up
// per the #119/#120 pattern. tsserver is the exception because it is a
// plain npm dependency (JS, not a binary), spawned through the Electron
// binary with ELECTRON_RUN_AS_NODE.

export type LspResolvedCommand = {
  command: string
  args: string[]
  env?: Record<string, string>
}

export type LspServerSpec = {
  id: string
  displayName: string
  /** LSP languageIds this server owns. First matching spec wins. */
  languages: string[]
  /** Resolve to a spawnable command, or null when the server is not
   *  installed. Resolution is re-run per LspManager server creation (not
   *  cached here) so a user can install pyright and get LSP on the next
   *  workspace open without restarting the app. */
  resolveCommand: () => Promise<LspResolvedCommand | null>
}

// PATH probe. WHY not `which`/`command -v` via shell: spawning a shell to
// find a binary we're about to spawn anyway doubles the process cost and
// inherits shell-profile weirdness; a direct X_OK scan over PATH entries
// is exact and portable enough. (win32 would need PATHEXT handling — the
// non-TS servers are best-effort and this app is macOS-first; revisit if
// packaged for Windows.)
async function findOnPath(binary: string): Promise<string | null> {
  const pathVar = process.env.PATH ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, binary)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep scanning
    }
  }
  return null
}

function pathDetectedServer(
  binary: string,
  args: string[],
): () => Promise<LspResolvedCommand | null> {
  return async () => {
    const resolved = await findOnPath(binary)
    return resolved ? { command: resolved, args } : null
  }
}

export const LSP_SERVER_SPECS: LspServerSpec[] = [
  {
    id: 'typescript',
    displayName: 'TypeScript (typescript-language-server)',
    languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
    // Bundled npm dependency — always available. In packaged Electron,
    // process.execPath is the app executable; ELECTRON_RUN_AS_NODE makes
    // it behave as plain Node so the CLI runs instead of re-launching
    // Agent Code (same trick the pre-registry LspManager used).
    resolveCommand: async () => ({
      command: process.execPath,
      args: [require.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'],
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    }),
  },
  {
    id: 'pyright',
    displayName: 'Python (pyright-langserver)',
    languages: ['python'],
    resolveCommand: pathDetectedServer('pyright-langserver', ['--stdio']),
  },
  {
    id: 'rust-analyzer',
    displayName: 'Rust (rust-analyzer)',
    languages: ['rust'],
    resolveCommand: pathDetectedServer('rust-analyzer', []),
  },
  {
    id: 'gopls',
    displayName: 'Go (gopls)',
    languages: ['go'],
    resolveCommand: pathDetectedServer('gopls', []),
  },
]

export function lspServerForLanguage(language: string): LspServerSpec | null {
  return LSP_SERVER_SPECS.find(spec => spec.languages.includes(language)) ?? null
}
