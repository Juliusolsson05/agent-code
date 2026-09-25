import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PHONE_SYMBOL_FONT_FAMILY, withPhoneSymbolFont } from './phoneSymbolFont'

// #1194. iOS Safari draws a character the named faces lack from Apple Color
// Emoji, and the rows the phone mounts are full of app symbols carrying the
// Unicode Emoji property (⏺ on every Claude row). The phone's self-hosted,
// unicode-range-scoped symbol face is the fix; each case below is one way it
// silently stopped working in an earlier attempt, or could.

const SRC = resolve(__dirname, '..', '..') // src/
const STYLES = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

// The modules the phone bundle is built from, found by walking its import
// graph from the phone entry point exactly as the bundler resolves it
// (the @renderer/@providers/@shared aliases, relative paths, index files).
// Walking beats a hand-kept directory list, which either misses a module the
// phone starts importing or drags in desktop-only UI the phone never draws.
// Type-only imports are included: a superset only costs a subset entry.
const ALIASES: Array<[string, string]> = [
  ['@renderer/', join(SRC, 'renderer', 'src') + '/'],
  ['@providers/', join(SRC, 'providers') + '/'],
  ['@shared/', join(SRC, 'shared') + '/'],
]
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveImport(specifier: string, fromFile: string): string | null {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix))
  const base = alias
    ? alias[1] + specifier.slice(alias[0].length)
    : specifier.startsWith('.') ? resolve(dirname(fromFile), specifier) : null
  if (!base) return null // a package: not our source
  for (const extension of EXTENSIONS) {
    const candidate = base.replace(/\.js$/, '') + extension
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function phoneBundleSources(): string[] {
  const seen = new Set<string>()
  const queue = [resolve(__dirname, 'main.tsx')]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.tsx?$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const next = resolveImport(match[1]!, file)
      if (next && !seen.has(next)) queue.push(next)
    }
  }
  return [...seen].filter(file => /\.tsx?$/.test(file) && !/\.test\./.test(file))
}

/** App symbols with the Emoji property, found in CODE (comments stripped:
 *  a ✅ in a comment is never drawn). Extended_Pictographic is the property
 *  that makes a platform eligible to substitute its emoji font. */
function emojiPropertySymbols(): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of phoneBundleSources()) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    for (const match of code.matchAll(/\p{Extended_Pictographic}/gu)) {
      if (!found.has(match[0])) found.set(match[0], file.slice(SRC.length + 1))
    }
  }
  return found
}

type Face = { url: string; ranges: Array<[number, number]> }

function symbolFaces(): Face[] {
  const faces: Face[] = []
  for (const block of STYLES.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = block[1]!
    if (!body.includes(`'${PHONE_SYMBOL_FONT_FAMILY}'`)) continue
    const url = body.match(/url\('([^']+)'\)/)?.[1] ?? ''
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1] ?? ''
    const ranges = range.split(',').map(part => {
      const [from, to] = part.trim().replace(/^U\+/i, '').split('-')
      return [parseInt(from!, 16), parseInt(to ?? from!, 16)] as [number, number]
    })
    faces.push({ url, ranges })
  }
  return faces
}

describe('phone symbol face', () => {
  it('covers every Emoji-property symbol the phone can render (none reach Apple Color Emoji)', () => {
    const symbols = emojiPropertySymbols()
    // Not vacuous: the ⏺ bullet is the symbol that started this.
    expect([...symbols.keys()]).toContain('⏺')
    const faces = symbolFaces()
    const uncovered = [...symbols].filter(([ch]) => {
      const cp = ch.codePointAt(0)!
      return !faces.some(face => face.ranges.some(([from, to]) => cp >= from && cp <= to))
    })
    // A new symbol here needs a glyph in a subset (see the @font-face
    // comment in styles.css for the pyftsubset commands) AND a range entry.
    expect(uncovered.map(([ch, file]) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase()} in ${file}`)).toEqual([])
  })

  it('is self-hosted: every face points at a file bundled with the phone', () => {
    // A CDN face vanished whenever the CDN was unreachable, and the emoji
    // came back; a missing local file fails the same way, silently.
    const faces = symbolFaces()
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      expect(face.url.startsWith('./')).toBe(true)
      expect(existsSync(resolve(dirname(resolve(__dirname, 'styles.css')), face.url))).toBe(true)
    }
  })

  it('goes in FRONT of the app stack, and the phone boot applies it', () => {
    // WebKit expands ui-monospace to a cascade reaching Apple Color Emoji,
    // so a face after it never wins; the unicode-range keeps first safe.
    const stack = "'JetBrains Mono', ui-monospace, Menlo, Monaco, monospace"
    expect(withPhoneSymbolFont(stack)).toBe(`'${PHONE_SYMBOL_FONT_FAMILY}', ${stack}`)
    const boot = readFileSync(resolve(__dirname, 'main.tsx'), 'utf8')
    expect(boot).toMatch(/setProperty\('--theme-app-font',\s*withPhoneSymbolFont\(/)
  })
})
