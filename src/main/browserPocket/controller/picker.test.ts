import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildSelector, cssIdent } from './picker'

// Paths shaped like what the in-page walker returns for the recorded pages
// (dom-geometry.*.json): the SPA's #inc button, the form's classless submit
// button, a list row's aria-labelled button.
describe('buildSelector', () => {
  it('uses the id when the picked element has one (recorded spa #inc)', () => {
    expect(buildSelector([{ tag: 'body', nth: 1 }, { tag: 'div', id: 'root', nth: 1 }, { tag: 'main', nth: 1 }, { tag: 'button', id: 'inc', nth: 1 }])).toBe('#inc')
  })
  it('prefers the nearest data-testid over a positional path', () => {
    expect(buildSelector([{ tag: 'body', nth: 1 }, { tag: 'form', testId: 'login', nth: 1 }, { tag: 'button', nth: 1 }])).toBe('[data-testid="login"]')
  })
  it('falls back to an nth-of-type path (recorded form submit button has no id)', () => {
    expect(buildSelector([{ tag: 'body', nth: 1 }, { tag: 'main', nth: 1 }, { tag: 'form', nth: 1 }, { tag: 'button', nth: 1 }]))
      .toBe('body:nth-of-type(1) > main:nth-of-type(1) > form:nth-of-type(1) > button:nth-of-type(1)')
  })
  it('escapes ids that are not plain identifiers', () => {
    expect(cssIdent('a:b')).toBe('a\\:b')
    expect(cssIdent('1st')).toBe('\\31 st')
  })
})

// Decomposition §3: the controller is main-only. The renderer reaches it
// through IPC; a renderer import would put CDP and guest control next to the
// privileged UI.
it('no renderer file imports the pocket controller', () => {
  const renderer = join(__dirname, '../../../renderer')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { if (name !== 'node_modules') walk(path) }
      else if (/\.(ts|tsx)$/.test(name) && /browserPocket\/controller/.test(readFileSync(path, 'utf8'))) offenders.push(relative(renderer, path))
    }
  }
  walk(renderer)
  expect(offenders).toEqual([])
})
