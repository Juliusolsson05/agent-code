import type { SemanticLiveBlock } from '@renderer/session-runtime/state'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolUseBlock } from '@shared/types/transcript'

export type CodexImageGenerationModel = {
  status: string
  revisedPrompt: string | null
  result: string | null
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    ? value
    : null
}

export function fromCodexImageGenerationUse(
  block: ToolUseBlock,
): CodexImageGenerationModel | null {
  if (block.name !== 'image_generation') return null
  const input = asRecord(block.input)
  if (!input) return null
  const status = boundedString(input.status, 80)
  if (!status) return null
  return {
    status,
    revisedPrompt: boundedString(input.revisedPrompt, 64 * 1024),
    result: null,
  }
}

export function fromCodexSemanticImageGeneration(
  block: SemanticLiveBlock,
): CodexImageGenerationModel | null {
  if (block.kind !== 'image_generation_call') return null
  const image = block.imageGeneration
  const status = boundedString(image?.status ?? block.status, 80)
  if (!status) return null
  return {
    status,
    revisedPrompt: boundedString(image?.revisedPrompt, 64 * 1024),
    // Result admission is deliberately deferred to the shared media parser;
    // retaining the string here does not copy it, while constructing a data
    // URL is state-gated by Base64MediaView.
    result: typeof image?.result === 'string' && image.result.length > 0
      ? image.result
      : null,
  }
}
