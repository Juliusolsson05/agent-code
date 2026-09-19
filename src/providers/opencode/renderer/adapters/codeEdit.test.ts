import { describe, expect, it } from 'vitest'

import { fromOpencodeApplyPatch } from '@providers/opencode/renderer/adapters/codeEdit'

describe('OpenCode apply_patch adapter', () => {
  it('admits parseable direct patchText payloads', () => {
    expect(fromOpencodeApplyPatch({
      type: 'tool_use',
      id: 'patch-1',
      name: 'apply_patch',
      input: {
        patchText: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
      },
    })).toEqual(expect.objectContaining({
      label: 'apply_patch',
      status: 'running',
      partial: false,
    }))
  })

  it('declines malformed patch bodies back to the generic fallback', () => {
    expect(fromOpencodeApplyPatch({
      type: 'tool_use',
      id: 'patch-2',
      name: 'apply_patch',
      input: { patchText: '*** Begin Patch\nnot enough structure yet' },
    })).toBeNull()
  })
})
