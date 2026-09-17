import { describe, expect, it, vi } from 'vitest'

import {
  GH_TOKEN_TIMEOUT_MS,
  githubApiHeaders,
  resolveGitHubCliToken,
  type ExecFile,
} from '@main/extensions/githubCli.js'

// The runner is injected for exactly the reason ConsentPrompt is: the real
// implementation spawns a process, and tests need to drive the failure modes
// (missing binary, non-zero exit, timeout) without owning a machine state that
// produces them. Everything here exercises the REAL resolution logic through a
// fake `execFile`.

function runner(behavior: (callback: ExecFile extends never ? never : (error: Error | null, stdout: string, stderr: string) => void) => void): ExecFile {
  return (_command, _args, _options, callback) => behavior(callback)
}

describe('resolveGitHubCliToken', () => {
  it('returns the trimmed token on success', async () => {
    const impl = runner(callback => callback(null, '  gho_secret_token_123  \n', ''))
    await expect(resolveGitHubCliToken(impl)).resolves.toBe('gho_secret_token_123')
  })

  it('returns null when gh is not installed (ENOENT)', async () => {
    const impl = runner(callback =>
      callback(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), '', ''),
    )
    await expect(resolveGitHubCliToken(impl)).resolves.toBeNull()
  })

  it('returns null when gh exits non-zero (logged out, revoked, old version)', async () => {
    const impl = runner(callback => callback(Object.assign(new Error('exit 1'), { code: 1 }), '', 'not logged in'))
    await expect(resolveGitHubCliToken(impl)).resolves.toBeNull()
  })

  it('returns null when the process times out', async () => {
    const impl = runner(callback =>
      callback(Object.assign(new Error('spawn ETIMEDOUT'), { killed: true }), '', ''),
    )
    await expect(resolveGitHubCliToken(impl)).resolves.toBeNull()
  })

  it.each([
    ['empty output', ''],
    ['whitespace only', '   \n\t '],
    ['oversized output (not a token)', 'x'.repeat(4097)],
  ])('returns null for %s', async (_label, stdout) => {
    const impl = runner(callback => callback(null, stdout, ''))
    await expect(resolveGitHubCliToken(impl)).resolves.toBeNull()
  })

  it('never throws, even when the runner itself throws synchronously', async () => {
    const impl: ExecFile = () => { throw new Error('runner exploded') }
    await expect(resolveGitHubCliToken(impl)).resolves.toBeNull()
  })

  it('spawns gh auth token with a bounded timeout and hidden window', async () => {
    const impl = vi.fn(runner(callback => callback(null, 'tok', ''))) as unknown as ExecFile & ReturnType<typeof vi.fn>
    await resolveGitHubCliToken(impl)
    expect(impl).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      { timeout: GH_TOKEN_TIMEOUT_MS, windowsHide: true },
      expect.any(Function),
    )
  })
})

describe('githubApiHeaders', () => {
  it('adds a bearer authorization header only when a token exists', () => {
    expect(githubApiHeaders('tok')).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-code',
      authorization: 'Bearer tok',
    })
  })

  it('omits the header entirely without a token rather than sending an empty bearer', () => {
    // An empty `Bearer` is worse than none: GitHub answers 401 to a malformed
    // authorization header even when anonymous access would have succeeded.
    expect(githubApiHeaders(null)).not.toHaveProperty('authorization')
    expect(githubApiHeaders(null)).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-code',
    })
  })
})
