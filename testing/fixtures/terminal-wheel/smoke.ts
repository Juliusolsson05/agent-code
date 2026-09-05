import { Terminal } from '@xterm/xterm'
import { attachXtermWebglRenderer } from '../../../src/renderer/src/workspace/terminal/xtermWebglRenderer'
import { attachTerminalWheelBoundary } from '../../../src/renderer/src/workspace/terminal/terminalWheelBoundary'

let terminal: Terminal
const writes: string[] = []
export const settle = () => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve))

// Synthetic text only. The parent process owns an isolated BrowserWindow and
// destroys it after capture; never attach this probe to an actual provider PTY.
export async function setup(control: boolean) {
  const host = document.getElementById('host')!
  terminal = new Terminal({ cols: 80, rows: 20, fontSize: 13, cursorBlink: false })
  terminal.open(host)
  if (!control) attachTerminalWheelBoundary(host)
  if (!await attachXtermWebglRenderer(terminal).ready) throw Error('WebGL unavailable')
  terminal.onData(data => writes.push(data))
  await write(Array.from({ length: 400 }, (_, i) => 'line ' + i + '\r\n').join(''))
  terminal.focus()
  await settle()
  return state()
}
export function state() {
  const buffer = terminal.buffer.active
  return {
    type: buffer.type, top: buffer.viewportY, base: buffer.baseY,
    first: buffer.getLine(buffer.viewportY)?.translateToString(true),
    outer: document.getElementById('outer')!.scrollTop, writes: [...writes],
  }
}

export async function append() {
  await write(Array.from({ length: 20 }, (_, i) => 'new ' + i + '\r\n').join(''))
  await settle()
  return state()
}

export async function alternate(mouse = false) {
  await write('\x1b[?1049h' + (mouse ? '\x1b[?1000h\x1b[?1006h' : '') + 'ALTERNATE')
  writes.length = 0
  await settle()
  return state()
}

export async function bottom() {
  terminal.scrollToBottom()
  await settle()
  return state()
}
