import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useComposerAutoGrow } from './useComposerAutoGrow'

// #1165: the composer collapsed to a clipped sliver. happy-dom has no layout
// engine, so these tests stub the two layout reads the hook depends on
// (clientWidth = "is it laid out, and how wide", scrollHeight = "how tall does
// the draft want to be") and drive the ResizeObserver by hand. What they
// protect is the contract between those reads and the inline height, not the
// pixel result in a real browser.

type Layout = { width: number; contentHeight: number }

let observers: Array<{ callback: ResizeObserverCallback; target: Element | null }> = []

class FakeResizeObserver {
  private readonly entry: { callback: ResizeObserverCallback; target: Element | null }
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, target: null }
    observers.push(this.entry)
  }
  observe(target: Element) {
    this.entry.target = target
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter(o => o !== this.entry)
  }
}

function fireResize() {
  for (const o of observers) o.callback([], o as unknown as ResizeObserver)
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

describe('useComposerAutoGrow', () => {
  beforeEach(() => {
    observers = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('includes the border in the written height so a single line is not clipped', () => {
    const el = makeTextarea({ width: 300, contentHeight: 33 })
    renderHook(({ value }) => useComposerAutoGrow({ current: el }, value), {
      initialProps: { value: 'hi' },
    })
    expect(el.style.height).toBe('35px')
  })

  it('does not collapse the box when the draft changes while the workspace is hidden', () => {
    const layout = { width: 300, contentHeight: 33 }
    const el = makeTextarea(layout)
    const { rerender } = renderHook(({ value }) => useComposerAutoGrow({ current: el }, value), {
      initialProps: { value: 'hi' },
    })
    expect(el.style.height).toBe('35px')

    // Reader Mode / Settings / editor fullscreen: still mounted, display:none.
    layout.width = 0
    rerender({ value: 'hi there' })
    expect(el.style.height).toBe('35px')
  })

  it('re-measures when the hidden workspace is revealed', () => {
    const layout = { width: 0, contentHeight: 50 }
    const el = makeTextarea(layout)
    // Mounted hidden (e.g. the app restored with Settings open): no layout,
    // so nothing may be written yet.
    renderHook(({ value }) => useComposerAutoGrow({ current: el }, value), {
      initialProps: { value: 'a draft that wraps onto three lines' },
    })
    expect(el.style.height).toBe('')

    layout.width = 300
    act(() => fireResize())
    expect(el.style.height).toBe('52px')
  })

  it('re-measures when a narrower pane re-wraps the same draft', () => {
    const layout = { width: 400, contentHeight: 33 }
    const el = makeTextarea(layout)
    renderHook(({ value }) => useComposerAutoGrow({ current: el }, value), {
      initialProps: { value: 'we have this small UI issue' },
    })
    expect(el.style.height).toBe('35px')

    layout.width = 180
    layout.contentHeight = 67
    act(() => fireResize())
    expect(el.style.height).toBe('69px')
  })

  it('ignores the height-only notifications its own writes produce', () => {
    const layout = { width: 300, contentHeight: 33 }
    const el = makeTextarea(layout)
    renderHook(({ value }) => useComposerAutoGrow({ current: el }, value), {
      initialProps: { value: 'hi' },
    })
    // If the observer re-measured without a width change, this sentinel would
    // be overwritten. That's the feedback loop the width filter exists to break.
    el.style.height = '999px'
    act(() => fireResize())
    expect(el.style.height).toBe('999px')
  })
})
