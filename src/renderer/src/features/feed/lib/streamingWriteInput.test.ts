import { describe, expect, it } from 'vitest'

import {
  STREAMING_WRITE_HEADER_SCAN_CHARS,
  STREAMING_WRITE_PREVIEW_LINES,
  STREAMING_WRITE_PREVIEW_RAW_CHARS,
  extractStreamingWriteInput,
} from './streamingWriteInput'

describe('extractStreamingWriteInput', () => {
  it('decodes an ordinary partial content string without claiming truncation', () => {
    expect(
      extractStreamingWriteInput(
        '{"file_path":"src/example.ts","content":"const one = 1;\\ncons',
      ),
    ).toEqual({
      filePath: 'src/example.ts',
      partialContent: 'const one = 1;\ncons',
      previewTruncated: false,
    })
  })

  it('never decodes beyond the fixed encoded-content preview window', () => {
    const visible = 'x'.repeat(STREAMING_WRITE_PREVIEW_RAW_CHARS)
    const omitted = 'tail-that-must-not-enter-the-preview'.repeat(10_000)
    const result = extractStreamingWriteInput(
      `{"file_path":"src/large.txt","content":"${visible}${omitted}`,
    )

    expect(result.filePath).toBe('src/large.txt')
    expect(result.partialContent).toBe(visible)
    expect(result.partialContent).not.toContain('tail-that-must-not-enter-the-preview')
    expect(result.previewTruncated).toBe(true)
  })

  it('caps newline-heavy previews before they can create unbounded DOM rows', () => {
    const encodedLines = 'line\\n'.repeat(STREAMING_WRITE_PREVIEW_LINES + 50)
    const result = extractStreamingWriteInput(
      `{"file_path":"src/generated.txt","content":"${encodedLines}`,
    )

    expect(result.partialContent?.match(/\n/g)).toHaveLength(
      STREAMING_WRITE_PREVIEW_LINES,
    )
    expect(result.previewTruncated).toBe(true)
  })

  it('reports a bounded-header stop instead of scanning a giant unrelated member', () => {
    const oversizedMetadata = 'm'.repeat(STREAMING_WRITE_HEADER_SCAN_CHARS * 4)
    const result = extractStreamingWriteInput(
      `{"file_path":"src/example.ts","metadata":"${oversizedMetadata}","content":"hidden`,
    )

    expect(result).toEqual({
      filePath: 'src/example.ts',
      partialContent: null,
      previewTruncated: true,
    })
  })

  it('bounds a content-first payload even when its path has not arrived', () => {
    const result = extractStreamingWriteInput(
      `{"content":"${'x'.repeat(STREAMING_WRITE_PREVIEW_RAW_CHARS * 3)}`,
    )

    expect(result.filePath).toBeNull()
    expect(result.partialContent).toHaveLength(STREAMING_WRITE_PREVIEW_RAW_CHARS)
    expect(result.previewTruncated).toBe(true)
  })
})
