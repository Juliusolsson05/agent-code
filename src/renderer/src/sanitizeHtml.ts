// sanitizeHtml — turn a pane's raw outerHTML into a compact,
// LLM-friendly structural snapshot.
//
// Use case: the HTML Debug Panel captures `outerHTML` for the
// focused pane. Raw output is dominated by two sources of noise
// that have nothing to do with what the user wrote:
//
//   1. Monaco editor internals. Every tool-result code block is
//      rendered with engine="monaco" (Feed.tsx calls at 1838,
//      2638, 2666). Monaco paints thousands of nested <div>s per
//      instance — view-lines, overflow guards, cursor layers,
//      gutters. For a pane with even a few tool results this
//      overwhelmingly dominates the byte count and tells an LLM
//      nothing useful about layout.
//   2. highlight.js token spans. Static code blocks wrap every
//      keyword / identifier / string in its own <span class="hljs-…">.
//      A single 50-line code block becomes 200+ spans that collapse
//      back to the same plain text they started as.
//
// On top of that, JSX template-literal classNames in this codebase
// are multi-line for readability, and React serializes the newlines
// literally inside `class="..."` attributes — producing 50-line
// class attributes that balloon the token count and bury the
// structure. We normalize those to single-space.
//
// What we preserve:
//   - element types, attributes, text content
//   - class names (without the whitespace bloat) — they name
//     components and help an LLM identify "this is the feed
//     container" or "this is the composer"
//   - data-* / aria-* / role / style — either load-bearing
//     (data-pane-id) or cheap to keep for semantic cues
//
// What we transform:
//   - <div class="monaco-editor"> subtree → <pre><code>…text…</code></pre>
//     with the visible text extracted from `.view-line` children
//   - <code class="hljs …"> subtree → <code class="hljs …">plain text</code>
//     (every nested <span class="hljs-*"> unwrapped)
//   - `class="  \n   a  b\n "` → `class="a b"`
//
// What we do NOT do:
//   - Strip classes entirely. Classes are the main signal telling
//     an LLM "this is a button vs. a heading vs. a panel" in a
//     Tailwind codebase. Normalizing whitespace gets us 90% of
//     the readability win at 0% information loss.
//   - Drop attributes. data-pane-id is load-bearing; aria/role
//     are semantic; inline styles often encode runtime layout
//     state (textarea auto-grow height). Keep them all.
//   - Collapse wrapper <div>s with a single child. Temptingly
//     removable but each layer may carry layout intent via its
//     classes — flattening loses that.
//   - Rewrite URLs, images, or any content.
//
// The function is a pure string→string transform. All DOM work
// happens on a detached document via DOMParser — nothing we
// build ever lives in the real DOM.

// Elements whose inner whitespace is significant. Inside these,
// we emit innerHTML verbatim instead of re-indenting children.
// `pre` and `code` are the big ones (code snippets); textarea
// is included because its innerHTML is the initial value and
// we shouldn't wrap it.
const WHITESPACE_SENSITIVE_TAGS = new Set([
  'pre',
  'code',
  'textarea',
  'script',
  'style',
])

// Void (self-closing) HTML elements — no closing tag, no
// children. Serialize as a single `<tag>` without `</tag>`.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'source', 'track', 'wbr',
])

export function sanitizeHtml(raw: string): string {
  if (!raw) return ''

  // DOMParser gives us a full detached document. The input is
  // a single top-level element (TileLeaf's root div), so after
  // parsing it sits as the first element child of <body>.
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''

  collapseMonacoEditors(doc, root)
  unwrapHljsSpans(root)
  normalizeClassWhitespace(root)

  return prettyPrintElement(root, 0)
}

// Find every .monaco-editor in the parsed tree and replace its
// host wrapper (.code-block-shell if present, else the Monaco
// root itself) with a <pre><code> containing the visible text
// Monaco was displaying.
//
// Why walk `.view-line` specifically: Monaco keeps visible text
// in `.view-line` children inside `.view-lines`. Taking
// `monaco.textContent` would also pick up aria-hidden measurement
// nodes Monaco uses for layout, producing duplicated text.
// `.view-line` is the stable public-ish class for "one
// displayable line of the editor". If Monaco ever renames it, the
// sanitizer quietly emits an empty code block — worse than
// dropping the instance entirely, but not a correctness bug.
//
// When there's a `.code-block-shell` ancestor (our own wrapper
// from CodeBlock.tsx:215), we swap THAT out instead of the raw
// `.monaco-editor`. Otherwise the parent shell's class names
// would stick around and contain an orphaned replacement inside —
// the shell's whole reason to exist is to host Monaco.
function collapseMonacoEditors(doc: Document, root: Element): void {
  // querySelectorAll returns a static NodeList, safe to iterate
  // while we mutate the tree. We still build an array because
  // replaceWith detaches the node and we want explicit control
  // over ordering if two editors were somehow nested.
  const editors = Array.from(root.querySelectorAll('.monaco-editor'))
  for (const editor of editors) {
    // If the editor was already detached by a previous iteration
    // (e.g. a nested editor inside a shell we already replaced),
    // skip it — isConnected is false once its parent chain to
    // `root` is broken.
    if (!root.contains(editor)) continue

    const lines = Array.from(editor.querySelectorAll('.view-line'))
      .map(line => line.textContent ?? '')
      .join('\n')

    const pre = doc.createElement('pre')
    pre.className = 'monaco-extracted'
    const code = doc.createElement('code')
    code.textContent = lines
    pre.appendChild(code)

    const shell = editor.closest('.code-block-shell')
    const target = shell && root.contains(shell) ? shell : editor
    target.replaceWith(pre)
  }
}

// Flatten every <code class="hljs …"> to its plain text. The
// code element itself is preserved — its class names still say
// "hljs language-rust" which is useful context. Only the per-
// token <span> children are collapsed.
//
// textContent assignment: setting textContent on an element
// replaces all its children with a single text node containing
// the concatenation of every descendant's text — exactly what
// we want for "unwrap spans".
function unwrapHljsSpans(root: Element): void {
  const codes = Array.from(root.querySelectorAll('code.hljs'))
  for (const code of codes) {
    code.textContent = code.textContent ?? ''
  }
}

// Collapse runs of whitespace inside class attributes to single
// spaces and trim. React preserves newlines from template-literal
// classNames like:
//   className={`
//     flex flex-col
//     border border-accent
//   `}
// which becomes `class="\n        flex flex-col\n        border
// border-accent\n      "` in the serialized HTML. Visually this
// is a significant fraction of raw capture size.
//
// We walk every element with a class attribute (querySelectorAll
// '[class]' is the right selector — attribute presence, not a
// class match) and rewrite. If after normalization the class is
// empty, we remove the attribute entirely instead of emitting
// `class=""`.
function normalizeClassWhitespace(root: Element): void {
  const elements: Element[] = []
  if (root.hasAttribute('class')) elements.push(root)
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    elements.push(el)
  }
  for (const el of elements) {
    const raw = el.getAttribute('class') ?? ''
    const normalized = raw.replace(/\s+/g, ' ').trim()
    if (normalized) el.setAttribute('class', normalized)
    else el.removeAttribute('class')
  }
}

// Pretty-print serializer. Emits each element on its own line,
// indented by depth * 2 spaces.
//
// Children rules:
//   - void element: `<tag attrs>` on one line, no close.
//   - whitespace-sensitive element (<pre>, <code>, <textarea>,
//     <script>, <style>): emit innerHTML inline on the opening-
//     tag line; do not re-indent. Preserves exact intra-tag
//     spacing which matters for code blocks.
//   - element with only a single text child: inline form
//     `<tag attrs>text</tag>` on one line. Keeps short leaves
//     compact instead of wasting two extra lines on every
//     <span>Foo</span>.
//   - element with mixed or element children: multi-line form,
//     children indented one extra level. Text nodes get their
//     whitespace collapsed to a single line.
function prettyPrintElement(el: Element, depth: number): string {
  const pad = '  '.repeat(depth)
  const tag = el.tagName.toLowerCase()
  const attrs = serializeAttrs(el)

  if (VOID_TAGS.has(tag)) {
    return `${pad}<${tag}${attrs}>`
  }

  if (WHITESPACE_SENSITIVE_TAGS.has(tag)) {
    // innerHTML preserves exactly what browser serialization
    // gives us — the whitespace-sensitive content is intentional
    // (code indentation, newlines in a pre). Do NOT fold it.
    return `${pad}<${tag}${attrs}>${el.innerHTML}</${tag}>`
  }

  const childNodes = Array.from(el.childNodes)
  const hasElementChild = childNodes.some(n => n.nodeType === Node.ELEMENT_NODE)

  if (!hasElementChild) {
    // All text (or empty). Inline the text on the opening line.
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!text) return `${pad}<${tag}${attrs}></${tag}>`
    return `${pad}<${tag}${attrs}>${escapeText(text)}</${tag}>`
  }

  const inner: string[] = []
  for (const child of childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      inner.push(prettyPrintElement(child as Element, depth + 1))
      continue
    }
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) {
        inner.push(`${'  '.repeat(depth + 1)}${escapeText(text)}`)
      }
      continue
    }
    // Comments, CDATA, doctypes — rare in a rendered React tree.
    // Skip them.
  }
  return `${pad}<${tag}${attrs}>\n${inner.join('\n')}\n${pad}</${tag}>`
}

function serializeAttrs(el: Element): string {
  const parts: string[] = []
  for (const attr of Array.from(el.attributes)) {
    // Attribute values already went through React's own escaping
    // on the way out. We re-escape the minimum set required by
    // HTML attribute syntax to be safe against any weirdness.
    parts.push(` ${attr.name}="${escapeAttr(attr.value)}"`)
  }
  return parts.join('')
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
