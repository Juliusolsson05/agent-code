import type { AgentWorkContext } from '@shared/work-context/types'

// WHY this helper lives next to SessionBadges and not in a generic
// "colors" module under work-context: the consumer is the worktree
// badge rendered inside the tile-tree leaf — it has no relationship to
// the work-context machinery (matching, scoring, tracking) beyond
// reading the AgentWorkContext type. Keeping it colocated with the
// only UI that paints it makes future palette tweaks discoverable
// without grepping across the workspace tree.
//
// The two MAIN_BRANCH overrides exist so the most common case ("I am
// on main / master, not a worktree") does NOT consume a slot in the
// rotating palette. Otherwise the first user who opens main on a fresh
// install paints it teal forever, and every new worktree shifts the
// palette by one — confusing once you have several worktrees because
// the colors silently re-deal.

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

// WHY a PURE DETERMINISTIC HASH instead of the old module-scoped
// "assign the next free palette slot" Map:
//
// The Map approach colored a worktree by the ORDER in which it was
// first seen this session. That has three bugs we kept tripping over:
//   1. Not stable across restarts. Quit and relaunch and the same
//      branch could deal a different color, because first-seen order
//      changed. The badge is meant to build "blue means feature/foo"
//      muscle memory; a color that moves on restart defeats that.
//   2. Order-dependent within a session. Open worktrees in a different
//      order (or have one disappear/reappear) and every later worktree
//      shifts by a slot — the palette silently re-deals.
//   3. Two color sources drift. The pane badge (SessionBadges) and the
//      worktree panel (WorktreesBar) both want to paint the same
//      worktree the same color. A session-scoped Map living next to one
//      consumer can't be shared cheaply; a pure function CAN, because
//      identical input always yields identical output with no shared
//      mutable state. So both call sites import this and agree for free.
//
// A pure hash trades away "perfectly even palette utilization" (two
// branches can collide on a color) for the three properties above. For
// a badge whose only job is recognition, stable+shared+order-free beats
// guaranteed-distinct, and the 30-slot palette makes collisions rare.
//
// KEY CHOICE — repoRoot+branch with a worktreePath fallback:
//   The thing a human recognizes is the BRANCH, not the on-disk path
//   (`.worktrees/feature-foo-abc123`). Two checkouts of the same branch
//   in the same repo should share a color, and a branch should keep its
//   color even if the worktree is removed and recreated at a new path.
//   So when a branch name exists we key on `repoRoot\nbranch` (repoRoot
//   scopes it so `main` in repo A and repo B don't have to share — and
//   main/master are special-cased above anyway). We lowercase the branch
//   so case-only differences don't fork the color. Only when there is no
//   branch at all (detached HEAD) do we fall back to the worktreePath,
//   which is then the sole stable identifier available.

// Small inline FNV-1a string hash. Deterministic, no dependency, and
// good enough spread for picking a palette index. We do NOT need
// cryptographic quality here — just a stable, well-mixed integer.
function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // Multiply by the FNV prime (16777619) via shifts to stay in 32-bit
    // integer math without overflowing into floating point imprecision.
    hash = Math.imul(hash, 0x01000193)
  }
  // Coerce to an unsigned 32-bit value so the modulo below is positive.
  return hash >>> 0
}

export type WorktreeColorIdentity = {
  repoRoot?: string | null
  branch?: string | null
  worktreePath?: string | null
}

// The single source of truth for "what color is this worktree?" — both
// the pane badge and the worktree panel call this so they can never
// disagree. Returns null when there is no usable identity to hash.
export function worktreeColorForIdentity(
  identity: WorktreeColorIdentity,
): string | null {
  const branch = identity.branch?.trim()
  const worktreePath = identity.worktreePath?.trim()
  if (!worktreePath && !branch) return null

  const lowerBranch = branch?.toLowerCase()
  if (lowerBranch && MAIN_BRANCH_COLORS[lowerBranch]) {
    return MAIN_BRANCH_COLORS[lowerBranch]
  }

  // Prefer the branch-scoped key (recognizable + path-independent) and
  // only fall back to the raw worktree path for detached checkouts.
  const key = lowerBranch
    ? `${identity.repoRoot ?? ''}\n${lowerBranch}`
    : worktreePath!
  return WORKTREE_PALETTE[fnv1a(key) % WORKTREE_PALETTE.length]
}

// Thin adapter preserving the original call signature so SessionBadges
// (and any other AgentWorkContext consumer) needs no change. All the
// actual logic lives in worktreeColorForIdentity so the panel can share
// it without depending on the AgentWorkContext shape.
export function worktreeBadgeColor(
  context: AgentWorkContext | null | undefined,
): string | null {
  if (!context) return null
  return worktreeColorForIdentity({
    repoRoot: context.repoRoot,
    branch: context.branch,
    worktreePath: context.worktreePath,
  })
}
