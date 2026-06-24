import { describe, it, expect } from 'vitest'

import {
  sanitizePath,
  sanitizePathSegment,
  sanitizeFilenameToken,
} from '@shared/runtime/projectDir'

// sanitizePathSegment is the proxy-event storage segment sanitiser shared by
// the Codex writer and the debug-bundle reader. If writer and reader produce
// different segments for the same input, a debug bundle silently misses the
// proxy log. These golden cases pin the collapse/trim behavior so neither side
// can drift; the Claude headless package keeps an intentional mirror that must
// match this output for the same inputs.

describe('sanitizePathSegment', () => {
  it('collapses the dash runs sanitizePath leaves on a path', () => {
    // sanitizePath('/a/b/c') => '-a-b-c'; the segment form collapses + trims.
    expect(sanitizePath('/a/b/c')).toBe('-a-b-c')
    expect(sanitizePathSegment('/a/b/c')).toBe('a-b-c')
  })

  it('collapses runs from spaces/symbols and trims edge dashes', () => {
    expect(sanitizePathSegment(' spaces and symbols ')).toBe('spaces-and-symbols')
    expect(sanitizePathSegment('a//b!!c')).toBe('a-b-c')
  })

  it('returns empty string for all-separator / empty input (callers add fallback)', () => {
    expect(sanitizePathSegment('---')).toBe('')
    expect(sanitizePathSegment('///')).toBe('')
    expect(sanitizePathSegment('')).toBe('')
  })

  it('preserves alphanumerics in a realistic cwd', () => {
    expect(sanitizePathSegment('/Users/me/Projects/agent-code')).toBe(
      'Users-me-Projects-agent-code',
    )
  })
})

// sanitizeFilenameToken is the DIFFERENT (underscore) escape rule for
// session-keyed storage file names (feed-debug JSONL, debug-bundle folder
// suffix). It must never change output or existing logs/bundles orphan.
describe('sanitizeFilenameToken', () => {
  it('keeps [A-Za-z0-9._-] and underscores the rest', () => {
    expect(sanitizeFilenameToken('abc-123_x.y')).toBe('abc-123_x.y')
    expect(sanitizeFilenameToken('a/b\\c')).toBe('a_b_c')
    expect(sanitizeFilenameToken('../escape')).toBe('.._escape')
    expect(sanitizeFilenameToken('uuid:1234')).toBe('uuid_1234')
  })

  it('is distinct from the dash-collapsing segment sanitiser', () => {
    // Same input, deliberately different output — the two protect different
    // path layouts and must not be merged into one generic helper.
    expect(sanitizeFilenameToken('/a/b')).toBe('_a_b')
    expect(sanitizePathSegment('/a/b')).toBe('a-b')
  })
})
