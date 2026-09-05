import { describe, expect, it } from 'vitest'

import { aliasScreenSnapshotForWire, expandScreenSnapshotFromWire } from './session.js'

// #746: duplicate strings must not cross the renderer IPC edge, and the
// renderer must never observe the optional wire form.

describe('screen snapshot wire aliasing', () => {
  it('drops recent fields that duplicate the viewport and restores them on expand', () => {
    const frame = {
      sessionId: 's1',
      plain: 'viewport',
      markdown: 'viewport-md',
      recent: 'viewport',
      recentMarkdown: 'viewport-md',
      picker: { visible: false, items: [] },
    }
    const wire = aliasScreenSnapshotForWire(frame)
    expect('recent' in wire).toBe(false)
    expect('recentMarkdown' in wire).toBe(false)
    expect(wire.picker).toBe(frame.picker)
    expect(expandScreenSnapshotFromWire(wire)).toEqual(frame)
  })

  it('keeps a different recent window verbatim', () => {
    const frame = {
      plain: 'viewport',
      markdown: 'viewport-md',
      recent: 'scrollback\nviewport',
      recentMarkdown: 'scrollback-md\nviewport-md',
    }
    const wire = aliasScreenSnapshotForWire(frame)
    expect(wire.recent).toBe(frame.recent)
    expect(wire.recentMarkdown).toBe(frame.recentMarkdown)
    expect(expandScreenSnapshotFromWire(wire)).toEqual(frame)
  })

  it('aliases each field independently', () => {
    const frame = { plain: 'v', markdown: 'm', recent: 'v', recentMarkdown: 'older\nm' }
    const wire = aliasScreenSnapshotForWire(frame)
    expect('recent' in wire).toBe(false)
    expect(wire.recentMarkdown).toBe('older\nm')
    expect(expandScreenSnapshotFromWire(wire)).toEqual(frame)
  })
})
