import { describe, expect, it } from 'vitest'

import {
  parseOpencodeReadResult,
  parseOpencodeReadText,
} from '@providers/opencode/renderer/extractors'

describe('OpenCode read extraction', () => {
  it('returns provider-neutral source data and removes the provider gutter', () => {
    expect(
      parseOpencodeReadResult({
        type: 'tool_result',
        tool_use_id: 'read-1',
        content: '<path>/repo/src/a.ts</path>\n<content>\n1: const a = 1\n2: export { a }\n</content>',
      }),
    ).toEqual({
      path: '/repo/src/a.ts',
      content: 'const a = 1\nexport { a }\n',
      rawText: '<path>/repo/src/a.ts</path>\n<content>\n1: const a = 1\n2: export { a }\n</content>',
      complete: true,
    })
  })

  it('uses the final closing tag when the source contains tag-looking text', () => {
    const parsed = parseOpencodeReadText(
      '<path>/repo/docs.md</path>\n<content>\n1: literal </content> remains\n2: after\n</content>',
    )

    expect(parsed?.content).toBe('literal </content> remains\nafter\n')
    expect(parsed?.complete).toBe(true)
  })

  it('exposes a useful content prefix before the closing tag arrives', () => {
    expect(
      parseOpencodeReadText(
        '<path>/repo/src/live.ts</path>\n<content>\n1: export const live = tr',
      ),
    ).toMatchObject({
      path: '/repo/src/live.ts',
      content: 'export const live = tr',
      complete: false,
    })
  })

  it('refuses to invent structure before both required opening fields exist', () => {
    expect(parseOpencodeReadText('<path>/repo/src/a.ts</path>')).toBeNull()
    expect(parseOpencodeReadText('<content>\n1: no path')).toBeNull()
  })
})
