import { useMemo } from 'react'
import hljs from 'highlight.js'

import { normalizeCodeLanguage } from '@shared/code/language'

// Phone substitute for @renderer/lib/code/CodeBlock (aliased in
// vite.config.ts — see the alias table there and the semantic-rendering
// design doc). SAME props type as the desktop original ON PURPOSE: every
// desktop row that renders code keeps compiling unchanged against this
// module.
//
// What diverges, and why it's acceptable:
//   - engine="monaco" degrades to the static path. Monaco is a ~5 MB
//     editor runtime with LSP wiring over window.api — wrong for a phone
//     both in weight and in interaction model. The desktop's own markdown
//     fences, diffs, and git output already use the static engine, so the
//     majority of feed code surfaces render byte-identically; Read/Grep
//     results lose Monaco affordances (word-wrap toggle, LSP hovers) but
//     keep identical hljs token markup.
//   - No copy-code-block registry (codeId is accepted and ignored): that
//     feature is driven by desktop keybinds that don't exist on a phone.
//
// The markup contract (pre.code-block-static > code.hljs.language-X) and
// the `highlight={false}` cheap-streaming path are preserved exactly —
// they are what make phone output match the desktop's static engine.

type Props = {
  code: string
  language?: string | null
  path?: string | null
  workspaceRoot?: string | null
  codeId?: string
  engine?: 'static' | 'monaco'
  allowAutoDetect?: boolean
  highlight?: boolean
}

export function CodeBlock({
  code,
  language,
  allowAutoDetect = false,
  highlight = true,
}: Props): React.JSX.Element {
  const html = useMemo(() => {
    if (!highlight) return null
    const normalized = normalizeCodeLanguage(language ?? null)
    try {
      if (normalized && hljs.getLanguage(normalized)) {
        return {
          className: `hljs language-${normalized}`,
          value: hljs.highlight(code, { language: normalized }).value,
        }
      }
      if (allowAutoDetect && code.length < 20_000) {
        return { className: 'hljs', value: hljs.highlightAuto(code).value }
      }
    } catch {
      // hljs throws on some malformed inputs; plain text is the safe floor.
    }
    return null
  }, [code, language, allowAutoDetect, highlight])

  return (
    <pre className="code-block-static font-code text-[12px] leading-[1.6] whitespace-pre overflow-auto max-h-[360px]">
      {html ? (
        <code
          className={html.className}
          // Same trust story as the desktop static engine: hljs.highlight
          // output over text we already render as text — hljs escapes.
          dangerouslySetInnerHTML={{ __html: html.value }}
        />
      ) : (
        <code>{code}</code>
      )}
    </pre>
  )
}
