import type { AgentWorkContext } from '@renderer/workspace/work-context/types'

const MAIN_BRANCH_COLORS: Record<string, string> = {
  main: '#2563eb',
  master: '#475569',
}

const WORKTREE_PALETTE = [
  '#0f766e',
  '#b45309',
  '#7c3aed',
  '#be123c',
  '#047857',
  '#c2410c',
  '#4338ca',
  '#a21caf',
  '#0369a1',
  '#4d7c0f',
  '#b91c1c',
  '#6d28d9',
  '#0e7490',
  '#a16207',
  '#15803d',
  '#c026d3',
  '#1d4ed8',
  '#9f1239',
  '#166534',
  '#9333ea',
  '#155e75',
  '#92400e',
  '#be185d',
  '#065f46',
  '#3730a3',
  '#9a3412',
  '#115e59',
  '#7e22ce',
  '#991b1b',
  '#075985',
] as const

const assignedPaletteIndexByWorktreePath = new Map<string, number>()

export function worktreeBadgeColor(
  context: AgentWorkContext | null | undefined,
): string | null {
  if (!context?.worktreePath) return null

  const branch = context.branch?.trim().toLowerCase()
  if (branch && MAIN_BRANCH_COLORS[branch]) {
    return MAIN_BRANCH_COLORS[branch]
  }

  let index = assignedPaletteIndexByWorktreePath.get(context.worktreePath)
  if (index === undefined) {
    index = assignedPaletteIndexByWorktreePath.size % WORKTREE_PALETTE.length
    assignedPaletteIndexByWorktreePath.set(context.worktreePath, index)
  }
  return WORKTREE_PALETTE[index]
}

export function resetWorktreeBadgeColorAssignmentsForTest(): void {
  assignedPaletteIndexByWorktreePath.clear()
}
