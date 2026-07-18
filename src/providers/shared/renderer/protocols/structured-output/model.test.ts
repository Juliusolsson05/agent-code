import { describe, expect, it } from 'vitest'

import { parseStructuredOutput } from './model'

describe('parseStructuredOutput', () => {
  it('recognizes JSONL without depending on a command name', () => {
    const model = parseStructuredOutput('{"ok":true,"id":1}\n[1,2,3]')

    expect(model?.records).toHaveLength(2)
    expect(model?.records[0]).toMatchObject({
      prefix: '',
      path: null,
      lineNumber: null,
      summary: 'ok: true',
    })
    expect(model?.records[1]?.summary).toBe('3 items')
  })

  it('exposes bounded event discriminators and messages without domain guessing', () => {
    const model = parseStructuredOutput(
      '{"cursor":195,"type":"agent.completed","agentId":"agent_6","label":"Renderer audit","message":"Done"}',
    )
    expect(model?.records[0]).toMatchObject({
      discriminatorLabel: 'Renderer audit · agent.completed · cursor 195',
      messagePreview: 'Done',
      summary: '5 keys',
    })
  })

  it('preserves ripgrep provenance and surrounding truncation notices', () => {
    const source = [
      'Warning: truncated output (original token count: 30028)',
      'Total output lines: 4',
      'testing/fixtures/rendering-bundles/example.json:1:{"meta":{"kind":"codex"},"ok":true}',
    ].join('\n')
    const model = parseStructuredOutput(source)

    expect(model?.contextLines).toEqual([
      'Warning: truncated output (original token count: 30028)',
      'Total output lines: 4',
    ])
    expect(model?.records[0]).toMatchObject({
      prefix: 'testing/fixtures/rendering-bundles/example.json:1:',
      path: 'testing/fixtures/rendering-bundles/example.json',
      lineNumber: 1,
      summary: 'ok: true',
    })
  })

  it('recognizes timestamp and label prefixes while keeping them verbatim', () => {
    const model = parseStructuredOutput([
      '2026-07-17T10:00:00Z INFO {"event":"started"}',
      'response: [1,2]',
    ].join('\n'))

    expect(model?.records.map(record => record.prefix)).toEqual([
      '2026-07-17T10:00:00Z INFO',
      'response:',
    ])
  })

  it('declines malformed fragments, scalar suffixes, and ordinary prose', () => {
    expect(parseStructuredOutput('file.json:1:{not json}')).toBeNull()
    expect(parseStructuredOutput('exit: 1\nstate: null')).toBeNull()
    expect(parseStructuredOutput('compiled 4 files successfully')).toBeNull()
  })

  it('does not scan an unbounded number of context lines', () => {
    const source = `${Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n')}\n{"ok":true}`
    expect(parseStructuredOutput(source)).toBeNull()
  })
})
