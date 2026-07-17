import { describe, expect, it } from 'vitest'

import { hasRecoverableBufferChanges, makeBuffer } from '@renderer/features/editor/lib/bufferOps'
import { withAiWorkspaceReadError } from './aiWorkspaceBufferOps'

function cleanBuffer() {
  return makeBuffer({
    path: 'entry-id',
    absolutePath: '/repo/file.ts',
    fileName: 'file.ts',
    text: 'last in-memory copy',
    mtimeMs: 1,
    diskVersion: 'v1',
  })
}

describe('withAiWorkspaceReadError', () => {
  it('makes a clean buffer recoverable when its regular file disappears', () => {
    const deleted = withAiWorkspaceReadError(cleanBuffer(), 'does not exist')

    expect(deleted).toMatchObject({
      dirty: false,
      conflict: true,
      externalChange: 'deleted',
    })
    expect(hasRecoverableBufferChanges(deleted)).toBe(true)
  })

  it('does not describe a permission failure as deletion', () => {
    const denied = withAiWorkspaceReadError(cleanBuffer(), 'permission denied')

    expect(denied).toMatchObject({
      conflict: false,
      externalChange: null,
    })
    expect(hasRecoverableBufferChanges(denied)).toBe(false)
  })
})
