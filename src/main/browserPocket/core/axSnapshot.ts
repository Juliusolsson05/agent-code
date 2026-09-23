// Accessibility tree → agent-readable page snapshot (decomposition Stage 2).
//
// WHY Playwright-style text (`- button "Sign in" [ref=e41]`): every provider's
// model has seen that format from Playwright MCP, so agents read and act on it
// without instructions. WHY text-only: T3 Code put a PNG in every snapshot and
// full-resolution base64 in tool history broke sessions (#11295); screenshots
// are a separate tool.
//
// Refs are `e<backendDOMNodeId>`: stable for the document's lifetime and
// resolvable straight to geometry with DOM.getContentQuads, so no JS handle
// has to be kept alive in the page (spec §6.4).
//
// Every rule below was checked against Chrome's real output
// (__fixtures__/axtree.*.json); the comments name the recording that forced it.

export type AXValue = { type?: string; value?: unknown }
export type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

/** Roles an agent can act on; these get refs. `option` because combobox
 * choices are real targets (recorded form page: select with two options). */
const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'tab', 'switch', 'slider', 'spinbutton', 'menuitem', 'option'])

/** Chrome-internal structure: never printed, but their children are walked.
 * All five appear in the recorded form page. */
const TRANSPARENT = new Set(['none', 'generic', 'LabelText', 'MenuListPopup', 'RootWebArea'])

/** Never printed or walked: glyph runs, and list bullets (recorded list page:
 * one `ListMarker "•"` per row doubled the snapshot for no information). */
const SKIP_SUBTREE = new Set(['InlineTextBox', 'ListMarker'])

const STATE_PROPS = ['disabled', 'checked', 'selected', 'expanded', 'pressed', 'required', 'readonly'] as const

export type AxSnapshot = { text: string; refs: Map<string, number>; truncated: boolean }

export function formatAxTree(nodes: AXNode[], opts: { maxChars?: number } = {}): AxSnapshot {
  // 20k chars ≈ 5k tokens; T3 capped visible text at the same order. The
  // recorded 120-row list page is ~12k chars, so ordinary pages fit whole.
  const max = opts.maxChars ?? 20_000
  const byId = new Map(nodes.map(n => [n.nodeId, n]))
  const root = nodes.find(n => !n.parentId) ?? nodes[0]
  const refs = new Map<string, number>()
  const lines: string[] = []
  let size = 0
  let truncated = false

  const name = (n: AXNode | undefined) => String(n?.name?.value ?? '').trim()
  const role = (n: AXNode | undefined) => String(n?.role?.value ?? '')

  const emit = (line: string): boolean => {
    if (size + line.length + 1 > max) { truncated = true; return false }
    lines.push(line)
    size += line.length + 1
    return true
  }

  const walk = (node: AXNode | undefined, depth: number): void => {
    if (!node || truncated) return
    const r = role(node)
    if (SKIP_SUBTREE.has(r)) return
    const children = (node.childIds ?? []).map(id => byId.get(id))
    if (node.ignored || TRANSPARENT.has(r)) {
      // RootWebArea is transparent but its name is the page title, which the
      // snapshot header already carries.
      for (const child of children) walk(child, depth)
      return
    }
    if (r === 'StaticText') {
      const text = name(node)
      if (!text) return // recorded: whitespace-only text nodes (' ')
      // Recorded: a button's label arrives as a child StaticText with the
      // same string, and a textbox's label as a SIBLING StaticText
      // ('Email ' next to textbox 'Email '). Repeating it doubles the page.
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      const siblings = (parent?.childIds ?? []).map(id => byId.get(id)).filter(s => s && s !== node)
      // Recorded: a textarea's value is repeated as a StaticText under an
      // internal `generic` wrapper, so compare with the nearest ancestor the
      // snapshot actually prints, not just the direct parent.
      let owner = parent
      while (owner && (owner.ignored || TRANSPARENT.has(role(owner))) && owner.parentId) owner = byId.get(owner.parentId)
      if (name(parent) === text || String(owner?.value?.value ?? '').trim() === text || siblings.some(s => role(s) !== 'StaticText' && name(s) === text)) return
      emit(`${'  '.repeat(depth)}- text "${clip(text, 160)}"`)
      return
    }
    if (r === 'Iframe') {
      // Recorded: getFullAXTree on the parent document returns the Iframe
      // node and NOTHING of the nested document. Say so, or the agent will
      // conclude the page has only the outer controls.
      emit(`${'  '.repeat(depth)}- iframe${name(node) ? ` "${clip(name(node), 120)}"` : ''} (contents not included)`)
      return
    }
    const ref = ACTIONABLE.has(r) && node.backendDOMNodeId ? `e${node.backendDOMNodeId}` : null
    const props = new Map((node.properties ?? []).map(p => [p.name, p.value?.value]))
    const states = STATE_PROPS.filter(s => props.get(s) === true || props.get(s) === 'true' || props.get(s) === 'mixed').map(s => `[${s}]`)
    // Chrome reports `level` on list items too (recorded: every listitem is
    // level=1); it only carries meaning for headings.
    const level = r === 'heading' ? props.get('level') : undefined
    const value = node.value?.value
    const line = `${'  '.repeat(depth)}- ${r}${name(node) ? ` "${clip(name(node), 120)}"` : ''}`
      + (level !== undefined ? ` [level=${level}]` : '')
      + (value !== undefined && value !== '' ? ` [value="${clip(String(value), 60)}"]` : '')
      + (states.length ? ` ${states.join(' ')}` : '')
      + (ref ? ` [ref=${ref}]` : '')
    if (!emit(line)) return
    if (ref) refs.set(ref, node.backendDOMNodeId!)
    for (const child of children) walk(child, depth + 1)
  }

  walk(root, 0)
  const text = lines.join('\n')
  return { text: truncated ? `${text}\n… (truncated)` : text, refs, truncated }
}

export function refToBackendId(ref: string): number | null {
  const m = /^e(\d+)$/.exec(ref)
  return m ? Number(m[1]) : null
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').replace(/"/g, '\\"')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
