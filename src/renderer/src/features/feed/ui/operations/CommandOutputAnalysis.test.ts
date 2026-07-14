import { describe, expect, it } from 'vitest'

import {
  analyzeCommandOutput,
  parseCommandDiagnostics,
  parseCommandTestSummary,
  parseCommandUrls,
} from './CommandOutputAnalysis'

describe('command output analysis', () => {
  it('accepts a complete JSON grammar and rejects a streaming prefix', () => {
    expect(analyzeCommandOutput('{"ok":true,"changed":2}').structuredJson).toEqual({
      ok: true,
      changed: 2,
    })
    expect(analyzeCommandOutput('{"ok":true,"changed":').structuredJson).toBeNull()
    // Valid JSON scalars add no user-facing structure over raw command text.
    expect(analyzeCommandOutput('42').structuredJson).toBeNull()
  })

  it('reads only anchored summaries from common test-runner grammars', () => {
    expect(parseCommandTestSummary('\u001b[32mTests  12 passed | 2 skipped (14)\u001b[0m')).toEqual({
      passed: 12,
      failed: null,
      skipped: 2,
    })
    expect(parseCommandTestSummary('Tests: 1 failed, 2 skipped, 9 passed, 12 total')).toEqual({
      passed: 9,
      failed: 1,
      skipped: 2,
    })
    expect(parseCommandTestSummary('===== 2 failed, 10 passed, 1 skipped in 0.42s =====')).toEqual({
      passed: 10,
      failed: 2,
      skipped: 1,
    })
    expect(parseCommandTestSummary('test result: ok. 7 passed; 0 failed; 3 ignored; 0 measured')).toEqual({
      passed: 7,
      failed: 0,
      skipped: 3,
    })
    expect(parseCommandTestSummary('The migration says 12 tests passed after retrying.')).toBeNull()
    expect(parseCommandTestSummary('===== arbitrary prose 12 passed here =====')).toBeNull()
    expect(parseCommandTestSummary('Tests  1 passed (1)\nTests  2 passed (2)')).toBeNull()
  })

  it('waits for a complete, single Node test footer', () => {
    expect(parseCommandTestSummary('# tests 4\n# pass 3\n# fail 1\n# skipped 0\n# duration_ms 10')).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
    })
    expect(parseCommandTestSummary('# tests 4\n# pass 3')).toBeNull()
    expect(parseCommandTestSummary('# tests 1\n# pass 1\n# fail 0\n# tests 2\n# pass 2\n# fail 0')).toBeNull()
  })

  it('extracts compiler-owned path locations without promoting stack frames', () => {
    expect(parseCommandDiagnostics([
      'src/feed.tsx:12:4: error TS2322: Type mismatch',
      '  --> src/main.rs:8:2',
      '    at render (/tmp/feed.tsx:3:1)',
    ].join('\n'))).toEqual([
      {
        target: 'src/feed.tsx:12:4',
        path: 'src/feed.tsx',
        line: 12,
        column: 4,
        message: 'error TS2322: Type mismatch',
        severity: 'error',
      },
      {
        target: 'src/main.rs:8:2',
        path: 'src/main.rs',
        line: 8,
        column: 2,
        message: '',
        severity: null,
      },
    ])
  })

  it('deduplicates valid HTTP links and trims prose punctuation', () => {
    expect(parseCommandUrls(
      'Report: https://example.com/report?id=3.\nAgain https://example.com/report?id=3.\nDocs (https://example.com/docs).',
    )).toEqual([
      'https://example.com/report?id=3',
      'https://example.com/docs',
    ])
  })
})
