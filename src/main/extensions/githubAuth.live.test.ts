import { describe, expect, it } from 'vitest'

import { githubApiHeaders, resolveGitHubCliToken } from '@main/extensions/githubCli.js'

// LIVE tier — opt-in, excluded from CI (`npm run test:live`). This is the only
// place the whole chain is proven against reality: the real `gh` binary, the
// real keychain behind it, and the real api.github.com answering with the
// authenticated rate-limit bucket. The smoking gun is `x-ratelimit-limit`:
// anonymous is 60, authenticated is 5000 — no other assertion distinguishes
// "a header was sent" from "GitHub actually accepted the credential".

describe('GitHub CLI credential, live end to end', () => {
  it('raises the api.github.com rate-limit bucket from 60 to 5000', async () => {
    const token = await resolveGitHubCliToken()
    if (token === null) {
      // Not a failure: this machine has no authenticated gh. The live
      // contract only holds where the credential exists.
      return
    }

    const response = await fetch('https://api.github.com/rate_limit', {
      headers: githubApiHeaders(token),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-ratelimit-limit')).toBe('5000')
    // And the read must land in the authenticated bucket, not the anonymous
    // one — `x-ratelimit-used` belongs to the 5000 budget when the header was
    // honored, which a silent strip would betray on the limit check above.
    const remaining = Number(response.headers.get('x-ratelimit-remaining'))
    expect(Number.isFinite(remaining)).toBe(true)
    expect(remaining).toBeLessThanOrEqual(5000)
  }, 30_000)
})
