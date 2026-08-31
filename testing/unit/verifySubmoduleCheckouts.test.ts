import { describe, expect, it } from 'vitest'

// @ts-expect-error The production guard is intentionally plain Node ESM so it
// can run before TypeScript/Vite compilation—the very build it protects.
import {
  classifySubmoduleCheckouts,
  formatSubmoduleFailure,
  parseGitlinks,
} from '../../scripts/verify-submodule-checkouts.mjs'

describe('submodule build provenance guard', () => {
  it('parses only gitlinks from nul-delimited stage records', () => {
    expect(parseGitlinks([
      '100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 0\tpackage.json',
      '160000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 0\tpackages/codex-headless',
      '160000 cccccccccccccccccccccccccccccccccccccccc 0\tvendor/codex src',
      '',
    ].join('\0'))).toEqual([
      {
        expectedHead: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        path: 'packages/codex-headless',
      },
      {
        expectedHead: 'cccccccccccccccccccccccccccccccccccccccc',
        path: 'vendor/codex src',
      },
    ])
  })

  it('reports stale HEAD and local source edits as distinct failures', () => {
    const gitlinks = [
      { path: 'packages/codex-headless', expectedHead: 'a'.repeat(40) },
      { path: 'packages/clean', expectedHead: 'b'.repeat(40) },
    ]
    const failures = classifySubmoduleCheckouts(gitlinks, new Map([
      ['packages/codex-headless', {
        initialized: true,
        head: 'c'.repeat(40),
        dirty: true,
      }],
      ['packages/clean', {
        initialized: true,
        head: 'b'.repeat(40),
        dirty: false,
      }],
    ]))

    expect(failures.map((failure: { kind: string }) => failure.kind)).toEqual([
      'mismatch',
      'dirty',
    ])
    const message = formatSubmoduleFailure(failures)
    expect(message).toContain(`expected: ${'a'.repeat(40)}`)
    expect(message).toContain(`actual:   ${'c'.repeat(40)}`)
    expect(message).toContain('DIRTY        packages/codex-headless')
    expect(message).toContain(
      'git submodule update --init --recursive -- packages/codex-headless',
    )
  })

  it('calls out an uninitialized checkout instead of borrowing the parent HEAD', () => {
    const failures = classifySubmoduleCheckouts(
      [{ path: 'packages/missing', expectedHead: 'd'.repeat(40) }],
      new Map([['packages/missing', { initialized: false }]]),
    )
    expect(failures).toEqual([{
      kind: 'uninitialized',
      path: 'packages/missing',
      expectedHead: 'd'.repeat(40),
    }])
  })
})
