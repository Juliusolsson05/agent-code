import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type CodexPlanStatus = 'pending' | 'in_progress' | 'completed'

export type CodexPlanItem = {
  step: string
  status: CodexPlanStatus
}

export type CodexPlanModel = {
  operationId: string
  explanation: string | null
  items: readonly CodexPlanItem[]
  totalItems: number
  completedItems: number
  activeItems: number
  input: Record<string, unknown>
}

const MAX_VISIBLE_PLAN_ITEMS = 80

export function fromCodexPlanUse(block: ToolUseBlock): CodexPlanModel | null {
  if (block.name !== 'update_plan' || !/\S/.test(block.id)) return null
  const input = asRecord(block.input)
  if (!input || !Array.isArray(input.plan) || input.plan.length === 0) return null
  const explanation = input.explanation
  if (explanation !== undefined && typeof explanation !== 'string') return null

  const items: CodexPlanItem[] = []
  let completedItems = 0
  let activeItems = 0
  // WHY validate every item even after the visible cap: absorbing the generic
  // invocation means claiming the complete schema. A malformed item at index
  // 81 is still drift and must keep the raw row. We retain only a bounded
  // visible prefix, but schema admission covers the whole source array.
  for (let index = 0; index < input.plan.length; index += 1) {
    const item = asRecord(input.plan[index])
    const step = typeof item?.step === 'string' && /\S/.test(item.step) ? item.step : null
    const status = item?.status
    if (
      !step ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    ) return null
    if (status === 'completed') completedItems += 1
    if (status === 'in_progress') activeItems += 1
    if (items.length < MAX_VISIBLE_PLAN_ITEMS) items.push({ step, status })
  }

  return {
    operationId: block.id,
    explanation: explanation ?? null,
    items,
    totalItems: input.plan.length,
    completedItems,
    activeItems,
    input,
  }
}

function resultText(result: ToolResultBlock): string | null {
  if (typeof result.content === 'string') return result.content
  if (!Array.isArray(result.content) || result.content.length !== 1) return null
  const item = asRecord(result.content[0])
  return item?.type === 'text' && typeof item.text === 'string' ? item.text : null
}

export function isCodexPlanResult(
  result: ToolResultBlock,
  model: CodexPlanModel,
): boolean {
  return result.tool_use_id === model.operationId &&
    result.is_error !== true &&
    resultText(result) === 'Plan updated'
}
