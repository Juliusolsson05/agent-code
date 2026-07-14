import { describe, expect, it } from 'vitest'

import {
  STREAMING_EDIT_HEADER_SCAN_CHARS,
  STREAMING_EDIT_PREVIEW_RAW_CHARS,
  STREAMING_MULTI_EDIT_PREVIEW_ITEMS,
  extractClosedJsonString,
  partialEditInput,
  partialEditPreview,
} from '@providers/claude/renderer/extractors'

describe('partial Edit input', () => {
  it('exposes new_string while its JSON literal is still streaming', () => {
    const input = partialEditInput(
      '{"file_path":"src/a.ts","old_string":"const a = 1;\\n","new_string":"const a = 2;\\ncons',
      null,
      'Edit',
    )

    expect(input).toEqual({
      file_path: 'src/a.ts',
      old_string: 'const a = 1;\n',
      new_string: 'const a = 2;\ncons',
    })
  })

  it('withholds an incomplete escape until the next delta completes it', () => {
    const input = partialEditInput(
      '{"file_path":"src/a.ts","old_string":"old","new_string":"line\\',
      null,
      'Edit',
    )
    expect(input).toMatchObject({ new_string: 'line' })
  })

  it('streams completed edits plus the partial tail of MultiEdit', () => {
    const input = partialEditInput(
      '{"file_path":"src/a.ts","edits":[{"old_string":"one","new_string":"ONE"},{"old_string":"two","new_string":"TW',
      null,
      'MultiEdit',
    )
    expect(input).toEqual({
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'one', new_string: 'ONE' },
        { old_string: 'two', new_string: 'TW' },
      ],
    })
  })

  it('keeps closed-field extraction strict for header values', () => {
    expect(extractClosedJsonString('{"file_path":"src/part', 'file_path')).toBeNull()
    expect(extractClosedJsonString('{"file_path":"src/a.ts"', 'file_path')).toBe('src/a.ts')
  })

  it('bounds an unterminated replacement before decoding the accumulated tail', () => {
    const source = 'x'.repeat(
      STREAMING_EDIT_HEADER_SCAN_CHARS + STREAMING_EDIT_PREVIEW_RAW_CHARS * 2,
    )
    const raw = `{"file_path":"src/huge.ts","old_string":"${source}`
    const preview = partialEditPreview(raw, null, 'Edit')
    const input = preview.input as Record<string, string>

    expect(preview.previewTruncated).toBe(true)
    expect(input.file_path).toBe('src/huge.ts')
    expect(input.old_string.length).toBeLessThanOrEqual(
      STREAMING_EDIT_HEADER_SCAN_CHARS + STREAMING_EDIT_PREVIEW_RAW_CHARS,
    )
    expect(input.old_string.length).toBeLessThan(source.length)
    expect(input.new_string).toBe('')
  })

  it('caps MultiEdit chunk prediction even when tiny objects fit the character window', () => {
    const raw = JSON.stringify({
      file_path: 'src/many.ts',
      edits: Array.from(
        { length: STREAMING_MULTI_EDIT_PREVIEW_ITEMS + 20 },
        (_, index) => ({ old_string: String(index), new_string: `next-${index}` }),
      ),
    })
    const preview = partialEditPreview(raw, null, 'MultiEdit')
    const edits = (preview.input as { edits: unknown[] }).edits

    expect(preview.previewTruncated).toBe(true)
    expect(edits).toHaveLength(STREAMING_MULTI_EDIT_PREVIEW_ITEMS)
  })

  it('accepts snake or camel fields independently of tool-name capitalization', () => {
    expect(partialEditInput(
      '{"file_path":"src/lower.ts","old_string":"before","new_string":"after"}',
      null,
      'edit',
    )).toEqual({
      file_path: 'src/lower.ts',
      old_string: 'before',
      new_string: 'after',
    })

    expect(partialEditInput(
      '{"filePath":"src/camel.ts","oldString":"before","newString":"after"}',
      null,
      'Edit',
    )).toEqual({
      file_path: 'src/camel.ts',
      old_string: 'before',
      new_string: 'after',
    })
  })

  it('does not mistake key-shaped source text for the next structural field', () => {
    const raw = JSON.stringify({
      file_path: 'src/keys.ts',
      old_string: 'literal "new_string": "not the field"',
      new_string: 'the real replacement',
    })

    expect(partialEditInput(raw, null, 'Edit')).toMatchObject({
      old_string: 'literal "new_string": "not the field"',
      new_string: 'the real replacement',
    })
  })

  it('lets authoritative parsed input bypass every provisional limit', () => {
    const exact = {
      file_path: 'src/exact.ts',
      old_string: 'o'.repeat(STREAMING_EDIT_PREVIEW_RAW_CHARS * 2),
      new_string: 'n'.repeat(STREAMING_EDIT_PREVIEW_RAW_CHARS * 2),
    }

    expect(partialEditPreview('incomplete transport prefix', exact, 'Edit')).toEqual({
      input: exact,
      previewTruncated: false,
    })
  })
})
