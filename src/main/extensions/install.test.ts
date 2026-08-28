import { describe, expect, it } from 'vitest'

import { InstallError, normalizeRepo } from '@main/extensions/install.js'

// `normalizeRepo` is the only pure, network-free part of the installer, and it is
// the part whose output is interpolated into two URLs and then persisted. The rest
// of install.ts needs a real filesystem and a real network and is covered by
// install.system.test.ts.

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
