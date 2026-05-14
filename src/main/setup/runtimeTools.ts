// Runtime-tools resolver — the single place in main that knows how to
// find bundled third-party executables we ship with packaged Agent
// Code. Currently scaffolded for two tools, both pending implementation
// in follow-up PRs:
//
//   - 'mitmdump' (from mitmproxy) — Claude proxy streaming, issue #119
//   - 'tmux'                       — terminal pane persistence,   issue #120
//
// WHY this module exists:
//   We need exactly one source of truth for "where does the bundled
//   helper live on this platform?", and it must NOT leak Electron app
//   paths (process.resourcesPath, app.asar.unpacked, app.getPath
//   ('userData')) into reusable packages like claude-code-headless or
//   the TmuxRegistry. Those packages just receive a resolved
//   `mitmDumpPath` / `tmuxBinary` string. The Electron-aware resolution
//   logic stays here.
//
// API contract (locked in PR 1 so PR 2 / PR 3 do not bikeshed it):
//
//   resolveBundledTool(tool: BundledToolId): Promise<string | null>
//
//     Returns an absolute filesystem path to the executable to spawn,
//     or null when no bundled artifact is available for the current
//     platform/arch. Callers must fall back to setup-cached / PATH
//     lookup in that case.
//
//   getPlatformKey(): string | null
//
//     Returns the manifest platform key for the current process, e.g.
//     'darwin-arm64'. Used here AND by scripts/runtime-tools/* so the
//     lookup convention has exactly one source of truth.
//
// Resolution order for any caller using a bundled tool (callers
// implement steps 1, 3, 4, 5 themselves; this module owns step 2):
//
//   1. caller-provided env override (tool-specific, e.g. CLAUDE_HEADLESS_MITMDUMP)
//   2. bundled runtime artifact (this module)
//   3. setup-cached path (@main/setup/toolchain.getToolPath)
//   4. PATH lookup
//   5. typed error with diagnostics
//
// PR 1 (this commit): resolveBundledTool always returns null. The API
// is final; the wiring is intentionally deferred to keep this PR a
// pure-scaffolding change with no observable behaviour difference.
//
// PR 2 (issue #119): implements mitmdump extraction from
// `process.resourcesPath/.../runtime/mitmproxy/<platform>/mitmproxy.tar.gz`
// into `app.getPath('userData')/runtime/mitmproxy-<ver>/`, marker file,
// idempotent first-run install.
//
// PR 3 (issue #120): implements tmux as a single static binary
// copied (not extracted) from
// `process.resourcesPath/.../runtime/tmux/<platform>/tmux` into
// `app.getPath('userData')/runtime/tmux-<ver>/tmux`, chmod +x.

export type BundledToolId = 'mitmdump' | 'tmux'

/**
 * Platform key used in manifests under `third_party/<tool>/manifest.json`
 * and in packaged-resource layout under
 * `out/main/runtime/<tool>/<platform-key>/`.
 *
 * The mapping is intentional. Node's `process.arch` reports `x64` but
 * the upstream mitmproxy archive filenames use `x86_64`, and the
 * manifest's `urlTemplate` follows upstream so URL substitution works
 * directly. The map lives ONLY here so the convention has one source
 * of truth shared between renderer-free main code and the
 * `scripts/runtime-tools/*` Node scripts.
 *
 * Returns null on unsupported platforms (anything that isn't
 * macOS + arm64/x86_64 today) so callers fall back to setup-cached
 * / PATH lookup. Linux and Windows support will extend this map when
 * those platforms are in scope.
 */
export function getPlatformKey(): string | null {
  const arch =
    process.arch === 'x64'
      ? 'x86_64'
      : process.arch === 'arm64'
        ? 'arm64'
        : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  return null
}

/**
 * Resolve the absolute path to a bundled runtime tool, if one exists
 * for the current platform/arch.
 *
 * PR 1 scaffolding: always returns null. PR 2 wires mitmdump
 * extraction; PR 3 wires tmux. The signature is fixed so downstream
 * call-sites (ClaudeSession proxy startup, TmuxRegistry, setup gate)
 * can already import this module against its final shape.
 */
export async function resolveBundledTool(_tool: BundledToolId): Promise<string | null> {
  // Intentional stub. See module header for the PR 2 / PR 3 plan.
  return null
}

/**
 * True when a bundled artifact exists on disk for the current
 * platform/arch. Setup-gate UI uses this in PR 2/PR 3 to decide
 * whether to hide the "install via Homebrew" prompt for a given tool.
 *
 * Stubbed in PR 1 alongside resolveBundledTool.
 */
export async function isBundledToolAvailable(tool: BundledToolId): Promise<boolean> {
  return (await resolveBundledTool(tool)) !== null
}
