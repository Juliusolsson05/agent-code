import { afterEach, expect, it } from 'vitest'
import { AntigravityTerminalComposer } from './terminalComposer.js'

// Reconstruct the cursor, borders and text observed on agy 1.5.18 with its real
// native prompt. Only the paint mechanics are synthesized. Human typing, even
// whitespace, removes the shortcut hint; moving to column two leaves it removed.
const cols = 80
const rule = '─'.repeat(cols)
let composer: AntigravityTerminalComposer | undefined
afterEach(() => composer?.dispose())
function open() {
  return composer = new AntigravityTerminalComposer(cols, 20, () => {})
}
const paint = (lines: string[], x: number, y: number) =>
  '\x1b[?2004h\x1b[H\x1b[2J' + lines.join('\r\n') + '\x1b[' + y + ';' + x + 'H'
const ready = paint([rule, '> ', rule, '? for shortcuts'], 3, 2)
const draft = paint([rule, '> human draft', rule], 3, 2)

it('recognizes only a settled empty native prompt, including when typing is awaiting its echo', async () => {
  const c = open()
  expect(c.ready()).toBe(false)
  await c.output(ready)
  expect(c.ready()).toBe(true)
  c.input('\x7f')
  expect(c.ready()).toBe(true)
  c.input('\x08')
  expect(c.ready()).toBe(true)
  c.input('h')
  c.input('\x7f')
  expect(c.ready()).toBe(false)
  await c.output(ready)
  expect(c.ready()).toBe(false)
  await c.output(draft)
  expect(c.ready()).toBe(false)
  expect(c.occupied()).toBe(true)
  await c.output(ready)
  expect(c.ready()).toBe(true)
  for (const screen of [
    draft, paint([rule, '>  ', rule], 3, 2),
    paint([rule, '>', rule, '? for shortcuts', 'Allow this command?'], 3, 5),
    paint([rule, '>', rule, '? for shortcuts'], 1, 4),
    paint(['Sign in', '> ', '? for shortcuts'], 3, 2),
  ]) {
    await c.output(screen)
    expect(c.ready()).toBe(false)
  }
})

it('checks the complete editable content before Enter, including multiline and collapsed pastes', async () => {
  const c = open()
  await c.output(paint([rule, '> first', '  second', rule], 9, 3))
  expect(c.containsPaste('first\nsecond')).toBe(true)
  expect(c.containsPaste('second')).toBe(false)
  await c.output(paint([rule, '> [Pasted text #1 +100 lines]', rule], 30, 2))
  expect(c.containsPaste(Array(100).fill('long').join('\n'))).toBe(true)
  expect(c.containsPaste(Array(99).fill('long').join('\n'))).toBe(false)
  await c.output(paint([rule, '> [Pasted text #1 2600 chars]', rule], 30, 2))
  expect(c.containsPaste('🧪é'.repeat(1300))).toBe(true)
  expect(c.containsPaste('🧪é'.repeat(1299))).toBe(false)
  await c.output(paint([rule, '> our prompt and a human draft', rule], 13, 2))
  expect(c.containsPaste('our prompt')).toBe(false)
})
