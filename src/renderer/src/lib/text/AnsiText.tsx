import type { CSSProperties } from 'react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { ITheme } from '@xterm/xterm'

import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import { readXtermTheme } from '@renderer/workspace/tile-tree/xtermTheme'

import { hasAnsi, parseAnsi, type AnsiStyle } from '@shared/parsers/ansi'

// ANSI-aware text renderer for command output. PORTED from PR #524's kit
// (Phase 6 salvage, renderer rewrite PR #555) with its review fixes intact.
//
// WHY the palette comes from readXtermTheme(): the terminal panes
// already solved "ANSI colors readable on both light and dark canvas"
// (xtermTheme.ts branches the 16-color table by background luminance).
// Feed output using the SAME table means a `git diff` looks identical
// in the feed card and in the raw terminal — one fewer visual dialect.
//
// WHY a state+event subscription instead of reading the theme per
// render: readXtermTheme() calls getComputedStyle — cheap but not
// free, and theme changes are rare. THEME_CHANGED_EVENT is the same
// signal CodeBlock/monacoRuntime already listen to.
//
// Memoized by text: committed output never changes; live output grows,
// and parseAnsi over a capped OutputWell payload is cheap per delta.

const PALETTE_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const satisfies readonly (keyof ITheme)[]

function colorOf(v: number | string | null, theme: ITheme): string | undefined {
  if (v === null) return undefined
  if (typeof v === 'string') return v
  const key = PALETTE_KEYS[v]
  return key ? (theme[key] as string | undefined) : undefined
}

function styleOf(s: AnsiStyle, theme: ITheme): CSSProperties | undefined {
  // Inverse swaps fg/bg; with no explicit colors set, fall back to the
  // theme's foreground/background so inverse is still visible.
  const fg = s.inverse
    ? (colorOf(s.bg, theme) ?? theme.background)
    : colorOf(s.fg, theme)
  const bg = s.inverse
    ? (colorOf(s.fg, theme) ?? theme.foreground)
    : colorOf(s.bg, theme)
  if (!fg && !bg && !s.bold && !s.dim && !s.italic && !s.underline) return undefined
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.65 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined,
  }
}

export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const [theme, setTheme] = useState<ITheme>(() => readXtermTheme())
  useEffect(() => {
    const onTheme = () => setTheme(readXtermTheme())
    window.addEventListener(THEME_CHANGED_EVENT, onTheme)
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onTheme)
  }, [])

  const plain = !hasAnsi(text)
  const spans = useMemo(
    () => (plain ? null : parseAnsi(text).spans),
    [plain, text],
  )

  // Fast path: no escape sequences → plain text node, zero span DOM.
  if (plain || !spans) return <>{text}</>

  return (
    <>
      {spans.map((span, i) => {
        const style = styleOf(span.style, theme)
        return style ? (
          <span key={i} style={style}>{span.text}</span>
        ) : (
          <span key={i}>{span.text}</span>
        )
      })}
    </>
  )
})
