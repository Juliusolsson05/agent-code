import { beforeEach, describe, expect, it, vi } from 'vitest'

// Bundled-runtime precedence for getToolPath (#994).
//
// The bundled opencode binary must win over setup-cached/PATH lookups at
// every spawn site (transcriptEngine passes getToolPath('opencode','opencode')
// straight into execFile), EXCEPT a valid manual override — the user's
// explicit word beats every probe, the same policy prerequisites.ts applies
// at the gate. These tests pin that contract at the toolchain seam.

vi.mock('@main/setup/setupState.js', () => ({
  loadSetupState: vi.fn(),
  updateToolPaths: vi.fn(),
}))

// isExecutable is answered by path prefix so the tests never touch the real
// filesystem; resolveToolPath belongs to revalidation, which these tests do
// not exercise.
vi.mock('@main/setup/binaryResolver.js', () => ({
  isExecutable: vi.fn((path: string) => Promise.resolve(path.startsWith('/live/'))),
  resolveToolPath: vi.fn(async () => null),
}))

vi.mock('@main/setup/runtimeTools.js', () => ({
  resolveBundledTool: vi.fn(async () => null),
}))

const { loadSetupState } = await import('@main/setup/setupState.js')
const { isExecutable } = await import('@main/setup/binaryResolver.js')
const { resolveBundledTool } = await import('@main/setup/runtimeTools.js')
const { getToolPath, refreshToolchainFromState } = await import('@main/setup/toolchain.js')

const BUNDLED = '/Applications/Agent Code.app/Contents/Resources/app.asar.unpacked/out/main/runtime/opencode/darwin-arm64/opencode'

/** Minimal PersistedSetupState fixture; fields toolchain never reads are
 *  still required by the type so the mock stays honest against the real
 *  loader's contract. */
function setupState(overrides: {
  toolPaths?: Record<string, string>
  manualToolPaths?: Record<string, string>
} = {}) {
  return {
    version: 1 as const,
    toolPaths: overrides.toolPaths ?? {},
    manualToolPaths: overrides.manualToolPaths ?? {},
    skippedOptionalTools: {},
    cliUpdateBehavior: 'automatic' as const,
    cliUpdateCache: {},
    updatedAt: 0,
  }
}

beforeEach(() => {
  // Call history, not implementations: a "not called" assertion in one test
  // must not see the previous test's legitimate calls.
  vi.clearAllMocks()
  vi.mocked(loadSetupState).mockResolvedValue(setupState())
  vi.mocked(resolveBundledTool).mockResolvedValue(null)
})

describe('bundled runtime precedence in getToolPath', () => {
  it('returns the bundled binary over a setup-cached PATH path', async () => {
    vi.mocked(loadSetupState).mockResolvedValue(
      setupState({ toolPaths: { opencode: '/usr/local/bin/opencode' } }),
    )
    vi.mocked(resolveBundledTool).mockResolvedValue(BUNDLED)

    await refreshToolchainFromState()

    expect(getToolPath('opencode', 'opencode')).toBe(BUNDLED)
  })

  it('lets a valid manual override beat the bundled binary', async () => {
    // The user deliberately pointed us at their own build; shipping ours
    // anyway would silently discard their choice — the exact failure the
    // override-first policy in prerequisites.ts exists to prevent.
    const manual = '/live/opencode-custom'
    vi.mocked(loadSetupState).mockResolvedValue(
      // The gate writes the winning path back to toolPaths, so a manual
      // override arrives here as both entries — this mirrors persisted
      // reality rather than an impossible state.
      setupState({
        toolPaths: { opencode: manual },
        manualToolPaths: { opencode: manual },
      }),
    )
    vi.mocked(resolveBundledTool).mockResolvedValue(BUNDLED)

    await refreshToolchainFromState()

    expect(getToolPath('opencode', 'opencode')).toBe(manual)
    // Not merely outranked — not consulted. Resolving the bundled binary
    // spawns a version probe; skipping it when the override wins is the
    // point of checking the override first.
    expect(resolveBundledTool).not.toHaveBeenCalled()
  })

  it('falls back to the bundled binary when a manual override is dead', async () => {
    vi.mocked(loadSetupState).mockResolvedValue(
      setupState({ manualToolPaths: { opencode: '/gone/opencode' } }),
    )
    vi.mocked(resolveBundledTool).mockResolvedValue(BUNDLED)

    await refreshToolchainFromState()

    expect(isExecutable).toHaveBeenCalledWith('/gone/opencode')
    expect(getToolPath('opencode', 'opencode')).toBe(BUNDLED)
  })

  it('keeps today cached-path/fallback behavior when nothing is bundled', async () => {
    vi.mocked(loadSetupState).mockResolvedValue(
      setupState({ toolPaths: { opencode: '/usr/local/bin/opencode' } }),
    )
    vi.mocked(resolveBundledTool).mockResolvedValue(null)

    await refreshToolchainFromState()

    expect(getToolPath('opencode', 'opencode')).toBe('/usr/local/bin/opencode')
    expect(getToolPath('codex', 'codex')).toBe('codex')
  })
})
