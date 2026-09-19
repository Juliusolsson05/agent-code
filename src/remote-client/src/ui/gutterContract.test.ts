import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The phone shell's ONE-GUTTER CONTRACT: every chrome band uses a 12px
// horizontal gutter, matching the mounted desktop feed column (px-3 base
// tier, --feed-gutter: 12px in @renderer/styles.css).
//
// WHY a text-parsing test instead of jsdom: the gutters live in plain CSS
// (styles.css) that jsdom never evaluates, so computed-style assertions
// cannot see them — the same honesty rule as primitives.renderer.test.tsx
// and nordTheme.test.ts, which assert against the stylesheet text itself.
//
// The bug this pins: the v1 chrome was born with 14px gutters and the feed
// was born with 12px, so for the entire v1 era every fleet-screen band sat
// 2px proud of every session-screen band (and the .working/.terminal
// fallback strips sat 2px off the header/feed around them). A 2px shear on
// a monospace grid reads as "the padding is broken" — exactly the
// long-standing mobile complaint. If this test fails, someone reintroduced
// a second gutter scale; unify on 12px rather than adding a third value.

const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8')

/** Extract one rule block for a single-class selector from the stylesheet.
 *  Anchored to column 0 so compound rules like `.session-row
 *  .marker.working { … }` cannot shadow the plain `.working { … }` band
 *  rule — first-match wins, and the compound appears earlier in the file. */
function ruleBlock(selector: string): string {
  const match = css.match(new RegExp(`^\\.${selector}\\s*\\{([^}]*)\\}`, 'm'))
  if (!match) throw new Error(`selector .${selector} not found in styles.css`)
  return match[1]
}

/** Split a shorthand into top-level values, ignoring whitespace inside
 *  parens — safe-area/calc vertical paddings must not shatter into fake
 *  tokens (the naive whitespace split turned `0px)` into a "value"). */
function topLevelValues(shorthand: string): string[] {
  const values: string[] = []
  let depth = 0
  let current = ''
  for (const ch of shorthand.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && /\s/.test(ch)) {
      if (current) values.push(current)
      current = ''
    } else current += ch
  }
  if (current) values.push(current)
  return values
}

/** Horizontal component of a padding shorthand (2nd value, or the single
 *  value; vertical-only differences are intentional and out of scope). */
function horizontalGutter(selector: string): string {
  const padding = ruleBlock(selector).match(/padding:\s*([^;]+);/)?.[1]
  if (!padding) throw new Error(`.${selector} has no padding declaration`)
  const values = topLevelValues(padding)
  return values[1] ?? values[0]
}

describe('phone shell gutter contract', () => {
  // v1 chrome that survived into v2 (fleet screen + session fallback bands)
  // alongside the 12px v2/session chrome. These five are the historical
  // offenders; the v2 selectors below never drifted.
  it.each(['topbar', 'section-label', 'session-row', 'terminal', 'working'])(
    '.%s uses the 12px gutter',
    selector => {
      expect(horizontalGutter(selector)).toBe('12px')
    },
  )

  it.each(['session-header', 'composer-actions', 'reader-host'])(
    '.%s keeps the 12px gutter',
    selector => {
      expect(horizontalGutter(selector)).toBe('12px')
    },
  )
})
