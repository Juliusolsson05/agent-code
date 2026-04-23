import { useContext, type ReactNode } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'

import { CodeRenderContext } from '@renderer/features/feed/context'

// react-markdown component overrides used inside the feed.
//
// Two custom renderers (pre + code) handle the three cases
// react-markdown v10 emits, which are not uniquely identified by
// any single prop:
//
//   1. Inline code (`variableName` in prose) → plain <code>, styled
//      by the prose-theme.
//   2. Unlabeled fenced code (```\ncontent\n```) → passes through
//      MarkdownPre to flatten away the default <pre> wrapper, then
//      through MarkdownCode which detects "fenced" by the presence
//      of a newline.
//   3. Labeled fenced code (```lang\ncontent\n```) → same as above,
//      but the language comes from the className.

/**
 * Custom <pre> renderer: strips the default <pre> wrapper and lets
 * our MarkdownCode component handle ALL the rendering for fenced
 * code blocks. Without this, react-markdown wraps block code in
 * <pre><code class="language-X">…</code></pre> and our CodeBlock
 * would be nested inside the browser's default <pre> styling.
 *
 * Inline code is NOT affected — inline `code` never gets a <pre>
 * wrapper in react-markdown's output.
 */
export function MarkdownPre({
  children,
  node,
}: {
  children?: ReactNode
  node?: unknown
}) {
  // Tag the children so MarkdownCode knows this code element came
  // from inside a <pre> (i.e., it's a fenced/indented code block,
  // not an inline backtick). We pass through the children as-is;
  // the <pre> wrapper is removed.
  void node
  return <>{children}</>
}

/**
 * Custom <code> renderer. Handles two distinct cases:
 *
 * 1. INLINE code: `variableName` in prose. Detected by the absence
 *    of a `language-*` className AND single-line text. Renders as a
 *    plain <code> element with the existing prose-theme inline-code
 *    styling (accent color, no background).
 *
 * 2. FENCED code blocks: ```language\n...\n```. Detected by the
 *    presence of a `language-*` className OR multi-line text (which
 *    means it came through MarkdownPre above). Renders via CodeBlock
 *    with syntax highlighting.
 *
 * Why the className + newline heuristic:
 *   react-markdown v10 doesn't pass a reliable `inline` prop to the
 *   code component. The only signals are: (a) fenced blocks get
 *   className="language-X" when labeled, (b) fenced blocks have
 *   newlines in their text, (c) inline code has neither. Checking
 *   both catches labeled fences, unlabeled fences (multi-line), and
 *   inline backticks.
 */
export function MarkdownCode({
  className,
  children,
}: {
  className?: string
  children?: ReactNode
}) {
  const { sessionId, workspaceRoot } = useContext(CodeRenderContext)
  const text = String(children ?? '').replace(/\n$/, '')
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? null

  // Inline code: no language class AND no newlines → plain <code>.
  // This preserves the existing prose-theme styling where inline
  // code is accent-colored with no background chip.
  const isInline = !language && !text.includes('\n')
  if (isInline) {
    return <code>{children}</code>
  }

  // Fenced/indented code block inside prose → static highlight.js.
  // NOT Monaco — Monaco is heavyweight (async loader, canvas
  // renderer, explicit layout) and a single assistant turn often
  // contains several fenced blocks. When many Monaco editors mount
  // into narrow flex cells before the parent layout has resolved,
  // they initialise at width=0, paint nothing, and `automaticLayout`
  // does not always recover on the follow-up resize — the block
  // ends up as the dark `--theme-code-bg` background with no
  // visible text (the "black block" bug). Monaco stays reserved for
  // surfaces where an editor actually pays off: Read / Grep tool
  // results, where LSP and scrollable syntax highlighting matter.
  // Prose blocks are "here's a shell command"; static is the right
  // fit.
  //
  // `allowAutoDetect` on unlabeled fences restores the old
  // rehype-highlight detect:true behavior.
  return (
    <CodeBlock
      code={text}
      language={language}
      workspaceRoot={workspaceRoot}
      codeId={`${sessionId}:${text.slice(0, 24)}`}
      engine="static"
      allowAutoDetect={!language}
    />
  )
}

// Single frozen object passed to every ReactMarkdown instance in
// the feed. Module-scope so the reference is stable across renders
// — react-markdown v10 caches on components-object identity.
export const MARKDOWN_COMPONENTS: import('react-markdown').Options['components'] = {
  pre: MarkdownPre,
  code: MarkdownCode,
}
