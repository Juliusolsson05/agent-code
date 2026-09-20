/**
 * Claude's own envelope around a PASTED prompt, as committed by Claude Code
 * 2.1.278 (#1052):
 *
 *   \n\n<pasted_content id="cade">\n<what the app wrote>\n</pasted_content id="cade">\n
 *
 * The closing tag repeats the id. That is Claude's shape, not a typo, and it
 * is the detail an invented fixture gets wrong — the real recording is in
 * testing/fixtures/prompt-acceptance/pasted-content-envelope-2026-09-19.json.
 *
 * WHY this is shared rather than living beside its first caller: main needs it
 * to recognise a prompt Claude ACCEPTED (claudeSession.resolvePromptAcceptance,
 * whose waiter starved on the envelope and reported a delivered prompt as an
 * acceptance-timeout), and the renderer needs it to recognise a prompt the
 * user TYPED (transcript/mapper.isClaudeTypedUserPrompt, which rejects
 * anything starting with `<` because Claude writes its own scaffolding that
 * way — so every pasted prompt silently vanished from composer history).
 * One envelope, one definition: a second copy would drift, and the copy
 * nobody tested would be the one in the security-adjacent comparison.
 */

/**
 * The text inside the envelope when `value` is ENTIRELY one pasted_content
 * block, or null when it is anything else.
 *
 * WHY "entirely", with matching ids AND no inner boundary: unwrapping loosens
 * every comparison built on it, and the guard it must not break is that a
 * different prompt can never be mistaken for this one.
 *
 *  - Whole-string: a prompt that merely CONTAINS the tag — this comment would,
 *    in a transcript — cannot be laundered into a match.
 *  - Backreferenced id: a nested or truncated block is not mistaken for the
 *    outer one.
 *  - No inner boundary (#1052 review): with two SIBLING blocks sharing an id,
 *    the greedy capture spanned both and returned
 *    `first</pasted_content id="x"><pasted_content id="x">second` — a string
 *    that could be armed as a prompt and then acknowledged by a completely
 *    different two-block entry. Ambiguous input gets no candidate at all.
 *
 * Returning null means "no extra candidate", which is exactly where every
 * caller stood before this function existed.
 */
export function unwrapClaudePastedContent(value: string): string | null {
  const match = /^\s*<pasted_content id="([^"\n]+)">\n([\s\S]*)\n<\/pasted_content id="\1">\s*$/u.exec(value)
  if (!match) return null
  const [, id, inner] = match
  if (id === undefined || inner === undefined) return null
  return inner.includes(`<pasted_content id="${id}">`) || inner.includes(`</pasted_content id="${id}">`)
    ? null
    : inner
}
