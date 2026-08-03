import { describe, expect, it } from 'vitest'

import { isValidExtensionId } from '@shared/types/extensionId.js'

// The single validator every untrusted-string → extension-identity conversion goes
// through. The traversal cases below are the ones that actually reached a filesystem
// path join: `agent-code-ext://../extension-grants.json` parsed to hostname `..`, which
// rooted the scheme handler at the whole state directory.

describe('isValidExtensionId', () => {
  it('accepts well-formed ids', () => {
    for (const id of ['a', 'timer', 'mini-games', 'a1', 'a'.repeat(64)]) {
      expect(isValidExtensionId(id), id).toBe(true)
    }
  })

  it('rejects traversal and separators', () => {
    for (const id of ['..', '.', '../..', 'a/b', 'a\\b', '../evil', '%2e%2e']) {
      expect(isValidExtensionId(id), id).toBe(false)
    }
  })

  it('rejects shapes that are not lowercase-letter-led', () => {
    for (const id of ['', '1abc', '-abc', 'Abc', 'aBc', 'a_b', 'a.b', 'a'.repeat(65)]) {
      expect(isValidExtensionId(id), id).toBe(false)
    }
  })

  it('rejects non-strings rather than coercing them', () => {
    for (const id of [null, undefined, 42, {}, []]) {
      expect(isValidExtensionId(id)).toBe(false)
    }
  })
})
