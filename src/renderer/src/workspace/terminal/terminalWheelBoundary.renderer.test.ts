// WHY plain DOM stand-ins here instead of the real @xterm/xterm. This file pins
// the helper's OWN contract, independent of xterm internals:
// - bubble-phase registration;
// - exactly which unconsumed events it cancels (modifier, axis, consumed and
//   non-cancelable policy);
// - disposal.
// What the real pinned xterm does with a wheel lives in
// terminalWheelBoundary.xterm.renderer.test.ts: consuming movable scrollback,
// leaving an exhausted wheel unconsumed, Alt fast scroll, alternate-screen
// arrows and SGR mouse reports. That file opens xterm under two narrow
// happy-dom shims; its header says what they fake and why its assertions do
// not echo them.
// Neither file can observe Chromium's native scroll chaining, wheel latching or
// WebGL. The user-run scripts/smoke-terminal-wheel.mjs is the oracle for those.
//
// History: review round 1 of PR #792 recorded real-xterm coverage as
// infeasible. Unshimmed happy-dom does make `open()` throw (null 2D context
// in xterm's WidthCache) and has no layout. Round 2 showed that a fake 2D
// context plus a fixed glyph size is enough, because every asserted behavior
// is still computed by xterm itself.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalWheelBoundary } from './terminalWheelBoundary'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function mount() {
  const parent = document.createElement('div')
  const host = document.createElement('div')
  const screen = document.createElement('div')
  parent.appendChild(host)
  host.appendChild(screen)
  document.body.appendChild(parent)
  const boundary = attachTerminalWheelBoundary(host)
  cleanups.push(() => { boundary.dispose(); parent.remove() })
  return { parent, screen, boundary }
}

function wheel(options: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, ...options })
  // happy-dom's WheelEvent omits MouseEvent modifier initialization. Model the
  // native event fields explicitly; the real Chromium probe separately checks
  // default scrolling so this DOM shim cannot bless broken browser behavior.
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
    Object.defineProperty(event, modifier, { value: options[modifier] ?? false })
  }
  return event
}

describe('terminal wheel boundary', () => {
  it.each([-120, 120])('cancels exhausted vertical scrolling (%s) without suppressing engagement', deltaY => {
    const { parent, screen } = mount()
    const engagement = vi.fn()
    parent.addEventListener('wheel', engagement)
    const event = wheel({ deltaY })
    screen.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(engagement).toHaveBeenCalledOnce()
  })

  // Pins bubble-phase registration only: the stand-in listener below plays
  // xterm's part, so it must see the event before the boundary has touched it.
  // Whether the real xterm consumes a given wheel is not modeled here; that is
  // terminalWheelBoundary.xterm.renderer.test.ts's job.
  it('registers in the bubble phase so xterm decides before the boundary', () => {
    const { screen } = mount()
    const provider = vi.fn((event: Event) => {
      expect(event.defaultPrevented).toBe(false)
      event.preventDefault()
      event.stopPropagation()
    })
    screen.addEventListener('wheel', provider)
    screen.dispatchEvent(wheel())
    expect(provider).toHaveBeenCalledOnce()
  })

  // Policy, not xterm behavior: xterm may already have consumed these as
  // scrollback. The helper only declines to cancel an UNCONSUMED Ctrl/Meta/Shift
  // wheel, leaving pinch-zoom, navigation and horizontal intent to the browser.
  it.each(['ctrlKey', 'metaKey', 'shiftKey'] as const)('leaves an unconsumed %s wheel to the browser', modifier => {
    const { screen } = mount()
    const event = wheel({ [modifier]: true })
    screen.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  // Regression for the PR #792 review: Alt+wheel is xterm's fast-scroll
  // gesture (fastScrollSensitivity), and at a boundary xterm leaves it
  // unconsumed exactly like a plain wheel. Exempting Alt let a fast scroll that
  // hit the top or bottom move the surrounding panel.
  it.each([-120, 120])('contains an exhausted Alt fast scroll (%s) like a plain wheel', deltaY => {
    const { screen } = mount()
    const event = wheel({ deltaY, altKey: true })
    screen.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it.each([{ deltaY: 0, deltaX: 120 }, { deltaY: 10, deltaX: -120 }, { deltaY: 0, deltaX: 0 }])(
    'does not claim horizontal or empty gestures (%j)', options => {
      const { screen } = mount()
      const event = wheel(options)
      screen.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    },
  )

  it('does not interfere with an already consumed or non-cancelable event', () => {
    const { screen } = mount()
    const consumed = wheel()
    consumed.preventDefault()
    const prevent = vi.spyOn(consumed, 'preventDefault')
    screen.dispatchEvent(consumed)
    expect(prevent).not.toHaveBeenCalled()
    const nonCancelable = wheel({ cancelable: false })
    screen.dispatchEvent(nonCancelable)
    expect(nonCancelable.defaultPrevented).toBe(false)
  })

  it('releases the old host without detaching another terminal', () => {
    const old = mount()
    const current = mount()
    old.boundary.dispose()
    old.boundary.dispose()
    const oldWheel = wheel()
    old.screen.dispatchEvent(oldWheel)
    expect(oldWheel.defaultPrevented).toBe(false)
    const currentWheel = wheel()
    current.screen.dispatchEvent(currentWheel)
    expect(currentWheel.defaultPrevented).toBe(true)
  })
})
