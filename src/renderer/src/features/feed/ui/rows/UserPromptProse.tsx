import { useContext } from 'react'

import { ProviderContext } from '@renderer/features/feed/context'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { TextProse } from '@renderer/features/feed/ui/markdown'

/**
 * A user prompt's text, as the USER wrote it (#1059).
 *
 * WHY this exists rather than `<TextProse text={block.text} />` at both call
 * sites: a provider may commit a user prompt wrapped in scaffolding of its
 * own, and the feed was painting that scaffolding as if the user had typed
 * it. Claude Code 2.1.278 wraps every PASTED prompt:
 *
 *     <pasted_content id="cade">
 *     …what the user actually wrote…
 *     </pasted_content id="cade">
 *
 * so the owner's own transcript read
 * `❯ <pasted_content id="cade"> should we make a new release? …`.
 *
 * The unwrapping rule belongs to the provider, not to the feed — the
 * `typedUserPromptText` capability — so a fifth provider with a different
 * envelope has one place to answer, and the feed keeps knowing nothing about
 * any of them. Anything that is not a whole, unambiguous envelope is rendered
 * untouched; see `unwrapClaudePastedContent` for why it refuses to guess.
 *
 * WHY the two call sites both go through here: Claude commits a string
 * `message.content` for some prompts and a `[{type:'text'}]` block list for
 * others (an attachment, a queued send). Fixing only the one the screenshot
 * happened to show would leave the other painting the envelope.
 */
export function UserPromptProse({ text }: { text: string }) {
  const provider = useContext(ProviderContext)
  return <TextProse text={getRendererProviderCapabilities(provider).typedUserPromptText(text)} />
}
