import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The marker's single source of truth is the patch script. Read it out of the
// script's source rather than importing it: the script is plain Node ESM run by
// `postinstall` (no TypeScript, no devDependencies), and importing it here
// would drag an untyped .mjs into the web type-check project.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const XTERM_RESIZE_FLUSH_PATCH_MARKER = readFileSync(join(repoRoot, 'scripts/patch-xterm.mjs'), 'utf8')
  .match(/export const XTERM_RESIZE_FLUSH_PATCH_MARKER = '([^']+)'/)?.[1] ?? '<marker not found in scripts/patch-xterm.mjs>'

// Guard for the local @xterm/xterm patch applied by scripts/patch-xterm.mjs
// (postinstall). Read that script's header for the full story; in short:
//
// The pinned 6.1.0 beta line's `CoreTerminal.resize()` calls
// `WriteBuffer.flushSync()` (upstream bf7c95b6 / xterm.js #5599), and
// `flushSync` drains from index 0 with a truthiness loop. That re-parses
// chunks the async writer already applied (duplicated output, write callbacks
// fired twice) and stops at an empty-string chunk, discarding everything queued
// after it (lost output, callbacks that never fire). Known upstream as part of
// xterm.js #6154. Our patch removes the flush from `resize()`, restoring the
// stable 6.0.0 resize semantics this app ran on for months.
//
// These cases exercise the REAL installed bundles — both of them, because
// Node/CommonJS consumers load `main` (lib/xterm.js) while Vite and the
// renderer build load `module` (lib/xterm.mjs). Each case fails on the
// unpatched beta and passes on 6.0.0 and on the patched beta, so if a future
// bump drops or breaks the patch, this file is what goes red.

const require_ = createRequire(import.meta.url)
const xtermDir = dirname(require_.resolve('@xterm/xterm/package.json'))

type XtermModule = { Terminal: new (options: Record<string, unknown>) => XtermLike }
type XtermLike = {
  write(data: string, callback?: () => void): void
  resize(cols: number, rows: number): void
  dispose(): void
  buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } }
}

const bundles: Array<{ name: string; load: () => Promise<XtermModule> }> = [
  { name: 'lib/xterm.mjs (module — what Vite and the renderer bundle load)', load: () => import(join(xtermDir, 'lib/xterm.mjs')) as Promise<XtermModule> },
  { name: 'lib/xterm.js (main — what CommonJS consumers load)', load: async () => require_(join(xtermDir, 'lib/xterm.js')) as XtermModule },
]

function visibleLines(term: XtermLike): string[] {
  const out: string[] = []
  for (let i = 0; i < term.buffer.active.length; i++) {
    const text = term.buffer.active.getLine(i)?.translateToString(true) ?? ''
    if (text) out.push(text)
  }
  return out
}

// Resolves once everything written before it has been parsed. The sentinel is
// deliberately NON-empty: on the unpatched beta an empty write can be dropped
// by flushSync and never call back. Bounded so a regression fails the case
// instead of hanging the suite.
function drained(term: XtermLike): Promise<boolean> {
  return Promise.race([
    new Promise<boolean>(resolve => term.write('\x1b[0m', () => resolve(true))),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
  ])
}

describe('local @xterm/xterm resize-flush patch', () => {
  it('is applied to both shipped bundles', () => {
    for (const file of ['lib/xterm.mjs', 'lib/xterm.js']) {
      const source = readFileSync(join(xtermDir, file), 'utf8')
      expect(source, `${file} is missing the patch marker — run \`node scripts/patch-xterm.mjs\``).toContain(XTERM_RESIZE_FLUSH_PATCH_MARKER)
      expect(source, `${file} still flushes the write queue inside resize()`).not.toMatch(/resize\([^)]*\)\{[^}]*_writeBuffer\.flushSync\(\)/)
    }
  })

  describe.each(bundles)('$name', ({ load }) => {
    it('does not replay the in-flight chunk when a write callback resizes', async () => {
      const { Terminal } = await load()
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      let firstCalls = 0
      // A write callback runs inside the parse loop BEFORE the loop advances
      // its offset; the unpatched flush drained from index 0 and re-applied
      // this very chunk, firing this callback a second time.
      term.write('FIRST\r\n', () => {
        firstCalls++
        if (firstCalls === 1) term.resize(81, 24)
      })
      term.write('SECOND\r\n')

      expect(await drained(term)).toBe(true)
      expect(visibleLines(term)).toEqual(['FIRST', 'SECOND'])
      expect(firstCalls).toBe(1)
      term.dispose()
    })

    it('does not drop output queued behind an empty write when a resize flushes', async () => {
      const { Terminal } = await load()
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      const calls = { empty: 0, second: 0 }
      term.write('A\r\n')
      term.write('', () => { calls.empty++ })
      term.write('B\r\n', () => { calls.second++ })
      // The unpatched flush looped `while (chunk = shift())`, stopped at the
      // empty chunk, then cleared the queue: B was never parsed and neither
      // callback ever fired.
      term.resize(81, 24)

      expect(await drained(term)).toBe(true)
      expect(visibleLines(term)).toEqual(['A', 'B'])
      expect(calls).toEqual({ empty: 1, second: 1 })
      term.dispose()
    })

    it('does not re-parse chunks the async writer already applied before it yielded', async () => {
      const { Terminal } = await load()
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
      const calls = { first: 0, second: 0 }
      // Heavy output: the first chunk's work runs past the writer's 12 ms
      // budget, so it yields with that chunk still held at the head of its
      // queue (it only trims past 50 applied chunks). A re-fit landing in that
      // gap is exactly Agent Code's pane-attach shape (one big replay chunk,
      // then fit()); the unpatched flush re-applied the head chunk.
      term.write('FIRST\r\n', () => {
        calls.first++
        if (calls.first === 1) setTimeout(() => term.resize(81, 24), 0)
        const until = performance.now() + 20
        while (performance.now() < until) { /* exceed the 12 ms parse budget */ }
      })
      term.write('SECOND\r\n', () => { calls.second++ })

      await new Promise(resolve => setTimeout(resolve, 60))
      expect(await drained(term)).toBe(true)
      expect(visibleLines(term)).toEqual(['FIRST', 'SECOND'])
      expect(calls).toEqual({ first: 1, second: 1 })
      term.dispose()
    })
  })
})
