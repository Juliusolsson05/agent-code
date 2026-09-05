import { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { attachXtermWebglRenderer } from '../../../src/renderer/src/workspace/terminal/xtermWebglRenderer'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))

// Pixel reads happen after paint, so preserve the test canvases' drawing buffer.
// The application still uses the default false; no product options are changed.
// Intercept only the public canvas factory, leaving the production loader and
// its version-specific invalidation path intact (a mock addon would miss it).
const getContext = HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getContext = function (type: string, options?: object) {
  return getContext.call(this, type as '2d', type === 'webgl2' ? { ...options, preserveDrawingBuffer: true } : options)
} as typeof getContext

let removedPages = 0
const removedCanvases = new WeakSet<HTMLCanvasElement>()
const activate = WebglAddon.prototype.activate
WebglAddon.prototype.activate = function (terminal) {
  // Shared terminals forward the same page removal. Count the page once, not
  // once per subscriber, so the report describes actual atlas churn.
  this.onRemoveTextureAtlasCanvas(canvas => {
    if (removedCanvases.has(canvas)) return
    removedCanvases.add(canvas)
    removedPages++
  })
  activate.call(this, terminal)
}

async function make(id: string, control: boolean, reference = false) {
  const terminal = new Terminal({
    cols: 90, rows: 35, fontSize: 13, cursorBlink: false, scrollback: 2000,
    // Identical font metrics, different cache key: the reference must NOT share
    // the tested atlas or a symmetric cache bug could make bad pixels agree.
    fontFamily: reference ? 'monospace, monospace' : 'monospace',
    theme: { background: '#17191d' },
  })
  terminal.open(document.getElementById(id)!)
  let renderer: ReturnType<typeof attachXtermWebglRenderer> | undefined
  if (control || reference) terminal.loadAddon(new WebglAddon())
  else {
    renderer = attachXtermWebglRenderer(terminal)
    if (!await renderer.ready) throw new Error('WebGL unavailable; this GPU check cannot run')
  }
  const canvas = [...terminal.element!.querySelectorAll('canvas')].find(candidate => candidate.getContext('webgl2'))
  if (!canvas) throw new Error('No WebGL canvas: fallback is not a passing GPU test')
  const gl = canvas.getContext('webgl2')!
  return { terminal, renderer, canvas, gl }
}

type Host = Awaited<ReturnType<typeof make>>

function pixels({ canvas, gl }: Host) {
  const data = new Uint8Array(canvas.width * canvas.height * 4)
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data)
  if (!data.some(channel => channel !== 0)) throw new Error('Blank GPU readback')
  return data
}

function difference(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) throw new Error('Reference dimensions differ')
  let count = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++
  return count
}

function viewportText(terminal: Terminal) {
  return Array.from({ length: terminal.rows }, (_, y) =>
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString()).join('\n')
}

async function checkRepaint(host: Host) {
  const before = pixels(host)
  const text = viewportText(host.terminal)
  host.terminal.refresh(0, host.terminal.rows - 1)
  await frame()
  if (text !== viewportText(host.terminal)) throw new Error('Buffer changed during pixel comparison')
  return difference(before, pixels(host))
}

// Synthetic ASCII/RGB only: no credentials, provider calls, user history, or
// private xterm fields. The repeatable workload forces cache layout changes,
// then verifies both frame stability and a fresh, independently cached oracle.
// The parent script owns the BrowserWindow and destroys it in finally on both
// success and failure, after capture. Keeping hosts alive until then lets the
// screenshot inspect the actual GPU renderer rather than its disposed fallback.
export async function run(control: boolean) {
  const a = await make('a', control)
  const b = await make('b', control)
  const differences: { step: number; kind: string; changed: number }[] = []
  await write(b.terminal, '\x1b[?25lFIXED HEADER\r\n')
  for (let step = 0; step < 40; step++) {
    let data = '\x1b[?25l'
    for (let y = 0; y < 35; y++) {
      for (let x = 0; x < 85; x++) {
        const k = step * 2975 + y * 85 + x
        data += `\x1b[38;2;${k % 256};${Math.floor(k / 256) % 256};${Math.floor(k / 65536) % 256}m\x1b[48;2;${y % 2 ? 80 : 0};${y % 2 ? 0 : 80};0m${String.fromCharCode(33 + k % 94)}`
      }
      data += '\x1b[0m\r\n'
    }
    await write(a.terminal, data)
    await frame()
    const changed = await checkRepaint(a)
    if (changed) differences.push({ step, kind: 'output', changed })
    await write(b.terminal, `\x1b[3;1Hupdate ${step}`)
    await frame()
    const sharedChanged = await checkRepaint(b)
    if (sharedChanged) differences.push({ step, kind: 'shared', changed: sharedChanged })
  }
  for (let step = 0; step < 40; step++) {
    a.terminal.scrollLines(-11)
    await frame()
    const changed = await checkRepaint(a)
    if (changed) differences.push({ step, kind: 'scroll', changed })
  }
  const before = pixels(a)
  const expectedText = viewportText(a.terminal)
  const referenceElement = document.createElement('div')
  referenceElement.id = 'reference'
  referenceElement.style.position = 'absolute'
  document.body.appendChild(referenceElement)
  const reference = await make('reference', true, true)
  let visible = '\x1b[?25l'
  for (let y = 0; y < a.terminal.rows; y++) {
    const line = a.terminal.buffer.active.getLine(a.terminal.buffer.active.viewportY + y)!
    for (let x = 0; x < a.terminal.cols; x++) {
      const cell = line.getCell(x)!
      const fg = cell.getFgColor(), bg = cell.getBgColor()
      visible += '\x1b[0m'
      if (cell.isFgRGB()) visible += `\x1b[38;2;${fg >>> 16};${fg >>> 8 & 255};${fg & 255}m`
      if (cell.isBgRGB()) visible += `\x1b[48;2;${bg >>> 16};${bg >>> 8 & 255};${bg & 255}m`
      visible += cell.getChars() || ' '
    }
    if (y < a.terminal.rows - 1) visible += '\r\n'
  }
  await write(reference.terminal, visible)
  await frame()
  if (viewportText(reference.terminal) !== expectedText) throw new Error('Reference buffer differs')
  const referenceDifference = difference(before, pixels(reference))
  // Keep the tested surface, not its oracle, visible for the screenshot.
  referenceElement.style.visibility = 'hidden'
  return { control, removedPages, differences, referenceDifference, viewport: a.terminal.buffer.active.viewportY }
}
