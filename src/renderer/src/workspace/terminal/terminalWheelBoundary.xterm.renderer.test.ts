import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { attachTerminalWheelBoundary } from './terminalWheelBoundary'

// WHY this file exists next to terminalWheelBoundary.renderer.test.ts: that
// file pins the helper's own contract with plain DOM stand-ins, so it stays
// green even if the pinned @xterm/xterm changes which wheels it consumes. This
// file opens the REAL installed (and locally patched) xterm, attaches the
// helper exactly as production does (on the host, right after `open()`), and
// asserts what actually happens to a wheel: xterm consumes scrollback it can
// move, the pinned xterm leaves an exhausted wheel unconsumed and only the
// helper cancels it, Alt is a faster scroll, the alternate screen turns the
// wheel into an arrow key, and mouse reporting turns it into an SGR report.
// A failure here after an xterm bump is the signal to re-read the WHEN
// BUMPING XTERM note in terminalWheelBoundary.ts.
//
// WHY three shims, and why the assertions do not echo them. Unshimmed happy-dom
// cannot host xterm. `getContext('2d')` returns null, so `open()` throws in
// the DOM renderer's WidthCache before the Viewport or MouseService exist.
// It also has no layout, so the char-measure span reports 0x0 and every cell
// and scroll dimension is 0 (PR #792 review round 1 stopped there). The shims
// below supply only that missing browser environment:
// 1. A 2D context exposing the two members WidthCache touches (`font` and
//    `measureText().width`). It returns a constant glyph width.
// 2. A fixed size for xterm's `.xterm-char-measure-element` span, which
//    CharSizeService's DOM strategy reads. happy-dom has no OffscreenCanvas,
//    so the DOM strategy is the one xterm picks.
// 3. Explicit 0px left/top padding on `.xterm-screen`, which a browser
//    computes from xterm.css. happy-dom's computed style returns '' for unset
//    padding, and MouseCoordsService parseInt()s it into NaN.
// Separately, happy-dom's WheelEvent extends UIEvent rather than MouseEvent,
// so it lacks the modifier and clientX/clientY fields every browser WheelEvent
// carries; `wheel()` below sets them explicitly. Either gap yields
// `ESC[<64;NaN;NaNM` instead of a real report, a happy-dom artifact rather
// than an xterm bug. The first real run had both gaps, and a run with only the
// padding shim still got NaN from the missing clientX. That unset padding alone
// also yields NaN comes from reading happy-dom's computed style (it has no
// default padding) and was not observed on its own.
// Everything asserted is computed by xterm itself from real WheelEvents:
// - StandardWheelEvent delta normalization;
// - the `fastScrollSensitivity` Alt multiplier;
// - ScrollState clamping and the consume decision in `_handleMouseWheel`;
// - listener order under `.xterm`;
// - buffer switching and escape parsing;
// - MouseService arrow conversion and SGR encoding.
// No expected value is derived from the fake sizes. Assertions are relative
// (Alt moves farther than plain; an exhausted wheel does not move) or semantic
// (defaultPrevented, whether the event propagated to the parent, the exact
// bytes xterm sends). Any positive glyph size yields the same outcomes.
//
// What this file deliberately does NOT cover:
// - Chromium's native scroll chaining. happy-dom has no default scroll
//   action, so `defaultPrevented` is only a proxy for "the panel would not
//   move".
// - Wheel latching and cancelability of later events in a gesture.
// - The WebGL renderer and real font metrics.
// The user-run Electron probe (scripts/smoke-terminal-wheel.mjs) remains the
// oracle for those. Do not read a green run here as proof of them.

const GLYPH_WIDTH_PX = 8
const GLYPH_HEIGHT_PX = 16
// xterm's DomMeasureStrategy divides the span's width by its repeat count (32
// in 6.1.0-beta.304). If that constant changes, the glyph width changes but no
// assertion depends on it.
const MEASURE_SPAN_REPEAT = 32

const restoreShims: (() => void)[] = []
const mounted: { term: Terminal; parent: HTMLElement }[] = []

function installBrowserShims(): void {
  const canvasPrototype = HTMLCanvasElement.prototype
  const originalGetContext = canvasPrototype.getContext
  const fakeContext = { font: '', measureText: () => ({ width: GLYPH_WIDTH_PX }) }
  canvasPrototype.getContext = function (this: HTMLCanvasElement, contextId: string) {
    return contextId === '2d' ? fakeContext : originalGetContext.call(this, contextId as '2d')
  } as unknown as typeof canvasPrototype.getContext
  restoreShims.push(() => { canvasPrototype.getContext = originalGetContext })

  const sizes = [['offsetWidth', GLYPH_WIDTH_PX * MEASURE_SPAN_REPEAT], ['offsetHeight', GLYPH_HEIGHT_PX]] as const
  for (const [property, size] of sizes) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)
    if (!original?.get) throw new Error(`happy-dom no longer defines HTMLElement.${property} as a getter`)
    const originalGet = original.get
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('xterm-char-measure-element') ? size : originalGet.call(this)
      },
    })
    restoreShims.push(() => Object.defineProperty(HTMLElement.prototype, property, original))
  }
}

beforeEach(installBrowserShims)
afterEach(() => {
  for (const { term, parent } of mounted.splice(0)) {
    term.dispose()
    parent.remove()
  }
  for (const restore of restoreShims.splice(0).reverse()) restore()
})

// happy-dom runs requestAnimationFrame callbacks on setImmediate in FIFO
// order, so one frame flushes the Viewport sync that xterm queued earlier.
// These are ordering waits, not timeouts.
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const write = (term: Terminal, data: string) => new Promise<void>(resolve => term.write(data, resolve))

async function mountTerminal() {
  // `parent` plays the surrounding panel (DebugPanel in #791). A wheel xterm
  // consumes calls stopPropagation and never reaches it; an unconsumed wheel
  // does, whether or not the boundary canceled its default.
  const parent = document.createElement('div')
  const host = document.createElement('div')
  parent.appendChild(host)
  document.body.appendChild(parent)
  const term = new Terminal({ cols: 40, rows: 10, scrollback: 1000 })
  mounted.push({ term, parent })
  const data: string[] = []
  term.onData(chunk => data.push(chunk))
  const reachedParent: WheelEvent[] = []
  parent.addEventListener('wheel', event => reachedParent.push(event))
  term.open(host)
  const boundary = attachTerminalWheelBoundary(host)
  await write(term, Array.from({ length: 300 }, (_, line) => `line ${line}\r\n`).join(''))
  await nextFrame()
  const screen = host.querySelector<HTMLElement>('.xterm-screen')
  if (!screen) throw new Error('xterm did not create its screen element')
  // Shim 3 (see header): give MouseCoordsService the padding a browser computes.
  screen.style.paddingLeft = '0px'
  screen.style.paddingTop = '0px'
  return { term, screen, data, reachedParent, boundary }
}

async function scrollTo(term: Terminal, line: number): Promise<void> {
  term.scrollToLine(line)
  // xterm's scrollable state follows the buffer on the next frame. Wheel math
  // reads that state, so a wheel sent before the frame would use a stale
  // position.
  await nextFrame()
}

// A whole-notch pixel wheel. Its |deltaY| is at least 50, so MouseService does
// not treat it as a trackpad. clientX/clientY fall inside the first cells.
function wheel(target: Element, deltaY: number, { altKey = false } = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY })
  // happy-dom's WheelEvent extends UIEvent, not MouseEvent, so the modifier and
  // pointer fields a browser WheelEvent always has are missing. Set them
  // explicitly: xterm's fast-scroll branch reads altKey, and MouseCoordsService
  // reads clientX/clientY to place the SGR report.
  const fields = { ctrlKey: false, metaKey: false, shiftKey: false, altKey, clientX: 20, clientY: 20 }
  for (const [field, value] of Object.entries(fields)) Object.defineProperty(event, field, { value })
  target.dispatchEvent(event)
  return event
}

describe('terminal wheel boundary on the real pinned xterm', () => {
  it('lets xterm consume plain and Alt scrollback it can move, with Alt moving farther', async () => {
    const { term, screen, data, reachedParent } = await mountTerminal()
    const middle = Math.floor(term.buffer.active.baseY / 2)
    const scrollUpFromMiddle = async (altKey: boolean) => {
      await scrollTo(term, middle)
      const event = wheel(screen, -120, { altKey })
      return { event, lines: middle - term.buffer.active.viewportY }
    }
    const plain = await scrollUpFromMiddle(false)
    const alt = await scrollUpFromMiddle(true)

    expect(plain.lines).toBeGreaterThan(0)
    expect(alt.lines).toBeGreaterThan(plain.lines)
    expect([plain.event.defaultPrevented, alt.event.defaultPrevented]).toEqual([true, true])
    // xterm itself consumed both, so neither reached the boundary or the panel.
    expect(reachedParent).toHaveLength(0)
    expect(data).toEqual([])
  })

  it.each([
    { edge: 'top', deltaY: -120 },
    { edge: 'bottom', deltaY: 120 },
  ])('cancels exhausted plain and Alt wheels at the $edge that xterm itself leaves unconsumed', async ({ edge, deltaY }) => {
    const { term, screen, data, reachedParent, boundary } = await mountTerminal()
    await scrollTo(term, edge === 'top' ? 0 : term.buffer.active.baseY)
    const atEdge = term.buffer.active.viewportY
    const exhaust = () => [false, true].map(altKey => wheel(screen, deltaY, { altKey }).defaultPrevented)

    expect(exhaust()).toEqual([true, true])
    // No-helper control. If the pinned xterm starts consuming exhausted wheels
    // itself, this fails, and the helper is redundant: delete it rather than
    // stacking two owners.
    boundary.dispose()
    expect(exhaust()).toEqual([false, false])

    // All four were unconsumed by xterm: they reached the panel and neither
    // moved the viewport nor produced PTY input.
    expect(reachedParent).toHaveLength(4)
    expect(term.buffer.active.viewportY).toBe(atEdge)
    expect(data).toEqual([])
  })

  it('hands an alternate-screen wheel to xterm as an arrow key before the boundary sees it', async () => {
    const { term, screen, data, reachedParent } = await mountTerminal()
    await write(term, '\x1b[?1049h')
    await nextFrame()
    data.length = 0

    const event = wheel(screen, -120)

    expect(data).toEqual(['\x1b[A'])
    expect(event.defaultPrevented).toBe(true)
    expect(reachedParent).toHaveLength(0)
  })

  it('hands a mouse-reporting wheel to xterm as one SGR report before the boundary sees it', async () => {
    const { term, screen, data, reachedParent } = await mountTerminal()
    await write(term, '\x1b[?1049h\x1b[?1000h\x1b[?1006h')
    await nextFrame()
    data.length = 0

    const event = wheel(screen, -120)

    expect(data).toHaveLength(1)
    expect(data[0]).toMatch(/^\x1b\[<64;\d+;\d+M$/)
    expect(event.defaultPrevented).toBe(true)
    expect(reachedParent).toHaveLength(0)
  })
})
