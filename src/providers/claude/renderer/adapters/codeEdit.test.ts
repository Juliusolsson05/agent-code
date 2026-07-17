import { describe, expect, it } from 'vitest'

import {
  extractJsonStringField,
  fromClaudeEditBlock,
  fromClaudePartialEditJson,
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

  it('escape torn mid-stream is tolerated, never thrown', () => {
    const r = extractJsonStringField('{"file_path":"/a\\', 'file_path')
    expect(r).toEqual({ value: '/a', closed: false })
  })

  it('committed blocks map completely: Edit diff, MultiEdit per-edit files, Write additions', () => {
    const edit = fromClaudeEditBlock({
      type: 'tool_use', id: 't1', name: 'Edit',
      input: { file_path: '/a.ts', old_string: 'a\nb', new_string: 'a\nc' },
    } as never)!
    expect(edit.files[0].deletions).toBe(1)
    expect(edit.files[0].additions).toBe(1)
    expect(edit.status).toBe('success')
    const multi = fromClaudeEditBlock({
      type: 'tool_use', id: 't2', name: 'MultiEdit',
      input: { file_path: '/a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] },
    } as never)!
    expect(multi.files).toHaveLength(2)
    expect(fromClaudeEditBlock({ type: 'tool_use', id: 't3', name: 'Bash', input: {} } as never)).toBeNull()
  })

  it('bounds huge Write and MultiEdit models before they reach the DOM', () => {
    const content = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n')
    const write = fromClaudeEditBlock({
      type: 'tool_use', id: 'tw', name: 'Write', input: { file_path: '/huge.ts', content },
    } as never)!
    expect(write.files[0].lines.length).toBeLessThanOrEqual(400)
    expect(write.files[0].previewTruncated).toBe(true)
    expect(write.files[0].exactSections?.[0]?.text).toBe(content)

    const edits = Array.from({ length: 100 }, (_, index) => ({ old_string: `${index}`, new_string: `${index + 1}` }))
    const multi = fromClaudeEditBlock({
      type: 'tool_use', id: 'tm', name: 'MultiEdit', input: { file_path: '/many.ts', edits },
    } as never)!
    expect(multi.files).toHaveLength(24)
    expect(multi.totalFiles).toBe(100)
    expect(multi.filesTruncated).toBe(true)
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
