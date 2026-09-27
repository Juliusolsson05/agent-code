import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GH_TOKEN_TIMEOUT_MS, resolveGitHubCliToken } from '@main/extensions/githubCli.js'

// SYSTEM tier on purpose: this file runs the REAL default execFile — an actual
// `gh` spawn on the machine — instead of the injected fake the unit suite
// uses. The unit suite proves the failure logic; this proves the production
// runner itself honors the contract the logic depends on.
//
// The assertion is deliberately two-valued (token or null) because the
// machine's gh state is not ours to control: CI has no gh, a developer box
// has an authenticated one. Both are correct answers; what must NEVER happen
// is a throw, a hang, or a non-token string.

describe('resolveGitHubCliToken against the real gh binary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves to a plausible token or null — never throws, never hangs', async () => {
    // "Never hangs" is the production timeout's job (GH_TOKEN_TIMEOUT_MS) and
    // this test's own 20 s limit catches a real hang. A wall-clock assertion
    // of "timeout + 2 s" measured the machine's load instead (#1296): a busy
    // runner can take longer to launch `gh` without anything being wrong.
    expect(GH_TOKEN_TIMEOUT_MS).toBeLessThan(20_000)
    const token = await resolveGitHubCliToken()

    if (token !== null) {
      expect(token).toBeTruthy()
      // The shape guards from the unit suite, verified against reality: one
      // line, sane length, no whitespace or control characters smuggled in.
      expect(token.length).toBeLessThanOrEqual(4096)
      expect(token).toMatch(/^\S+$/)
    }
  }, 20_000)

  // WHY a shim beside the real-gh case (review of #1353): the case above
  // accepts null, and null is also what a runner that never spawns anything
  // returns — a mutant that replaced the spawn with an error passed it on a
  // machine with an authenticated gh. A `gh` of our own, first on PATH, makes
  // the production runner's answer knowable: it must actually run `gh auth
  // token` and hand back that stdout. The shim prints a fixture string, so no
  // real credential is read.
  it.skipIf(process.platform === 'win32')('runs the gh first on PATH and returns what it printed', async () => {
    const bin = await mkdtemp(join(tmpdir(), 'agent-code-gh-shim-'))
    const originalPath = process.env.PATH
    try {
      await writeFile(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "auth token" ] || exit 3\necho gho_fixture_not_a_real_token\n')
      await chmod(join(bin, 'gh'), 0o755)
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`
      await expect(resolveGitHubCliToken()).resolves.toBe('gho_fixture_not_a_real_token')
    } finally {
      process.env.PATH = originalPath
      await rm(bin, { recursive: true, force: true })
    }
  }, 20_000)
})
