import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GENERIC_SKILL_ERROR, REVEAL_FAILED, revealFailureMessage, userFacingSkillError } from './userFacingError.js'

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => warn.mockClear())

// #1427: what a Skills surface may show for an error. Real errors from the
// filesystem where the shape matters, so the errno/syscall detection is tested
// against what Node actually throws.
describe('userFacingSkillError', () => {
  it('turns a real Node system error into a fixed sentence with no path, and logs the raw error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-error-'))
    try {
      const error = await rmdir(join(root, 'missing')).then(() => null, (caught: unknown) => caught)
      const message = userFacingSkillError(error)
      expect(message).toBe('A file or folder Agent Code needs is missing.')
      expect(message).not.toContain(root)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(message), error)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the service’s own curated text and does not log it', () => {
    expect(userFacingSkillError(new Error('A managed skill already uses the reserved TLDR name.'))).toBe('A managed skill already uses the reserved TLDR name.')
    expect(warn).not.toHaveBeenCalled()
  })

  it('replaces text that carries any path spelling, spans lines, or runs long, and logs what it replaced', () => {
    for (const text of [
      "could not open '/Users/someone/.claude/skills/x/SKILL.md'",
      'failed at /private/var/folders/tv/T/clone-1/SKILL.md',
      'C:\\Users\\someone\\skills',
      // Review of #1456 (a): these five passed the first path filter.
      'Failed at /tmp',
      'Failed at ~/skills',
      'Failed at ../skills',
      "Failed at '/tmp'",
      'Failed at \\\\server\\share',
      'C:/Users/Ann',
      'file:///tmp/x',
      'first line\nsecond line',
      'x'.repeat(301),
    ]) {
      warn.mockClear()
      const raw = new Error(text)
      expect(userFacingSkillError(raw)).toBe(GENERIC_SKILL_ERROR)
      // Review of #1456 (a), a surviving mutation: logging only for system
      // errors left these rewrites with no diagnostic trail.
      expect(warn).toHaveBeenCalledWith(expect.any(String), raw)
    }
  })

  it('never keeps a child-process error or a library error, even without a path', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    // A real child-process failure: its `code` is the exit number, so the
    // errno rule misses it, and its message is `Command failed: …` + stderr.
    const child = await promisify(execFile)(process.execPath, ['-e', "process.stderr.write('fatal: unexpected git failure'); process.exit(128)"])
      .then(() => null, (caught: unknown) => caught)
    expect(userFacingSkillError(child)).toBe(GENERIC_SKILL_ERROR)
    // The same shape with empty stderr is ONE line and path-free (`Command
    // failed: git ls-remote`); only the child-process rule refuses it.
    const quiet = Object.assign(new Error('Command failed: git ls-remote'), { cmd: 'git ls-remote', code: 128, stderr: '' })
    expect(userFacingSkillError(quiet)).toBe(GENERIC_SKILL_ERROR)
    expect(userFacingSkillError(new TypeError('fetch failed'))).toBe(GENERIC_SKILL_ERROR)
    expect(userFacingSkillError(new SyntaxError('Unexpected token } in JSON at position 5'))).toBe(GENERIC_SKILL_ERROR)
  })

  it('answers a failed Reveal with a fixed sentence and logs Electron\'s text', () => {
    expect(revealFailureMessage('Failed to open /Users/Alice/.claude/skills', 'test')).toBe(REVEAL_FAILED)
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'Failed to open /Users/Alice/.claude/skills')
  })

  it('maps an unknown errno and a non-Error value to the generic sentence', () => {
    const odd = Object.assign(new Error('EWEIRD: something, open \'/x/y\''), { code: 'EWEIRD', syscall: 'open' })
    expect(userFacingSkillError(odd)).toBe(GENERIC_SKILL_ERROR)
    expect(userFacingSkillError('a string')).toBe(GENERIC_SKILL_ERROR)
    expect(userFacingSkillError(undefined)).toBe(GENERIC_SKILL_ERROR)
  })

  it('treats a network system error as a network failure', () => {
    const offline = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND', syscall: 'getaddrinfo' })
    expect(userFacingSkillError(offline)).toBe('Agent Code could not reach the network.')
  })

  // Review of #1456 (b), a surviving mutation: swapping ENOTDIR's sentence for
  // ENOENT's passed. Each code is pinned to its exact, location-neutral words.
  it.each([
    ['EACCES', 'Agent Code does not have permission to use this location.'],
    ['EPERM', 'Agent Code does not have permission to use this location.'],
    ['EROFS', 'This location is on a read-only volume.'],
    ['ENOSPC', 'There is no space left on the disk.'],
    ['ENOENT', 'A file or folder Agent Code needs is missing.'],
    ['ENOTDIR', 'A file is in the way where a folder should be.'],
    ['EISDIR', 'A folder is in the way where a file should be.'],
    ['EEXIST', 'Something already exists where Agent Code needs to write.'],
    ['EBUSY', 'The file is busy. Try again in a moment.'],
    ['EMFILE', 'The system is out of open files. Try again in a moment.'],
    ['ENOTFOUND', 'Agent Code could not reach the network.'],
  ])('%s has its own sentence', (code, sentence) => {
    const error = Object.assign(new Error(`${code}: something, open '/x/y'`), { code, syscall: 'open' })
    expect(userFacingSkillError(error)).toBe(sentence)
  })

  it('shows a curated reason without its path, and logs the path', () => {
    const error = Object.assign(new Error('A folder on the skill path is a symbolic link, which Agent Code does not follow.'), { path: '/tmp' })
    expect(userFacingSkillError(error)).toBe(error.message)
    expect(warn).toHaveBeenCalledWith(expect.any(String), error)
  })
})
