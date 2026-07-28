import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { STATE_DIR } from '@main/storage/paths.js'
import { countWords } from '@shared/lib/countWords.js'
import type {
  DictationHistoryEntry,
  DictationHistorySnapshot,
  DictationStats,
} from '@shared/types/dictation.js'

// Local history of committed dictations, plus lifetime totals.
//
// -----------------------------------------------------------------------------
// Privacy contract (inherited, not re-derived)
// -----------------------------------------------------------------------------
//
// Same posture as src/main/dictationJournal.ts, which already writes transcript
// text to a 0600 JSONL on this machine:
//
//   * transcript text is stored — it is the user's own draft, file is local
//   * audio bytes are NEVER stored (they are ~100x the size and a far worse
//     thing to leave on disk forever); only byte/chunk COUNTS are kept
//   * nothing here is ever transmitted anywhere
//   * file mode 0600, directory 0700
//
// WHY not safeStorage, when the sibling apiKeyStore.ts in this very directory
// uses it: the API key is a rotating third-party credential whose leak costs
// real money. Transcript history is user text that is already on disk in the
// debug journals under the same contract, so encrypting one and not the other
// would be theatre. More decisively, safeStorage blobs are DEVICE-SCOPED: a
// macOS Keychain reset would silently destroy the user's entire dictation
// history with no recovery, which is a much worse outcome than the threat it
// would mitigate.
//
// -----------------------------------------------------------------------------
// Why totals are stored rather than summed from `entries`
// -----------------------------------------------------------------------------
//
// `entries` is a capped ring buffer (MAX_ENTRIES). `totals` is monotonic.
// Deriving the lifetime word count from `entries` — which is what the
// standalone flow-electron Hub does — makes the number FALL every time an old
// row is evicted. "How many words have I spoken" must never decrease.
//
// The direct consequence, and the most likely thing for a future reader to get
// wrong: deleting one row does NOT decrement the totals. A delete means "stop
// showing me this text", not "I never said it". `clearEntries()` empties the
// list and keeps the totals; `resetTotals()` is the separate, explicit "forget
// my statistics too" action. Keep those two operations distinct.
//
// -----------------------------------------------------------------------------
// Disk
// -----------------------------------------------------------------------------
//
// No prune is needed and none should be added: MAX_ENTRIES bounds the file to a
// few hundred KB of text at the absolute worst. (pruneOldDictationDebugLogs()
// handles the per-press debug JSONLs, which are a different, unbounded thing.)

const DICTATION_STATE_DIR = join(STATE_DIR, 'dictation')
const HISTORY_FILE = join(DICTATION_STATE_DIR, 'history.json')

const FILE_VERSION = 1

/** Matches the standalone app's retention. Text-only rows are tiny; the cap
 *  exists to keep the list scannable and the read cheap, not to save disk. */
const MAX_ENTRIES = 200

type HistoryTotals = {
  words: number
  sessions: number
  spokenMs: number
}

type HistoryFile = {
  v: 1
  totals: HistoryTotals
  entries: DictationHistoryEntry[]
}

const EMPTY_TOTALS: HistoryTotals = { words: 0, sessions: 0, spokenMs: 0 }

function emptyFile(): HistoryFile {
  return { v: FILE_VERSION, totals: { ...EMPTY_TOTALS }, entries: [] }
}

/**
 * Read the store, tolerating anything.
 *
 * NEVER throws. A corrupt or partially-written history file must not be able to
 * break dictation itself — the transcript reaching the composer is the product,
 * this file is bookkeeping. A malformed file degrades to "no history yet" and
 * is overwritten on the next successful dictation.
 */
async function read(): Promise<HistoryFile> {
  let raw: string
  try {
    raw = await readFile(HISTORY_FILE, 'utf8')
  } catch {
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryFile>
    if (parsed?.v !== FILE_VERSION) return emptyFile()
    return {
      v: FILE_VERSION,
      totals: coerceTotals(parsed.totals),
      entries: Array.isArray(parsed.entries)
        ? parsed.entries.filter(isEntry).slice(0, MAX_ENTRIES)
        : [],
    }
  } catch {
    return emptyFile()
  }
}

function coerceTotals(value: unknown): HistoryTotals {
  if (!value || typeof value !== 'object') return { ...EMPTY_TOTALS }
  const candidate = value as Partial<HistoryTotals>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  return {
    words: num(candidate.words),
    sessions: num(candidate.sessions),
    spokenMs: num(candidate.spokenMs),
  }
}

function isEntry(value: unknown): value is DictationHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<DictationHistoryEntry>
  return (
    typeof e.id === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.text === 'string' &&
    typeof e.words === 'number'
  )
}

/** Atomic write: temp file + rename, 0600, same discipline as apiKeyStore.ts.
 *  A torn history.json would be read as corrupt and silently reset the user's
 *  lifetime totals to zero — worth the extra syscall to make impossible. */
async function write(file: HistoryFile): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true, mode: 0o700 })
  const tmp = `${HISTORY_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
  await rename(tmp, HISTORY_FILE)
}

function toStats(file: HistoryFile): DictationStats {
  const { words, sessions, spokenMs } = file.totals
  return {
    lifetimeWords: words,
    lifetimeSessions: sessions,
    lifetimeSpokenMs: spokenMs,
    // Guard the divide: a store with sessions but no measurable audio (every
    // entry rejected by the duration filter in appendEntry) must render as "—",
    // not NaN or Infinity, both of which reach the DOM as literal text.
    averageWpm: spokenMs > 0 ? words / (spokenMs / 60_000) : 0,
    retainedEntries: file.entries.length,
  }
}

// -----------------------------------------------------------------------------
// Serialization
// -----------------------------------------------------------------------------
//
// Every mutation is a read-modify-write of a whole JSON file, and `appendEntry`
// is deliberately called WITHOUT await from the stream-stop handler (so a disk
// write never sits between the provider answering and the composer filling).
// Those two facts together are a lost-update bug waiting to happen: two
// dictations finishing close together would both read the same file, both
// unshift their entry, and the second write would clobber the first — losing a
// row and one session's worth of totals.
//
// Funnelling mutations through one promise chain makes each read-modify-write
// atomic with respect to the others. It also gives shutdown something concrete
// to await: `flushHistoryWrites()` resolves once no mutation is outstanding.
let writeChain: Promise<unknown> = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation, operation)
  // Keep the chain alive on rejection — one failed write must not wedge every
  // subsequent one. The caller still sees its own rejection through `result`.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Await any in-flight history writes.
 *
 * Load-bearing: because `appendEntry` is fire-and-forget on the hot path, a
 * dictation taken seconds before ⌘Q would otherwise lose its row. Wired into
 * the same shutdown point as DictationDebugJournalRegistry.flushAll(). If a
 * future refactor moves the append or reshapes the quit sequence, this is the
 * thing that silently stops working — the symptom is "my last dictation before
 * quitting is missing", with no error anywhere.
 */
export function flushHistoryWrites(): Promise<void> {
  return writeChain.then(
    () => undefined,
    () => undefined,
  )
}

export async function readHistory(): Promise<DictationHistorySnapshot> {
  const file = await read()
  return { stats: toStats(file), entries: file.entries }
}

export type AppendHistoryInput = {
  text: string
  provider: DictationHistoryEntry['provider']
  audioDurationMs: number
  audioBytes: number
  chunkCount: number
  sttMs: number
}

export function appendEntry(
  input: AppendHistoryInput,
): Promise<DictationHistorySnapshot> {
  return enqueue(async () => {
    const file = await read()
    const words = countWords(input.text)
    const entry: DictationHistoryEntry = {
      id: randomUUID(),
      ts: Date.now(),
      text: input.text,
      words,
      provider: input.provider,
      audioDurationMs: input.audioDurationMs,
      audioBytes: input.audioBytes,
      chunkCount: input.chunkCount,
      sttMs: input.sttMs,
    }

    // Newest first. Stored in display order rather than chronological and
    // reversed in the UI, because the UI is the only consumer and always wants
    // newest first — the same call the standalone recentsStore made.
    file.entries.unshift(entry)
    if (file.entries.length > MAX_ENTRIES) file.entries.length = MAX_ENTRIES

    file.totals.words += words
    file.totals.sessions += 1
    // Only count durations that can actually anchor a rate. A zero or negative
    // duration would contribute words to the numerator with nothing in the
    // denominator, silently inflating WPM forever.
    if (input.audioDurationMs > 0) file.totals.spokenMs += input.audioDurationMs

    await write(file)
    return { stats: toStats(file), entries: file.entries }
  })
}

/** Remove one row. Totals are deliberately untouched — see the header. */
export function deleteEntry(id: string): Promise<DictationHistorySnapshot> {
  return enqueue(async () => {
    const file = await read()
    const index = file.entries.findIndex(entry => entry.id === id)
    if (index === -1) return { stats: toStats(file), entries: file.entries }
    file.entries.splice(index, 1)
    await write(file)
    return { stats: toStats(file), entries: file.entries }
  })
}

/** Empty the list, keep the lifetime statistics. */
export function clearEntries(): Promise<DictationHistorySnapshot> {
  return enqueue(async () => {
    const file = await read()
    file.entries = []
    await write(file)
    return { stats: toStats(file), entries: file.entries }
  })
}

/** Zero the lifetime statistics as well. The explicit "forget everything"
 *  action; separate from clearEntries so neither can happen by accident. */
export function resetTotals(): Promise<DictationHistorySnapshot> {
  return enqueue(async () => {
    const file = await read()
    file.totals = { ...EMPTY_TOTALS }
    file.entries = []
    await write(file)
    return { stats: toStats(file), entries: file.entries }
  })
}
