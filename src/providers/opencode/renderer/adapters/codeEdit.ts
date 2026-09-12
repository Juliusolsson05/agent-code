import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import {
  codeEditModelFromDirectApplyPatchText,
  rawDirectApplyPatchText,
} from '@providers/shared/renderer/protocols/code-edit/applyPatch'

export function fromOpencodeApplyPatch(
  block: ToolUseBlock,
  opts: { streaming?: boolean; result?: ToolResultBlock | null } = {},
): CodeEditRenderModel | null {
  if (block.name !== 'apply_patch') return null
  const rawPatch = rawDirectApplyPatchText(block.input)
  if (!rawPatch.includes('*** Begin Patch')) return null
  return codeEditModelFromDirectApplyPatchText(rawPatch, opts)
}

export function rawOpencodeApplyPatchText(block: ToolUseBlock): string {
  return rawDirectApplyPatchText(block.input)
}
