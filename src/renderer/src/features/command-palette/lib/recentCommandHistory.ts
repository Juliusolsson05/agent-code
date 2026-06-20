import { RECENT_COMMANDS_STORAGE_KEY } from '@renderer/app-state/localStorageMigration'

// Recent-command history — a private, local quality-of-life cache that
// nudges frequently/recently used commands up the palette's *tiebreak*
// order. It is explicitly NOT analytics: nothing here is reported,
// synced, or read by any other part of the app. It lives beside the
// palette feature (no settings schema, no store slice) precisely
// because it is disposable — the worst-case failure is "ranking is a
// little stale", never a crash or lost user data.
//
// WHY localStorage and not the app store / settings: the data is pure
// derived UI preference with zero invariants worth migrating. Following
// the prompt-templates precedent (templates.ts), every read/write is
// wrapped in try/catch so a corrupt blob, a disabled-storage browser
// context, or a quota error degrades to "no history" rather than
// throwing into the render path. The whole thing is resettable by
// clearing one localStorage key (RECENT_COMMANDS_STORAGE_KEY).

export type RecentCommandEntry = {
  id: string
  count: number
  lastUsedAt: number
}

// Bound 1: how many entries we keep. The palette has on the order of
// tens of commands, so 50 comfortably covers "everything the user
// actually touches" while keeping the JSON blob tiny and the score
// computation O(n) over a trivially small n.
const MAX_RECENT_ENTRIES = 50

// Bound 2: age cutoff. Commands the user hasn't run in ~90 days are
// almost certainly not part of their current muscle memory; pruning
// them keeps the recency signal meaningful and stops a one-off command
// from haunting the ranking forever.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

// Frequency saturates fast on purpose: a command used 10+ times is
// "frequent" and we don't want a single power-command (e.g. a toggle
// the user hammers) to dominate the frequency axis unboundedly. Capping
// keeps the frequency term in a predictable [0,1] range.
const FREQ_CAP = 10

function normalizeEntries(value: unknown): RecentCommandEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  // Normalize-on-read: we never trust the persisted blob. Drop anything
  // with a non-string id or non-finite numbers — a partial write or a
  // hand-edited devtools value must not poison the score map. Unknown or
  // stale ids (commands that no longer exist) are harmless: they are
  // simply never matched at ranking time, so we keep them rather than
  // cross-referencing the live registry here (which this layer has no
  // business knowing about).
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    if (typeof record.count !== 'number' || !Number.isFinite(record.count)) return []
    if (typeof record.lastUsedAt !== 'number' || !Number.isFinite(record.lastUsedAt)) return []
    if (seen.has(record.id)) return []
    seen.add(record.id)
    return [{
      id: record.id,
      count: record.count,
      lastUsedAt: record.lastUsedAt,
    }]
  })
}

// Prune is applied on every write (not just read) so the persisted blob
// can never grow unbounded: drop stale-by-age entries first, then keep
// only the MAX_RECENT_ENTRIES most-recently-used. Sorting by lastUsedAt
// desc here also means the saved array is already in recency order,
// which is the order buildHistoryScoreMap relies on.
function pruneEntries(entries: RecentCommandEntry[]): RecentCommandEntry[] {
  const cutoff = Date.now() - MAX_AGE_MS
  return entries
    .filter(entry => entry.lastUsedAt >= cutoff)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_RECENT_ENTRIES)
}

export function loadRecentHistory(): RecentCommandEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_STORAGE_KEY)
    if (!raw) return []
    return normalizeEntries(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveRecentHistory(entries: RecentCommandEntry[]): void {
  try {
    window.localStorage.setItem(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota / disabled storage: a failed write just means this use
    // isn't remembered. Never surface this to the caller — recording a
    // command use must never be able to break command execution.
  }
}

export function recordCommandUse(id: string): void {
  // Read-modify-write. This is deliberately fire-and-forget from the
  // caller's perspective: executeCommand calls this right before
  // command.run(), so any throw here would block the actual command.
  // The whole body is wrapped so even an unexpected failure (e.g.
  // JSON.stringify on something exotic) can't propagate.
  try {
    const entries = loadRecentHistory()
    const now = Date.now()
    const existing = entries.find(entry => entry.id === id)
    if (existing) {
      existing.count += 1
      existing.lastUsedAt = now
    } else {
      entries.push({ id, count: 1, lastUsedAt: now })
    }
    saveRecentHistory(pruneEntries(entries))
  } catch {
    // Swallow — see WHY above. History is a nicety, command execution
    // is not.
  }
}

// Collapse each entry into a single score in [0,1) that the ranker uses
// purely as a tiebreaker. recency dominates (0.8) because "what I just
// did" is a far stronger predictor of "what I want next" than raw
// lifetime frequency (0.2). recency is derived from POSITION in the
// recency-sorted list rather than a raw timestamp delta: the newest
// entry scores ~1, the MAX_RECENT_ENTRIES-th scores ~0, which gives a
// stable, bounded gradient that doesn't depend on wall-clock gaps
// between uses.
export function buildHistoryScoreMap(
  entries: RecentCommandEntry[],
): Map<string, number> {
  const byRecency = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  const scores = new Map<string, number>()
  byRecency.forEach((entry, index) => {
    // rankFromMostRecent: newest = MAX_RECENT_ENTRIES (≈1 after divide),
    // oldest trends toward 0. Clamp via the list length so a short list
    // still spreads across the full [0,1) recency range.
    const rankFromMostRecent = MAX_RECENT_ENTRIES - index
    const recency = Math.max(0, rankFromMostRecent / MAX_RECENT_ENTRIES)
    const frequency = Math.min(entry.count, FREQ_CAP) / FREQ_CAP
    scores.set(entry.id, recency * 0.8 + frequency * 0.2)
  })
  return scores
}
