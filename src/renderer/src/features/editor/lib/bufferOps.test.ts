import { describe, expect, it } from 'vitest'

import {
  hasRecoverableBufferChanges,
  isMissingRegularFileError,
  makeBuffer,
  withDiskObserved,
  withError,
  withTextUpdate,
  withWriteAcknowledged,
  withEditorReadError,
} from './bufferOps'

function buffer(text = 'base') {
  return makeBuffer({
    path: 'src/example.ts',
    absolutePath: '/repo/src/example.ts',
    fileName: 'example.ts',
    text,
    mtimeMs: 10,
    diskVersion: 'v1',
  })
}

describe('editor buffer transitions', () => {
  it('acknowledges exactly the written snapshot without erasing later typing', () => {
    const submitted = withTextUpdate(buffer(), 'submitted')
    const typedWhileSaving = withTextUpdate(submitted, 'submitted plus more')

    const result = withWriteAcknowledged(typedWhileSaving, 'submitted', 20, 'v2')

    expect(result.savedText).toBe('submitted')
    expect(result.currentText).toBe('submitted plus more')
    expect(result.dirty).toBe(true)
    expect(result.mtimeMs).toBe(20)
  })

  it('lets a clean buffer follow an observed disk version', () => {
    const result = withDiskObserved(buffer(), 'agent edit', 20, 'v2')

    expect(result.savedText).toBe('agent edit')
    expect(result.currentText).toBe('agent edit')
    expect(result.dirty).toBe(false)
    expect(result.mtimeMs).toBe(20)
  })

  it('does not regress a clean buffer when an older disk read finishes late', () => {
    const newer = withDiskObserved(buffer(), 'newer', 30, 'v3')

    expect(withDiskObserved(newer, 'older', 20, 'v2')).toBe(newer)
  })

  it('preserves a dirty baseline when disk diverges', () => {
    const dirty = withTextUpdate(buffer(), 'my edit')

    const result = withDiskObserved(dirty, 'agent edit', 20, 'v2')

    expect(result.savedText).toBe('base')
    expect(result.currentText).toBe('my edit')
    expect(result.mtimeMs).toBe(10)
    expect(result.conflict).toBe(true)
    expect(result.externalChange).toBe('changed')
  })

  it('does not invent a conflict when a dirty buffer observes its own baseline', () => {
    const dirty = withTextUpdate(buffer(), 'my edit')
    expect(withDiskObserved(dirty, 'base', 20, 'v2')).toMatchObject({
      currentText: 'my edit',
      savedText: 'base',
      dirty: true,
      mtimeMs: 20,
      conflict: false,
    })
  })

  it('becomes clean when another writer persists the exact in-memory edits', () => {
    const dirty = withTextUpdate(buffer(), 'shared edit')

    expect(withDiskObserved(dirty, 'shared edit', 20, 'v2')).toMatchObject({
      currentText: 'shared edit',
      savedText: 'shared edit',
      dirty: false,
      mtimeMs: 20,
      conflict: false,
      externalChange: null,
    })
  })

  it('clears a prior conflict when disk returns to the original baseline', () => {
    const dirty = withTextUpdate(buffer(), 'my edit')
    const conflicted = withDiskObserved(dirty, 'agent edit', 20, 'v2')
    expect(withDiskObserved(conflicted, 'base', 30, 'v3')).toMatchObject({
      currentText: 'my edit',
      savedText: 'base',
      mtimeMs: 30,
      conflict: false,
      externalChange: null,
      error: null,
    })
  })

  it('keeps an external conflict visible while the user continues editing', () => {
    const conflicted = withDiskObserved(withTextUpdate(buffer(), 'my edit'), 'agent edit', 20, 'v2')
    const result = withTextUpdate(conflicted, 'my newer edit')

    expect(result.conflict).toBe(true)
    expect(result.externalChange).toBe('changed')
    expect(result.error).toContain('changed on disk')
  })

  it('treats a clean externally deleted buffer as the last recoverable copy', () => {
    const deleted = withError(buffer(), 'file was deleted on disk', true, 'deleted')

    expect(deleted.dirty).toBe(false)
    expect(hasRecoverableBufferChanges(deleted)).toBe(true)
  })

  it('classifies every missing regular-file observation as recoverable', () => {
    for (const error of [
      'does not exist',
      'not a file',
      'is a directory',
      'not a directory',
      'watched path is no longer a regular file',
    ]) {
      expect(isMissingRegularFileError(error)).toBe(true)
      expect(withEditorReadError(buffer(), error)).toMatchObject({
        dirty: false,
        conflict: true,
        externalChange: 'deleted',
      })
    }
    expect(isMissingRegularFileError('permission denied')).toBe(false)
    expect(withEditorReadError(buffer(), 'permission denied')).toMatchObject({
      conflict: false,
      externalChange: null,
    })
  })
})
