import type { SetupToolId } from '@shared/types/setup.js'
import { loadSetupState, updateToolPaths } from '@main/setup/setupState.js'
import { isExecutable, resolveToolPath } from '@main/setup/binaryResolver.js'
import { resolveBundledTool } from '@main/setup/runtimeTools.js'
import { dirname } from 'path'

type ToolchainPaths = Partial<Record<SetupToolId, string>>

let cachedPaths: ToolchainPaths = {}

// Bundled-runtime overrides, keyed by SetupToolId (#994). Populated by
// refreshToolchainFromState so that every getToolPath consumer — the four
// transcriptEngine opencode call sites, version probes, anything added
// later — gets bundled-over-PATH precedence from one place instead of each
// call site re-implementing "bundled first" against an async resolver.
//
// WHY this lives in toolchain and not in each caller: getToolPath is the
// single synchronous choke point every spawn already goes through. The
// runtimeTools module documents the resolution ladder as "callers implement
// steps 1,3,4,5; this module owns step 2" — for the provider CLIs,
// toolchain IS that caller, once, on behalf of all of them.
//
// WHY a VALID MANUAL OVERRIDE still wins over the bundle: the user's
// explicit word beats every probe (the same policy checkPrerequisites
// applies — a user deliberately pointing at ~/bin/opencode-custom must not
// have it silently replaced by ours). A dead override (file gone or lost
// +x) falls through to the bundle exactly like it falls through to the
// auto layers at the gate.
//
// Kept out of cachedPaths deliberately: cachedPaths is persisted setup
// truth (what the gate probed and wrote back), revalidation rewrites it
// from PATH discoveries, and applyToolEnv derives child-process PATH from
// it. Mixing the bundle into that would give revalidation the power to
// clobber our shipped binary with a stale PATH find, and would prepend the
// asar-unpacked dir to every child's PATH for no reason — the bundle is
// used by absolute path, never discovered via PATH.
const bundledOverrides: ToolchainPaths = {}

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
  await refreshBundledOverrides(state)
  applyToolEnv()
}

/**
 * Re-resolve the bundled-runtime override layer (see bundledOverrides).
 *
 * opencode is the only bundled provider CLI today; the map shape leaves
 * room for more without touching getToolPath again. resolveBundledTool is
 * cheap after the first success (file checks + one cached `--version`
 * probe spawn) but NOT free, which is why it runs on refresh — boot fast
 * path, setup-gate completion — rather than on every getToolPath call.
 *
 * In dev builds that never staged out/main/runtime/opencode, the resolver
 * returns null and behavior is exactly today's cached/PATH lookup; the
 * override layer only exists on machines whose build actually shipped the
 * binary.
 */
async function refreshBundledOverrides(state: Awaited<ReturnType<typeof loadSetupState>>): Promise<void> {
  const manual = state.manualToolPaths.opencode
  if (manual && (await isExecutable(manual))) {
    delete bundledOverrides.opencode
    return
  }
  bundledOverrides.opencode = (await resolveBundledTool('opencode')) ?? undefined
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
 *
 * Tools with a still-valid manual override are skipped entirely.
 * Revalidation runs on every app launch, so without this skip a user's
 * deliberate setup:set-tool-path choice would survive exactly one
 * session and then get silently replaced by whatever `command -v`
 * prefers (codex review of #504). The override only loses its veto when
 * its file is gone or no longer an executable regular file — then the
 * auto layers take over, same precedence as checkPrerequisites (see the
 * precedence comment in prerequisites.ts).
 */
export async function revalidateToolchain(): Promise<void> {
  const previous = { ...cachedPaths }
  const tools = Object.keys(previous) as SetupToolId[]
  if (tools.length === 0) return

  const { manualToolPaths } = await loadSetupState()
  const updates: Partial<Record<SetupToolId, string | null>> = {}
  await Promise.all(
    tools.map(async tool => {
      try {
        const manual = manualToolPaths[tool]
        if (manual && (await isExecutable(manual))) return
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
  // Bundled layer first (when populated — see bundledOverrides), then the
  // gate's persisted probe result, then the caller's fallback. This is the
  // sync half of the bundled-over-PATH precedence (#994).
  return bundledOverrides[tool] ?? cachedPaths[tool] ?? fallback
}
