// WHY these tests stand in for xterm with plain DOM listeners instead of
// opening the real pinned @xterm/xterm. The PR #792 review asked for
// real-xterm coverage (consumed scrollback, an unconsumed boundary, alternate-
// screen arrows, SGR mouse reports, Alt fast scroll). A throwaway probe on
// 2026-09-12 showed this project's happy-dom cannot host it:
// - No canvas: happy-dom's `getContext('2d')` returns null. xterm
//   6.1.0-beta.304 `open()` creates its DOM renderer, whose WidthCache passes
//   that context to `throwIfFalsy`, so `open()` throws "value must not be
//   falsy". It has already appended `.xterm`, but it has not yet created the
//   Viewport or bound MouseService. In the probe every wheel went uncanceled
//   and no arrow or SGR data was sent, because no xterm wheel listener
//   existed, not because xterm refused the event.
// - No layout: even past that, offsetWidth/offsetHeight and bounding rects
//   are 0. CharSizeService measures 0x0, so cell height and scrollHeight are
//   0 and the viewport can never move ("xterm consumed normal scrollback" is
//   unreachable). MouseCoordsService also yields no report coordinates, so
//   no SGR report is sent.
// Faking a 2D context, glyph metrics and rects would make each assertion echo
// the fake numbers rather than xterm or Chromium. Green results would then
// look like real-xterm coverage without being it.
// So this file pins only the helper's own contract: bubble-phase
// registration, which unconsumed events it cancels, and disposal. The
// real-xterm, real-Chromium oracle is the user-run
// scripts/smoke-terminal-wheel.mjs. The xterm-facing claims are
// source-verified in terminalWheelBoundary.ts and must be re-checked on every
// xterm bump. If the repo gains a real browser test runner, a real-xterm
// version of these cases belongs there.
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
  // Whether the real xterm consumes a given wheel is not modeled here (see the
  // header of this file for why that cannot be done in happy-dom).
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

  it.each(['ctrlKey', 'metaKey', 'shiftKey'] as const)('preserves browser-owned modified gestures: %s', modifier => {
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
