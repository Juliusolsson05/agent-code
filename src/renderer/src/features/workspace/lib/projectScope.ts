import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'
import { cwdBasename } from '@renderer/features/workspace/lib/sessionDisplay'

/**
 * A project as the Dispatch index names it: the project TAB, labelled by its
 * letter and title. Shared by the Switch Agents and Close Old Agents scope
 * pickers (#908).
 *
 * WHY the tab and not the working directory: Agent Code's project is the tab.
 * Worktree agents run in a different directory but belong to the same project,
 * and Dispatch row filters, pinned chips and pane labels all already say
 * `A · agent-code`. Both modals used to key projects by `meta.cwd` because they
 * predate Grid Dispatch's project bindings, when the title was the only label
 * and was not unique; that fallback split every worktree into a pseudo-project
 * exactly when a bulk switch needs "everyone in this project" in one click.
 */
export type ProjectScopeRow = {
  tabId: string
  tabIndex: number
  /** `A · agent-code`, the same vocabulary the Dispatch index uses. */
  label: string
  title: string
  /**
   * Distinct working-directory basenames of the agents in this tab, in row
   * order. Shown as the secondary line so worktrees stay visible as
   * directories inside the project rather than as projects of their own.
   */
  directories: string[]
  /** Every agent the modal knows about in this tab. */
  total: number
  /** The subset that passes the modal's other criteria (age, provider). */
  matching: number
}

export type ProjectScopeAgent = {
  tabId: string
  tabIndex: number
  tabTitle: string
  cwd: string
}

export function projectScopeLabel(tabIndex: number, title: string): string {
  return `${tabIndexLabel(tabIndex)} · ${title}`
}

/**
 * Group agent rows by tab, in tab order.
 *
 * WHY tab order rather than the old count-first sort: the whole point of the
 * change is that this list reads like the Dispatch index, where A comes before
 * B regardless of how many agents each holds. Two tabs with the same title
 * stay distinct because the letter is part of the label.
 */
export function buildProjectScopeRows<T extends ProjectScopeAgent>(
  rows: readonly T[],
  matchingRows: readonly T[],
): ProjectScopeRow[] {
  const matchingByTab = new Map<string, number>()
  for (const row of matchingRows) {
    matchingByTab.set(row.tabId, (matchingByTab.get(row.tabId) ?? 0) + 1)
  }
  const byTab = new Map<string, ProjectScopeRow>()
  for (const row of rows) {
    const directory = cwdBasename(row.cwd)
    const existing = byTab.get(row.tabId)
    if (existing) {
      existing.total += 1
      if (!existing.directories.includes(directory)) existing.directories.push(directory)
      continue
    }
    byTab.set(row.tabId, {
      tabId: row.tabId,
      tabIndex: row.tabIndex,
      label: projectScopeLabel(row.tabIndex, row.tabTitle),
      title: row.tabTitle,
      directories: [directory],
      total: 1,
      matching: 0,
    })
  }
  for (const project of byTab.values()) {
    project.matching = matchingByTab.get(project.tabId) ?? 0
  }
  return Array.from(byTab.values()).sort((a, b) => a.tabIndex - b.tabIndex)
}

/** Case-insensitive match on the label, the title and the directory names, so
 *  typing a worktree name still finds the project that contains it. */
export function filterProjectScopeRows(
  rows: readonly ProjectScopeRow[],
  query: string,
): ProjectScopeRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  return rows.filter(project =>
    project.label.toLowerCase().includes(needle) ||
    project.title.toLowerCase().includes(needle) ||
    project.directories.some(directory => directory.toLowerCase().includes(needle)),
  )
}

/** The one membership rule both modals apply when scope is "Selected projects". */
export function rowsInSelectedProjects<T extends { tabId: string }>(
  rows: readonly T[],
  selectedTabIds: ReadonlySet<string>,
): T[] {
  return rows.filter(row => selectedTabIds.has(row.tabId))
}
