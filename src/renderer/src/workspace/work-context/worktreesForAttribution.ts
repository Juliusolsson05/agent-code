/**
 * Which worktree list a history chunk's events are attributed against (#1430).
 *
 * WHY a TIMED-OUT list answers `null` (skip attribution) and not `[]`: `[]`
 * is what a non-repository really has, and attributing against it is right
 * there. For a timeout the family is UNKNOWN — attributing against `[]` would
 * record the pane's work as outside any worktree, a wrong answer the live
 * reconciler then has to overwrite. Skipping leaves the pane's work context as
 * it was; the live reconciler fills it in when git answers.
 */
export function worktreesForAttribution<W>(
  result: { ok: true; worktrees: W[] } | { ok: false; timedOut?: boolean },
): W[] | null {
  if (result.ok) return result.worktrees
  return 'timedOut' in result && result.timedOut === true ? null : []
}
