import { describe, expect, it } from 'vitest'

import { extractPartialJsonStringField } from '@shared/lib/partialJsonString'

describe('extractPartialJsonStringField', () => {
  it('decodes arrived escapes and reports an open tail', () => {
    expect(extractPartialJsonStringField('{"content":"a\\nb\\u0020c', 'content')).toMatchObject({
      value: 'a\nb c',
      closed: false,
    })
  })

  it('does not treat an escaped key-shaped fragment as an object field', () => {
    expect(
      extractPartialJsonStringField(
        '{"prose":"mentions \\"new_string\\": \\"not a field"}',
        'new_string',
      ),
    ).toBeNull()
  })

  it('withholds a unicode high surrogate until its low-surrogate escape arrives', () => {
    expect(
      extractPartialJsonStringField('{"content":"rocket \\uD83D', 'content'),
    ).toMatchObject({ value: 'rocket ', closed: false })
    expect(
      extractPartialJsonStringField('{"content":"rocket \\uD83D\\uDE', 'content'),
    ).toMatchObject({ value: 'rocket ', closed: false })
    expect(
      extractPartialJsonStringField('{"content":"rocket \\uD83D\\uDE80"}', 'content'),
    ).toMatchObject({ value: 'rocket 🚀', closed: true })
  })

  it('also keeps a raw UTF-16 pair atomic when handed a code-unit prefix', () => {
    const complete = '{"content":"rocket 🚀"}'
    const throughHighSurrogate = complete.slice(0, complete.indexOf('🚀') + 1)

    expect(
      extractPartialJsonStringField(throughHighSurrogate, 'content'),
    ).toMatchObject({ value: 'rocket ', closed: false })
    expect(extractPartialJsonStringField(complete, 'content')).toMatchObject({
      value: 'rocket 🚀',
      closed: true,
    })
  })
})
