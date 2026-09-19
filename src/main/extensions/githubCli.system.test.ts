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
    const startedAt = Date.now()
    const token = await resolveGitHubCliToken()
    const elapsed = Date.now() - startedAt

    // Bound includes slack for a cold binary launch; the timeout itself is
    // GH_TOKEN_TIMEOUT_MS, and the promise must settle well inside it.
    expect(elapsed).toBeLessThan(GH_TOKEN_TIMEOUT_MS + 2_000)

    if (token !== null) {
      expect(token).toBeTruthy()
      // The shape guards from the unit suite, verified against reality: one
      // line, sane length, no whitespace or control characters smuggled in.
      expect(token.length).toBeLessThanOrEqual(4096)
      expect(token).toMatch(/^\S+$/)
    }
  }, 20_000)
})
