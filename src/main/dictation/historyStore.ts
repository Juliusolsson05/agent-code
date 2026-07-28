import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
  /** Every word ever dictated. The "Words" tile. */
  words: number
  /** Words from rows that had a measurable duration — the WPM numerator only.
   *  Split from `words` so a row with no usable duration cannot bias the rate;
   *  see the WHY in appendEntry. */
  wpmWords: number
  sessions: number
  spokenMs: number
}

type HistoryFile = {
  v: 1
  totals: HistoryTotals
  entries: DictationHistoryEntry[]
}

const EMPTY_TOTALS: HistoryTotals = { words: 0, wpmWords: 0, sessions: 0, spokenMs: 0 }

function emptyFile(): HistoryFile {
  return { v: FILE_VERSION, totals: { ...EMPTY_TOTALS }, entries: [] }
}

/**
 * Raised when the store exists but cannot be trusted right now. Callers must
 * NOT write when they see this — see the WHY on `read()`.
 */
export class DictationHistoryUnavailableError extends Error {}

/**
 * Read the store.
 *
 * WHY this discriminates read failures instead of just returning an empty store
 * (which is what it used to do, and was a silent data-destroyer):
 *
 * Every mutation is a read-modify-write. If `read()` answers "there is nothing
 * here" for a file that DOES exist but merely could not be read this instant,
 * the very next `appendEntry` writes that empty object back over a healthy
 * `history.json` — and the atomic rename makes the destruction perfectly
 * durable. A single EMFILE (this app holds a lot of fds: PTYs, watchers, the
 * proxy, LSP), one EACCES, or one EIO during a dictation would wipe every
 * retained transcript and the lifetime counter, with no error surfaced
 * anywhere, in direct violation of this file's own "must never decrease"
 * invariant.
 *
 * So the only failure that means "no store yet" is ENOENT. Anything else throws,
 * which rejects the enqueued mutation and leaves the file untouched — losing one
 * history row instead of all of them.
 *
 * A version we do not recognise ALSO throws rather than resetting: a `v: 2`
 * file written by a newer build, then opened by an older one after a rollback,
 * must survive the downgrade.
 */
async function read(): Promise<HistoryFile> {
  let raw: string
  try {
    raw = await readFile(HISTORY_FILE, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
    throw new DictationHistoryUnavailableError(
      `Could not read dictation history: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
    )
  }

  let parsed: Partial<HistoryFile>
  try {
    parsed = JSON.parse(raw) as Partial<HistoryFile>
  } catch {
    // Unparseable is the one case we recover from by starting fresh, because
    // there is no version to preserve and no rows to salvage. Quarantine rather
    // than overwrite: the bytes are moved aside so a future investigation can
    // still see what was on disk, and the user gets a working store back
    // instead of a permanently broken feature.
    await quarantineCorruptFile()
    return emptyFile()
  }

  if (parsed?.v !== FILE_VERSION) {
    throw new DictationHistoryUnavailableError(
      `Dictation history is version ${String(parsed?.v)}, expected ${FILE_VERSION}. ` +
        'Refusing to overwrite a store written by a different build.',
    )
  }

  return {
    v: FILE_VERSION,
    totals: coerceTotals(parsed.totals),
    entries: Array.isArray(parsed.entries)
      ? parsed.entries.filter(isEntry).slice(0, MAX_ENTRIES)
      : [],
  }
}

/** Best-effort move-aside for an unparseable store. Never throws — failing to
 *  quarantine must not also block the caller from recovering. */
async function quarantineCorruptFile(): Promise<void> {
  try {
    await rename(HISTORY_FILE, `${HISTORY_FILE}.corrupt-${Date.now()}`)
  } catch {
    /* noop — recovery proceeds either way */
  }
}

function coerceTotals(value: unknown): HistoryTotals {
  if (!value || typeof value !== 'object') return { ...EMPTY_TOTALS }
  const candidate = value as Partial<HistoryTotals>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
  const words = num(candidate.words)
  return {
    words,
    // Stores written before `wpmWords` existed folded both numerators into
    // `words`, so seeding from it keeps an existing user's WPM continuous
    // rather than resetting the average to zero on upgrade.
    wpmWords: candidate.wpmWords === undefined ? words : num(candidate.wpmWords),
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

/** Temp file + rename, 0600, same discipline as apiKeyStore.ts.
 *
 *  Scope of the guarantee, stated precisely because the obvious reading is too
 *  strong: rename is atomic with respect to other *readers and processes*, so a
 *  crash mid-write can never leave a half-written `history.json`. It is NOT a
 *  durability guarantee — there is no fsync on the temp file or the directory,
 *  so a power loss can still persist the rename ahead of the data. That
 *  residual case degrades to an unparseable file, which `read()` quarantines.
 *  fsync on every dictation is not worth the cost for bookkeeping this small.
 *
 *  The temp name is unique per write rather than a fixed `.tmp`: a fixed name
 *  is only safe while `app.requestSingleInstanceLock()` holds, and the
 *  packaging-smoke path bypasses that lock. It also means a `.tmp` orphaned by
 *  a crash (with whatever mode it had) can never be reused by a later write. */
async function write(file: HistoryFile): Promise<void> {
  await mkdir(dirname(HISTORY_FILE), { recursive: true, mode: 0o700 })
  const tmp = `${HISTORY_FILE}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    await rename(tmp, HISTORY_FILE)
  } catch (err) {
    // Do not leave the scratch file behind if the rename failed.
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function toStats(file: HistoryFile): DictationStats {
  const { words, wpmWords, sessions, spokenMs } = file.totals
  return {
    lifetimeWords: words,
    lifetimeSessions: sessions,
    lifetimeSpokenMs: spokenMs,
    // Guard the divide: a store with sessions but no measurable audio (every
    // entry rejected by the duration filter in appendEntry) must render as "—",
    // not NaN or Infinity, both of which reach the DOM as literal text.
    averageWpm: spokenMs > 0 ? wpmWords / (spokenMs / 60_000) : 0,
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
 * Await whatever is already enqueued.
 *
 * Honest scope, because the obvious reading is wrong: this resolves once every
 * mutation enqueued BEFORE the call has settled. It does not and cannot rescue
 * a stop-handler that is still awaiting `transcribeBatch` — that row was never
 * enqueued.
 *
 * At shutdown it is **best-effort, exactly like the debug journals**, NOT a
 * guarantee. `before-quit` does not gate on the returned promise (doing so
 * would mean preventDefault-ing the quit and re-entering it, which is a real
 * risk of a hung quit in exchange for at most one bookkeeping row). So a
 * dictation finished microseconds before ⌘Q can still be lost. Do not write a
 * comment anywhere claiming otherwise — an earlier version of this file did,
 * and the guarantee was fictional.
 *
 * It IS load-bearing for the IPC handlers, which await it to serialise against
 * in-flight appends.
 */
export function flushHistoryWrites(): Promise<void> {
  return writeChain.then(
    () => undefined,
    () => undefined,
  )
}

/** Reads go through the same chain as writes.
 *
 *  WHY, when a read does not mutate anything: `appendEntry` is fire-and-forget
 *  from the stop handler, so an unserialised read racing an in-flight append
 *  returns the PRE-append file and the Settings panel renders a list that is
 *  already stale by one row. Joining the chain costs nothing (the queue is
 *  empty except during a write) and makes "list after dictating" deterministic. */
export function readHistory(): Promise<DictationHistorySnapshot> {
  return enqueue(async () => {
    const file = await read()
    return { stats: toStats(file), entries: file.entries }
  })
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

    file.totals.sessions += 1
    // "Words spoken" counts EVERY word — that is the question the tile answers.
    file.totals.words += words
    // The WPM average uses its own numerator, paired with its denominator.
    //
    // The earlier version shared `words` between both and guarded only
    // `spokenMs`, which is exactly the inflation its comment claimed to
    // prevent: a row with no measurable duration fed the numerator and nothing
    // the denominator, biasing lifetime WPM upward permanently with no way back
    // short of resetTotals(). (Against a zero duration that guard was also a
    // literal no-op — `+= 0` and skipping it are the same thing, so it only
    // ever protected against a negative duration from a backwards clock step.)
    //
    // Keeping two numerators means a row that cannot anchor a rate still counts
    // as words spoken and still keeps its transcript; it simply does not
    // participate in the average.
    if (input.audioDurationMs > 0) {
      file.totals.wpmWords += words
      file.totals.spokenMs += input.audioDurationMs
    }

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
