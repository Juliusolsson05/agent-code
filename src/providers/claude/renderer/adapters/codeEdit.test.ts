import { describe, expect, it } from 'vitest'

import {
  extractJsonStringField,
  fromClaudeEditBlock,
  fromClaudePartialEditJson,
  isClaudeCodeEditSuccessResult,
} from '@providers/claude/renderer/adapters/codeEdit'
import {
  decodeEmbeddedPatchLiteral,
  fromCodexApplyPatch,
  fromCodexPartialPatchText,
} from '@providers/codex/renderer/adapters/codeEdit'

// THE STREAMING-FIRST CONTRACT (product owner's explicit trap warning):
// a paintable model must exist from the FIRST closed tokens — waiting for
// the complete JSON/patch to land "ruins the whole point". These tests pin
// that for both providers' adapters. Monotonicity is pinned too: a longer
// prefix must never yield LESS than a shorter one.

describe('claude code-edit adapter — streaming first', () => {
  it('yields NO model before file_path closes (half-streamed paths must not paint)', () => {
    expect(fromClaudePartialEditJson('Edit', '{"file_path":"/repo/sr')).toBeNull()
  })

  it('yields a paintable model the MOMENT file_path closes, before any content arrives', () => {
    const m = fromClaudePartialEditJson('Edit', '{"file_path":"/repo/src/a.ts","old_str')
    expect(m).not.toBeNull()
    expect(m!.files[0].path).toBe('/repo/src/a.ts')
    expect(m!.status).toBe('streaming')
    expect(m!.partial).toBe(true)
  })

  it('diff lines GROW as new_string streams — same shape, more evidence', () => {
    const early = fromClaudePartialEditJson(
      'Edit',
      '{"file_path":"/a.ts","old_string":"x = 1","new_string":"x = 2\\ny ',
    )!
    const later = fromClaudePartialEditJson(
      'Edit',
      '{"file_path":"/a.ts","old_string":"x = 1","new_string":"x = 2\\ny = 3"}',
    )!
    expect(early.files[0].additions).toBeGreaterThan(0)
    expect(later.files[0].additions).toBeGreaterThanOrEqual(early.files[0].additions)
  })

  it('Write streams as growing pure additions (no fabricated diff)', () => {
    const m = fromClaudePartialEditJson('Write', '{"file_path":"/w.md","content":"line1\\nline2')!
    expect(m.files[0].verb).toBe('Writing')
    expect(m.files[0].deletions).toBe(0)
    expect(m.files[0].additions).toBe(2)
  })

  it('bounds decoded and scanned streaming Edit/Write evidence with truthful lower bounds', () => {
    const largeOld = Array.from({ length: 20_000 }, (_, index) => `old ${index}`).join('\n')
    const largeNew = Array.from({ length: 20_000 }, (_, index) => `new ${index}`).join('\n')
    const edit = fromClaudePartialEditJson('Edit', JSON.stringify({
      file_path: '/large.ts',
      old_string: largeOld,
      new_string: largeNew,
    }))!
    const editFile = edit.files[0]
    expect(editFile.lines.length).toBeGreaterThan(0)
    expect(editFile.lines.length).toBeLessThanOrEqual(400)
    expect(editFile.previewTruncated).toBe(true)
    expect(editFile.countsTruncated).toBe(true)
    expect(editFile.deletions).toBeGreaterThan(0)
    expect(editFile.exactSections).toBeUndefined()

    // When old_string is small, new_string's key remains inside the bounded
    // head window and its independently capped prefix is visible too. If a
    // preceding value pushes that key into the skipped middle, the adapter
    // truthfully marks the missing side truncated instead of scanning for it.
    const largeNewEdit = fromClaudePartialEditJson('Edit', JSON.stringify({
      file_path: '/large-new.ts',
      old_string: 'before',
      new_string: largeNew,
    }))!
    expect(largeNewEdit.files[0].additions).toBeGreaterThan(0)
    expect(largeNewEdit.files[0].countsTruncated).toBe(true)

    const write = fromClaudePartialEditJson('Write', JSON.stringify({
      file_path: '/large.txt',
      content: largeNew,
    }))!
    const writeFile = write.files[0]
    expect(writeFile.lines).toHaveLength(400)
    expect(writeFile.previewTruncated).toBe(true)
    expect(writeFile.countsTruncated).toBe(true)
    expect(writeFile.additions).toBeGreaterThanOrEqual(400)
  })

  it('retains bounded new_string evidence after its key moves into the skipped middle', () => {
    const largeOld = 'old line\n'.repeat(12_000)
    const prefix = `{"file_path":"/monotonic-large-edit.ts","old_string":${JSON.stringify(largeOld)},"new_string":"`
    const earlyRaw = `${prefix}first addition\\nsecond addition`
    const early = fromClaudePartialEditJson('Edit', earlyRaw)!

    // More streamed after-content pushes the new_string key outside both the
    // fixed head and tail windows. The prior implementation returned an empty
    // after-side here, so additions that had already painted vanished.
    const laterRaw = `${earlyRaw}${' continued'.repeat(8_000)}`
    const later = fromClaudePartialEditJson('Edit', laterRaw)!

    expect(early.files[0].additions).toBeGreaterThan(0)
    expect(later.files[0].additions).toBeGreaterThanOrEqual(early.files[0].additions)
    expect(later.files[0].lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: '+', text: 'first addition' }),
    ]))
    expect(later.files[0].previewTruncated).toBe(true)
    expect(later.files[0].countsTruncated).toBe(true)

    // Reusing a file path is not continuity. A rewind/new operation whose
    // bounded head no longer matches must not inherit the prior after-side.
    const restarted = fromClaudePartialEditJson(
      'Edit',
      `{"file_path":"/monotonic-large-edit.ts","old_string":"${'different old '.repeat(8_000)}`,
    )!
    expect(restarted.files[0].additions).toBe(0)
  })

  it('escape torn mid-stream is tolerated, never thrown', () => {
    const r = extractJsonStringField('{"file_path":"/a\\', 'file_path')
    expect(r).toEqual({ value: '/a', closed: false })
  })

  it('decodes JSON backspace/form-feed and does not swallow delimiters after malformed unicode', () => {
    expect(extractJsonStringField('{"value":"a\\bb\\fc"}', 'value')).toEqual({
      value: `a\bb\fc`,
      closed: true,
    })
    expect(extractJsonStringField('{"value":"a\\u12"}', 'value')).toEqual({
      value: 'au12',
      closed: true,
    })
    expect(extractJsonStringField('{"value":"a\\uZZZZ","next":1}', 'value')).toEqual({
      value: 'auZZZZ',
      closed: true,
    })
    expect(extractJsonStringField('{"value":"a\\u263a"}', 'value')).toEqual({
      value: 'a☺',
      closed: true,
    })
  })

  it('committed blocks map completely: Edit diff and Write additions', () => {
    const edit = fromClaudeEditBlock({
      type: 'tool_use', id: 't1', name: 'Edit',
      input: { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc' },
    } as never)!
    expect(edit.files[0].deletions).toBe(1)
    expect(edit.files[0].additions).toBe(1)
    expect(edit.status).toBe('success')
    expect(fromClaudeEditBlock({ type: 'tool_use', id: 't3', name: 'Bash', input: {} } as never)).toBeNull()
  })

  it('bounds huge Write models before they reach the DOM', () => {
    const content = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n')
    const write = fromClaudeEditBlock({
      type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: '/huge.ts', content },
    } as never)!
    expect(write.files[0].lines.length).toBeLessThanOrEqual(400)
    expect(write.files[0].previewTruncated).toBe(true)
    expect(write.files[0].exactSections?.[0]?.text).toBe(content)
  })

  it('keeps Write counts consistent with diff rows when content ends in a newline', () => {
    const write = fromClaudeEditBlock({
      type: 'tool_use', id: 'newline', name: 'Write', input: {
        file_path: '/newline.txt', content: 'one line\n',
      },
    } as never)!
    expect(write.files[0].lines).toHaveLength(1)
    expect(write.files[0].additions).toBe(1)
  })

  it('declines blank committed paths', () => {
    expect(fromClaudeEditBlock({
      type: 'tool_use', id: 'edit', name: 'Edit', input: {
        file_path: '  ', old_string: 'a', new_string: 'b',
      },
    } as never)).toBeNull()
    expect(fromClaudeEditBlock({
      type: 'tool_use', id: 'write', name: 'Write', input: {
        file_path: '', content: 'content',
      },
    } as never)).toBeNull()
  })

  it('absorbs only the two captured success acknowledgements', () => {
    const edit = { type: 'tool_use', id: 'e1', name: 'Edit', input: {} } as never
    expect(isClaudeCodeEditSuccessResult({
      type: 'tool_result', tool_use_id: 'e1', content: 'The file /repo/a.ts has been updated successfully. (file state is current in your context — no need to Read it back)',
    } as never, edit)).toBe(true)
    expect(isClaudeCodeEditSuccessResult({
      type: 'tool_result', tool_use_id: 'e1', content: '<tool_use_error>failed</tool_use_error>', is_error: true,
    } as never, edit)).toBe(false)
    expect(isClaudeCodeEditSuccessResult({
      type: 'tool_result', tool_use_id: 'e1', content: 'a future structured success payload',
    } as never, edit)).toBe(false)
  })
})

describe('codex code-edit adapter — streaming first', () => {
  it('patch intent is provable from the first file header — model exists mid-stream', () => {
    const m = fromCodexPartialPatchText('*** Begin Patch\n*** Update File: src/x.ts\n-old line\n+new li')
    expect(m).not.toBeNull()
    expect(m!.files[0].path).toBe('src/x.ts')
    expect(m!.files[0].verb).toBe('Editing')
    expect(m!.status).toBe('streaming')
  })

  it('declines (null) before the sentinel — caller fallback stays visible', () => {
    expect(fromCodexPartialPatchText('{"cmd":"apply')).toBeNull()
  })

  it('UNIFIED-EXEC wrapper: decodes a patch embedded in the exec script (caught live 2026-07-16)', () => {
    const script = 'const patch = "*** Begin Patch\\n*** Add File: temp/a.ts\\n+export const x = 1\\n*** End Patch";\nconst result = await tools.apply_patch(patch);'
    const decoded = decodeEmbeddedPatchLiteral(script)
    expect(decoded).toContain('*** Add File: temp/a.ts')
    const m = fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'exec', input: { cmd: script } } as never)
    expect(m).not.toBeNull()
    expect(m!.files[0].path).toBe('temp/a.ts')
    expect(m!.files[0].verb).toBe('Creating')
  })

  it('UNIFIED-EXEC wrapper: streaming prefix decodes the patch streamed so far', () => {
    const prefix = 'const patch = "*** Begin Patch\\n*** Update File: src/x.ts\\n-old\\n+new li'
    const m = fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'exec', input: { cmd: prefix } } as never, { streaming: true })
    expect(m).not.toBeNull()
    expect(m!.files[0].path).toBe('src/x.ts')
    expect(m!.status).toBe('streaming')
  })

  it('UNIFIED-EXEC wrapper: a plain command script declines (no false patch)', () => {
    const script = 'const r = await tools.exec_command({ cmd: "ls -la" });'
    expect(decodeEmbeddedPatchLiteral(script)).toBeNull()
    expect(fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'exec', input: { cmd: script } } as never)).toBeNull()
  })

  it('UNIFIED-EXEC wrapper: patch-looking literal without tools.apply_patch declines', () => {
    const script = 'const example = "*** Begin Patch\\n*** Add File: docs/example.txt\\n+demo\\n*** End Patch"; console.log(example);'
    expect(fromCodexApplyPatch({ type: 'tool_use', id: '', name: 'exec', input: { cmd: script } } as never)).toBeNull()
  })

  it('multi-file patches map file-per-file with honest verbs', () => {
    const m = fromCodexPartialPatchText(
      '*** Begin Patch\n*** Add File: b.txt\n+hello\n*** Update File: a.txt\n-1\n+2\n*** End Patch',
    )!
    expect(m.files.map(f => f.verb)).toEqual(['Creating', 'Editing'])
    expect(m.files[0].additions).toBe(1)
  })
})
