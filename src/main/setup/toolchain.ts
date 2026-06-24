import type { SetupToolId } from '@shared/types/setup.js'
import { loadSetupState, updateToolPaths } from '@main/setup/setupState.js'
import { resolveToolPath } from '@main/setup/binaryResolver.js'
import { dirname } from 'path'

type ToolchainPaths = Partial<Record<SetupToolId, string>>

let cachedPaths: ToolchainPaths = {}

// Snapshot of PATH as Electron inherited it from the launching context
// (Finder/Dock when the user double-clicks the .app, the parent shell
// when run from the CLI). We rebuild process.env.PATH from THIS every
// time applyToolEnv() runs — never from the already-mutated PATH —
// because otherwise revalidation can't actually evict a stale tool dir
// once we've prepended it. We capture eagerly at module load before
// anything else mutates it.
const originalPath = process.env.PATH ?? ''

export async function initializeToolchain(): Promise<void> {
  // Fast path: load whatever the setup gate persisted so the rest of
  // app startup (SessionManager, IPC, etc.) sees a reasonable PATH
  // immediately. This is the common case — the user already went
  // through setup, the cached binaries still exist, nothing changed.
  await refreshToolchainFromState()

  // Slow path, in the background: re-run `command -v` for each tool
  // that the user has previously resolved, and update the cache if a
  // binary moved or got shadowed by a new install on PATH (e.g. the
  // canonical pain case — two `codex` installs at different versions,
  // setup.json froze the older one, and every session launches the
  // stale binary which then nags about updates). We deliberately do
  // not wait for this; if revalidation surfaces a change after the
  // user has already started a session, the next session picks it up.
  void revalidateToolchain().catch(err => {
    console.warn('[toolchain] revalidation failed:', err)
  })
}

export async function refreshToolchainFromState(): Promise<void> {
  const state = await loadSetupState()
  cachedPaths = { ...state.toolPaths }
  applyToolEnv()
}

/**
 * Re-resolve every tool that's currently cached and persist any
 * change. Only acts on tools the user has previously resolved — we
 * never invent new entries here (that's the setup gate's job).
 *
 * If `command -v` returns nothing for a tool that used to resolve, we
 * leave the cache alone: the binary may be temporarily unavailable
 * (PATH glitch, shell init error) and clobbering a working path with
 * `null` would force the user back through the setup gate for no
 * reason. The setup gate will catch a genuinely missing tool the next
 * time it runs.
 */
export async function revalidateToolchain(): Promise<void> {
  const previous = { ...cachedPaths }
  const tools = Object.keys(previous) as SetupToolId[]
  if (tools.length === 0) return

  const updates: Partial<Record<SetupToolId, string | null>> = {}
  await Promise.all(
    tools.map(async tool => {
      try {
        const resolved = await resolveToolPath(tool)
        if (resolved && resolved !== previous[tool]) {
          updates[tool] = resolved
        }
      } catch {
        // swallow — see docstring
      }
    }),
  )

  if (Object.keys(updates).length === 0) return

  await updateToolPaths(updates)
  await refreshToolchainFromState()

  for (const [tool, next] of Object.entries(updates) as Array<[SetupToolId, string]>) {
    console.info(
      `[toolchain] revalidated ${tool}: ${previous[tool] ?? '(none)'} -> ${next}`,
    )
  }
}

function applyToolEnv(): void {
  const pathParts = [
    ...Object.values(cachedPaths)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map(path => dirname(path)),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...originalPath.split(':'),
  ]
  const seen = new Set<string>()
  process.env.PATH = pathParts
    .filter(part => {
      if (!part || seen.has(part)) return false
      seen.add(part)
      return true
    })
    .join(':')

  if (cachedPaths.mitmdump) {
    // CLAUDE_HEADLESS_MITMDUMP is the primary override consumed by the proxy
    // resolver. Keep the old CC_PROXY_TEST_MITMDUMP alias in sync during the
    // deprecation window because the headless package still accepts it, but do
    // not let setup be the producer that keeps the legacy name alive forever.
    process.env.CLAUDE_HEADLESS_MITMDUMP = cachedPaths.mitmdump
    process.env.CC_PROXY_TEST_MITMDUMP = cachedPaths.mitmdump
  } else {
    delete process.env.CLAUDE_HEADLESS_MITMDUMP
    delete process.env.CC_PROXY_TEST_MITMDUMP
  }
}

export function getToolPath(tool: SetupToolId, fallback: string): string {
  return cachedPaths[tool] ?? fallback
}
