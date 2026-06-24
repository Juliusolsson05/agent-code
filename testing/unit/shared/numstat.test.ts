import { describe, it, expect } from 'vitest'

import { parseNumstat } from '@shared/git/numstat'

// parseNumstat was extracted out of src/main/ipc/git.ts so the one tricky
// invariant it carries — binary files report '-' for both counts and we coerce
// those to 0 so the GitBar UI never special-cases the marker — has a single
// tested home. These cases pin that coercion plus the malformed-line skipping
// and tab parsing the GitBar producer depends on. (The git.ts comment claims
// this parser is "pure + unit-tested"; this file is what makes that true.)

describe('parseNumstat', () => {
  it('parses additions/deletions/file from tab-separated rows', () => {
    const out = parseNumstat('3\t1\tsrc/a.ts\n0\t5\tsrc/b.ts\n')
    expect(out).toEqual([
      { file: 'src/a.ts', additions: 3, deletions: 1 },
      { file: 'src/b.ts', additions: 0, deletions: 5 },
    ])
  })

  it("coerces binary '-' markers to 0/0 instead of NaN", () => {
    // This is the whole reason the function exists as a named unit: a binary
    // file shows up as `-\t-\t<path>`; the UI must see numbers, not '-'.
    expect(parseNumstat('-\t-\tassets/logo.png')).toEqual([
      { file: 'assets/logo.png', additions: 0, deletions: 0 },
    ])
    // Mixed: one side binary-ish, the other numeric.
    expect(parseNumstat('-\t2\tassets/x.bin')).toEqual([
      { file: 'assets/x.bin', additions: 0, deletions: 2 },
    ])
  })

  it('skips blank lines and rows with no filename rather than throwing', () => {
    // A trailing newline / empty line, and a malformed two-field row, must not
    // produce a phantom entry or crash the GitBar fetch.
    expect(parseNumstat('\n\n1\t1\tkept.ts\n')).toEqual([
      { file: 'kept.ts', additions: 1, deletions: 1 },
    ])
    expect(parseNumstat('1\t1')).toEqual([])
  })

  it('returns [] for empty input', () => {
    expect(parseNumstat('')).toEqual([])
    expect(parseNumstat('   \n  ')).toEqual([])
  })

  it('falls back to 0 for non-numeric counts (never NaN)', () => {
    // parseInt('x') is NaN; the `|| 0` guard keeps the contract numeric.
    expect(parseNumstat('x\ty\tweird.ts')).toEqual([
      { file: 'weird.ts', additions: 0, deletions: 0 },
    ])
  })
})
