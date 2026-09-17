import { describe, expect, it } from 'vitest'

import { InstallError, githubApiFailure, normalizeRepo } from '@main/extensions/install.js'

// `normalizeRepo` is the only pure, network-free part of the installer, and it is
// the part whose output is interpolated into two URLs and then persisted. The rest
// of install.ts needs a real filesystem and a real network and is covered by
// install.system.test.ts.
//
// githubApiFailure is the second pure part: it turns a real (already-received)
// Response into the user-facing error, so its diagnosis logic is testable with
// nothing but constructed Responses.

describe('normalizeRepo — accepted forms', () => {
  it.each([
    ['bare', 'owner/repo'],
    ['https', 'https://github.com/owner/repo'],
    ['https with www', 'https://www.github.com/owner/repo'],
    ['http', 'http://github.com/owner/repo'],
    ['ssh', 'git@github.com:owner/repo'],
    ['trailing .git', 'https://github.com/owner/repo.git'],
    ['trailing slash', 'https://github.com/owner/repo/'],
    ['surrounding whitespace', '  owner/repo  '],
  ])('normalizes the %s form to owner/repo', (_label, input) => {
    expect(normalizeRepo(input)).toBe('owner/repo')
  })

  it('keeps dots and dashes inside a real name', () => {
    // Real repositories are named this way (`user.name/my-repo.js`), so the
    // dot-rejection below must not be a blanket ban on the character.
    expect(normalizeRepo('user.name/my-repo.js')).toBe('user.name/my-repo.js')
  })
})

describe('normalizeRepo — rejected forms', () => {
  // ── THE REGRESSION THIS BLOCK EXISTS FOR ──
  // The character class `[\w.-]+` matches `.` and `..`, so `../x` parsed cleanly
  // into owner `..`. The result is interpolated into
  // `https://api.github.com/repos/${repo}` and into the codeload URL, where the URL
  // parser NORMALIZES the `..` away — so the request addressed a different GitHub
  // endpoint than the code believed it was calling, and the bogus value was then
  // written to the ledger and rendered in Settings.
  it.each([
    ['parent traversal as owner', '../repo'],
    ['parent traversal as repo', 'owner/..'],
    ['both segments traversal', '../..'],
    ['single dot as owner', './repo'],
    ['single dot as repo', 'owner/.'],
    ['triple dot', '.../repo'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeRepo(input)).toThrow(InstallError)
  })

  it.each([
    ['a non-GitHub host', 'https://gitlab.com/owner/repo'],
    ['three segments', 'owner/repo/extra'],
    ['one segment', 'owner'],
    ['empty', ''],
    ['a space inside', 'own er/repo'],
    ['a query string', 'https://github.com/owner/repo?x=1'],
    ['a URL fragment', 'https://github.com/owner/repo#readme'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeRepo(input)).toThrow(InstallError)
  })

  it('names the offending input in the message so the user can fix it', () => {
    // The user typed this string; an error that does not quote it back is not
    // actionable in a Settings row that shows nothing else.
    expect(() => normalizeRepo('not a repo')).toThrow(/"not a repo"/)
  })
})

describe('githubApiFailure — 403 diagnosis', () => {
  // ── THE REGRESSION THIS BLOCK EXISTS FOR ──
  // GitHub's anonymous api.github.com quota is 60/hour per IP, and the installer
  // spends two requests per attempt. Once exhausted, every call 403s with
  // `x-ratelimit-remaining: 0` — indistinguishable from a forbidden repo when the
  // status is surfaced verbatim. Users concluded repositories that plainly
  // existed were broken (#980).

  function response(status: number, headers: Record<string, string> = {}): Response {
    return new Response('{"message":"API rate limit exceeded"}', { status, headers })
  }

  it('a rate-limited 403 names the limit, the reset time, and the folder escape hatch', () => {
    const resetAt = new Date(Date.now() + 25 * 60_000)
    const error = githubApiFailure(response(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(resetAt.getTime() / 1000)),
    }), 'owner/repo')
    expect(error).toBeInstanceOf(InstallError)
    // toLocaleTimeString renders in the test machine's locale, so assert on the
    // pieces that are locale-independent.
    expect(error.message).toMatch(/rate limit/i)
    expect(error.message).toMatch(/resets at/)
    expect(error.message).toMatch(/Load extension from folder/)
    expect(error.message).toContain('owner/repo')
  })

  it('a rate-limited 403 without a usable reset header still names the limit', () => {
    const error = githubApiFailure(response(403, { 'x-ratelimit-remaining': '0' }), 'owner/repo')
    expect(error.message).toMatch(/rate limit/i)
    expect(error.message).toMatch(/Load extension from folder/)
    expect(error.message).not.toMatch(/resets at/)
  })

  it('a garbage reset header is ignored rather than rendered as an invalid date', () => {
    const error = githubApiFailure(response(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': 'not-a-number',
    }), 'owner/repo')
    expect(error.message).toMatch(/rate limit/i)
    expect(error.message).not.toMatch(/resets at/)
    expect(error.message).not.toMatch(/Invalid Date/)
  })

  it('a 403 with remaining quota is NOT reported as a rate limit', () => {
    // A forbidden-but-not-throttled 403 (blocked repo, odd proxy) must keep its
    // own meaning; blanket "you're rate limited" would be a new lie.
    const error = githubApiFailure(response(403, { 'x-ratelimit-remaining': '58' }), 'owner/repo')
    expect(error.message).toMatch(/403/)
    expect(error.message).not.toMatch(/rate limit/i)
  })

  it('other statuses keep the existing verbatim message', () => {
    expect(githubApiFailure(response(500), 'owner/repo').message)
      .toBe('GitHub returned 500 for owner/repo.')
  })
})
