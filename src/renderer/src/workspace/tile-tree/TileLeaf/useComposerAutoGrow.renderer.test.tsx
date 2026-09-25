import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerAutoGrow } from './useComposerAutoGrow'

// #1165: the composer collapsed to a clipped sliver. happy-dom has no layout
// engine, so these tests stub the layout reads the hook depends on:
// clientWidth ("is it laid out"), scrollHeight ("how tall does the draft want
// to be") and the observer's contentRect width ("how wide is the space the
// draft wraps into"). They drive ResizeObserver and requestAnimationFrame by
// hand. What they protect is the contract between those reads and the inline
// height, not the pixel result in a real browser.

type Layout = {
  /** clientWidth: content + padding. 0 means display:none. */
  width: number
  /** Horizontal padding. Dictation grows it without changing clientWidth. */
  paddingX: number
  contentHeight: number
}

type Subscription = { callback: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }
let subscriptions: Subscription[] = []

// Delivers only to observers that actually observe() the element. The first
// version of this fake called every constructed observer, so deleting the
// production observe() call left every resize test green (PR #1166 review).
class FakeResizeObserver {
  private readonly sub: Subscription
  constructor(callback: ResizeObserverCallback) {
    this.sub = { callback, targets: new Set(), self: this as unknown as ResizeObserver }
    subscriptions.push(this.sub)
  }
  observe(target: Element) {
    this.sub.targets.add(target)
  }
  unobserve(target: Element) {
    this.sub.targets.delete(target)
  }
  disconnect() {
    this.sub.targets.clear()
  }
}

let frames = new Map<number, FrameRequestCallback>()
let nextFrame = 1

function flushFrames() {
  const pending = [...frames.values()]
  frames = new Map()
  for (const cb of pending) cb(0)
}

function resize(el: HTMLTextAreaElement, layout: Layout) {
  const contentWidth = layout.width === 0 ? 0 : layout.width - layout.paddingX
  const entry = { target: el, contentRect: { width: contentWidth } } as unknown as ResizeObserverEntry
  act(() => {
    for (const sub of subscriptions) {
      if (sub.targets.has(el)) sub.callback([entry], sub.self)
    }
  })
}

function settle(el: HTMLTextAreaElement, layout: Layout) {
  resize(el, layout)
  act(() => flushFrames())
}

function makeTextarea(layout: Layout): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  // Mirrors ComposerInput's 1px border so the border-box correction is
  // exercised through getComputedStyle rather than assumed.
  el.style.borderTopWidth = '1px'
  el.style.borderBottomWidth = '1px'
  el.style.borderStyle = 'solid'
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => layout.width })
  // A display:none element reports scrollHeight 0 in a real browser. That's the
  // exact read that produced the collapsed `height: 0px`.
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => (layout.width === 0 ? 0 : layout.contentHeight),
  })
  document.body.appendChild(el)
  return el
}

function mount(el: HTMLTextAreaElement, value: string) {
  // One ref object for the hook's lifetime, like TileLeaf's inputRef. A fresh
  // `{ current: el }` per render re-runs the [ref]-keyed observer effect on every
  // rerender. That resets its recorded width and hides exactly the
  // hide/reveal bookkeeping these tests exist to check.
  const ref = { current: el }
  return renderHook(({ value }) => useComposerAutoGrow(ref, value), {
    initialProps: { value },
  })
}

describe('useComposerAutoGrow', () => {
  beforeEach(() => {
    subscriptions = []
    frames = new Map()
    nextFrame = 1
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrame++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('includes the border in the written height so a single line is not clipped', () => {
    const el = makeTextarea({ width: 300, paddingX: 32, contentHeight: 33 })
    mount(el, 'hi')
    expect(el.style.height).toBe('35px')
  })

  it('does not collapse the box when the draft changes while the workspace is hidden', () => {
    const layout = { width: 300, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    const { rerender } = mount(el, 'hi')
    expect(el.style.height).toBe('35px')

    // Reader Mode / Settings / editor fullscreen: still mounted, display:none.
    layout.width = 0
    rerender({ value: 'hi there' })
    expect(el.style.height).toBe('35px')
  })

  it('re-measures when a box mounted hidden is revealed', () => {
    const layout = { width: 0, paddingX: 32, contentHeight: 50 }
    const el = makeTextarea(layout)
    // e.g. the app restored with Settings open: no layout, so nothing may be
    // written yet.
    mount(el, 'a draft that wraps onto three lines')
    expect(el.style.height).toBe('')

    layout.width = 300
    settle(el, layout)
    expect(el.style.height).toBe('52px')
  })

  it('re-measures on reveal a draft that changed while hidden', () => {
    const layout = { width: 300, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    const { rerender } = mount(el, 'hi')
    // The initial notification a real observer delivers for a visible element.
    settle(el, layout)
    expect(el.style.height).toBe('35px')

    // Hiding notifies too (content box → 0). If that 0 isn't recorded, the
    // reveal below looks like "same width as before" and nothing re-measures.
    layout.width = 0
    settle(el, layout)
    layout.contentHeight = 67
    rerender({ value: 'hi, now with a much longer draft written from reader mode' })

    layout.width = 300
    settle(el, layout)
    expect(el.style.height).toBe('69px')
  })

  it('re-measures when a narrower pane re-wraps the same draft', () => {
    const layout = { width: 400, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    mount(el, 'we have this small UI issue')
    settle(el, layout)
    expect(el.style.height).toBe('35px')

    layout.width = 180
    layout.contentHeight = 67
    settle(el, layout)
    expect(el.style.height).toBe('69px')
  })

  it('re-measures when dictation widens the padding without changing clientWidth', () => {
    const layout = { width: 300, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    mount(el, 'a draft right at the wrap edge')
    settle(el, layout)
    expect(el.style.height).toBe('35px')

    // pr-2 → pr-16: the content box narrows by 56px and clientWidth doesn't move.
    layout.paddingX = 88
    layout.contentHeight = 50
    settle(el, layout)
    expect(el.style.height).toBe('52px')
  })

  it('writes the height a frame later, never inside the observer callback', () => {
    const layout = { width: 400, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    mount(el, 'hi')
    settle(el, layout)

    layout.width = 180
    layout.contentHeight = 67
    // Writing here, during delivery, is what raised Chromium's
    // "ResizeObserver loop" window error.
    resize(el, layout)
    expect(el.style.height).toBe('35px')
    act(() => flushFrames())
    expect(el.style.height).toBe('69px')
  })

  it('ignores the height-only notifications its own writes produce', () => {
    const layout = { width: 300, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    mount(el, 'hi')
    settle(el, layout)
    // If the observer re-measured without a width change, this sentinel would
    // be overwritten. That's the churn the width filter exists to avoid.
    el.style.height = '999px'
    settle(el, layout)
    expect(el.style.height).toBe('999px')
  })

  it('cancels a pending measurement on unmount', () => {
    const layout = { width: 400, paddingX: 32, contentHeight: 33 }
    const el = makeTextarea(layout)
    const { unmount } = mount(el, 'hi')
    layout.width = 180
    resize(el, layout)
    expect(frames.size).toBe(1)
    unmount()
    expect(frames.size).toBe(0)
  })
})
