import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GENERIC_SKILL_ERROR, userFacingSkillError } from './userFacingError.js'

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
      expect(message).toBe('A skill file or folder is missing.')
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

  it('replaces text that carries an absolute path, or runs long, with the generic sentence', () => {
    for (const text of [
      "could not open '/Users/someone/.claude/skills/x/SKILL.md'",
      'failed at /private/var/folders/tv/T/clone-1/SKILL.md',
      'C:\\Users\\someone\\skills',
      'x'.repeat(301),
    ]) expect(userFacingSkillError(new Error(text))).toBe(GENERIC_SKILL_ERROR)
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
})
