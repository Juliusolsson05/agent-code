import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { formatAxTree, refToBackendId, type AXNode } from './axSnapshot'

// Real Chrome output (Stage-1 recordings). The contracts are about what an
// agent can DO with the text: every ref must resolve, nothing actionable may
// be dropped, and structure noise must not drown the page.
const load = (page: string) => (JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', `axtree.${page}.json`), 'utf8')) as { nodes: AXNode[] }).nodes

const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'tab', 'switch', 'slider', 'spinbutton', 'menuitem', 'option'])

describe.each(['form', 'iframe', 'list', 'errors', 'spa'])('formatAxTree on recorded %s page', page => {
  const nodes = load(page)
  const out = formatAxTree(nodes)

  it('every ref in the text resolves to a backend node, and every ref is in the text', () => {
    const inText = [...out.text.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1]!)
    expect(new Set(inText)).toEqual(new Set(out.refs.keys()))
    for (const ref of inText) expect(refToBackendId(ref)).toBe(out.refs.get(ref))
  })

  it('no non-ignored actionable node is lost', () => {
    const expected = nodes.filter(n => !n.ignored && ACTIONABLE.has(String(n.role?.value ?? '')) && n.backendDOMNodeId).length
    expect(out.refs.size).toBe(expected)
  })

  it('internal Chrome roles never reach the agent', () => {
    expect(out.text).not.toMatch(/- (InlineTextBox|none|generic|LabelText|MenuListPopup)\b/)
  })
})

describe('recorded page specifics', () => {
  it('form: the submit button reads as Playwright-style with its accessible name', () => {
    expect(formatAxTree(load('form')).text).toMatch(/- button "Sign in" \[ref=e\d+\]/)
  })

  it('form: a StaticText that only repeats its parent\'s name is not emitted twice', () => {
    const text = formatAxTree(load('form')).text
    expect(text.match(/"Sign in"/g)?.length).toBeLessThanOrEqual(3) // RootWebArea title, heading, button
  })

  it('form: a textarea value is not repeated as child text', () => {
    expect(formatAxTree(load('form')).text).not.toMatch(/- text "hello"/)
  })

  it('list: bullets and list-item levels are not printed', () => {
    const text = formatAxTree(load('list')).text
    expect(text).not.toMatch(/ListMarker|listitem \[level/)
  })

  it('spa: disabled and selected states are visible to the agent', () => {
    const text = formatAxTree(load('spa')).text
    expect(text).toMatch(/- button "Disabled" \[disabled\]/)
    expect(text).toMatch(/- tab "One" \[selected\] \[ref=e\d+\]/)
  })

  it('iframe: the frame boundary is announced, because Chrome does not inline cross-document content', () => {
    // Recorded: getFullAXTree on the parent document yields an Iframe node and
    // none of the nested form. Silence here would read as "the page has one button".
    expect(formatAxTree(load('iframe')).text).toMatch(/- iframe "Nested form" \(contents not included\)/)
  })

  it('list: truncates with an explicit marker and keeps refs consistent', () => {
    const small = formatAxTree(load('list'), { maxChars: 600 })
    expect(small.truncated).toBe(true)
    expect(small.text.endsWith('… (truncated)')).toBe(true)
    const inText = [...small.text.matchAll(/\[ref=(e\d+)\]/g)].map(m => m[1]!)
    expect(new Set(inText)).toEqual(new Set(small.refs.keys()))
  })
})

describe('refToBackendId', () => {
  it('parses e123 and rejects anything else', () => {
    expect(refToBackendId('e123')).toBe(123)
    for (const bad of ['x1', 'e', 'e1a', '123', '']) expect(refToBackendId(bad)).toBeNull()
  })
})
