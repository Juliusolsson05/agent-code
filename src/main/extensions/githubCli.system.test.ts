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
})
