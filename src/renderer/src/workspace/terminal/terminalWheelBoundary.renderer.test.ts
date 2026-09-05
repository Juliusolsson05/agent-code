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

  it('lets xterm consume normal scrollback or provider mouse input first', () => {
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

  it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)('preserves modified gestures: %s', modifier => {
    const { screen } = mount()
    const event = wheel({ [modifier]: true })
    screen.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
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
