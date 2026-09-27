import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'

import { STATE_DIR } from '@main/storage/paths.js'
import type { CliUpdateBehavior, CliUpdateKind } from '@shared/types/cliUpdate.js'
import {
  coerceOpencodeUsageSource,
  coerceUserProviderOverrides,
  type OpencodeUsageSource,
  type UserProviderOverrides,
} from '@shared/types/providerEnablement.js'
import type { SetupToolId } from '@shared/types/setup.js'

const SETUP_STATE_FILE = join(STATE_DIR, 'setup.json')

/** Per-CLI persisted cache of the last successful latest-version probe
 *  plus the GitHub ETag we used to conditional-GET it. Persisting the
 *  ETag is the entire point of the "clever" cheap-poll design: on every
 *  launch we send it back and get a 304 with no body when nothing
 *  changed. Losing the ETag between launches (e.g. a corrupt setup.json)
 *  costs one full-body GitHub roundtrip — inconvenient but not broken.
 *
 *  `lastCheckedAt` isn't used to gate the next check (we check on every
 *  launch — see cliLatestVersion.ts for why the cache TTL is intentionally
 *  zero); it's kept for debug attribution ("when did we last hear from
 *  the network?"). */
export type CliUpdateCacheEntry = {
  latestVersion: string
  etag: string | null
  lastCheckedAt: number
}

export type PersistedSetupState = {
  version: 1
  toolPaths: Partial<Record<SetupToolId, string>>
  // WHY a second map instead of a flag on toolPaths entries: toolPaths is
  // the *effective* resolution cache — checkPrerequisites and
  // revalidateToolchain overwrite it freely with whatever the probes find,
  // and that churn is correct for auto-resolved paths (a new volta shim
  // SHOULD replace a stale /usr/local copy). A manual override from
  // setup:set-tool-path is different in kind: it is the user's explicit
  // word, and codex review of #504 caught that storing it only in the
  // shared map let the very next auto-probe silently erase it (user's
  // ~/bin/claude-wrapper replaced by PATH's /usr/local/bin/claude).
  // Keeping user intent in its own map means the auto writers can stay
  // dumb — they never have to know which toolPaths entries are sacred —
  // while the two auto-resolution entry points (checkPrerequisites,
  // revalidateToolchain) consult this map first and skip the auto layers
  // for a still-valid override. Absent from setup.json files written
  // before this field existed; loadSetupState defaults it to {} so no
  // version bump / migration is needed.
  manualToolPaths: Partial<Record<SetupToolId, string>>
  skippedOptionalTools: Partial<Record<SetupToolId, boolean>>
  /**
   * The user answered "continue without an agent provider" (#995).
   *
   * WHY this is persisted rather than a per-run flag: a deliberate
   * terminal-only user answered the first-run panel once, and an in-memory
   * flag made it reopen on every launch AND in every new window — each window
   * is its own renderer process with its own store (#995 Codex review). The
   * skipped-helper answer above is durable for exactly the same reason.
   * Absent from setup.json files written before this field existed;
   * loadSetupState defaults it, so no migration is needed.
   */
  acknowledgedNoProviders: boolean
  // Auto-updater behavior + cache. Same "additive, no version bump"
  // rationale as manualToolPaths: absent from older setup.json blobs,
  // loadSetupState defaults it, no migration path required. The
  // behavior lives here (main-process-owned) rather than in the
  // renderer's Settings so we don't have to bump the Zustand persist
  // version every time we tweak the update policy — a class of bug that
  // already burned us twice (#249, #494). See @shared/types/cliUpdate.ts
  // for the behavior union.
  cliUpdateBehavior: CliUpdateBehavior
  cliUpdateCache: Partial<Record<CliUpdateKind, CliUpdateCacheEntry>>
  // User's explicit provider on/off word (#1102). Only overrides persist —
  // detection is recomputed, so these entries stay meaningful across
  // installs/uninstalls. Same additive-field, no-version-bump rationale as
  // manualToolPaths above; coerced defensively at load.
  providerEnablementOverrides: UserProviderOverrides
  // Which OpenCode-configured provider the usage surface should report
  // (#1102/#1104). 'zai' has no reader until #1104 lands.
  opencodeUsageSource: OpencodeUsageSource
  updatedAt: number
}

const DEFAULT_SETUP_STATE: PersistedSetupState = {
  version: 1,
  toolPaths: {},
  manualToolPaths: {},
  skippedOptionalTools: {},
  acknowledgedNoProviders: false,
  cliUpdateBehavior: 'automatic',
  cliUpdateCache: {},
  providerEnablementOverrides: {},
  opencodeUsageSource: 'none',
  updatedAt: 0,
}

// WHY saves are UPDATES applied to the last DURABLE state (#1250 rows 6 and
// 13, #1403 review round 1): the first fix kept a whole next-state per save
// and restored the previous cache on failure. Reviewers a, b and c showed
// that cannot be made true, because every save was BUILT from the optimistic
// cache:
//   - two queued saves that both fail: the second "restored" the first one's
//     unwritten state, so main acted on a value no write ever landed;
//   - a failing save followed by a good one: the good one's snapshot carried
//     the failed value to disk, while the renderer had just said "Nothing was
//     changed".
// So a save is now a function of the state it applies to. At write time it is
// applied to `durable` (what is known to be on disk), never to another save's
// unwritten result, and a failed update simply drops out. Readers still see
// every change at once: `cache` is `durable` with the still-pending updates
// applied in order, recomputed whenever one settles.
//
// Invariant: `cache` === fold(pending, durable) after every settle, and
// nothing written to disk ever contains an update whose own write failed.
export type SetupStateUpdate = (state: PersistedSetupState) => PersistedSetupState

let durable: PersistedSetupState | null = null
let cache: PersistedSetupState | null = null
const pending: SetupStateUpdate[] = []
let writeQueue: Promise<void> = Promise.resolve()

function recomputeCache(): PersistedSetupState {
  const next = pending.reduce<PersistedSetupState>((state, update) => update(state), durable ?? DEFAULT_SETUP_STATE)
  cache = next
  return next
}

// One first read, shared. Two concurrent first loads used to read the file
// twice; with a durable baseline that matters, because a read that finishes
// AFTER a save's write would reset `durable` to the pre-write file.
let loading: Promise<void> | null = null

export async function loadSetupState(): Promise<PersistedSetupState> {
  if (cache) return cache
  loading ??= readDurable()
  await loading
  // Folds in any update queued while the first read was in flight.
  return recomputeCache()
}

async function readDurable(): Promise<void> {
  try {
    const raw = await readFile(SETUP_STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedSetupState>
    durable = {
      version: 1,
      toolPaths: parsed.toolPaths ?? {},
      manualToolPaths: parsed.manualToolPaths ?? {},
      skippedOptionalTools: parsed.skippedOptionalTools ?? {},
      acknowledgedNoProviders: parsed.acknowledgedNoProviders === true,
      // Coerce the CLI-update fields defensively: a hand-edited setup.json
      // with a stray string for cliUpdateBehavior must not throw at load —
      // fall back to 'automatic'. Same discipline as customAppearance in
      // the renderer settings coercer.
      cliUpdateBehavior:
        parsed.cliUpdateBehavior === 'automatic' ||
        parsed.cliUpdateBehavior === 'notify' ||
        parsed.cliUpdateBehavior === 'off'
          ? parsed.cliUpdateBehavior
          : 'automatic',
      cliUpdateCache: parsed.cliUpdateCache ?? {},
      providerEnablementOverrides: coerceUserProviderOverrides(
        parsed.providerEnablementOverrides,
      ),
      opencodeUsageSource: coerceOpencodeUsageSource(parsed.opencodeUsageSource),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    }
  } catch {
    durable = DEFAULT_SETUP_STATE
  }
  recomputeCache()
}

/** Apply `update` and persist the result. Rejects when the write fails, and
 *  then the update is gone: neither the cache nor any later write carries it. */
export async function updateSetupState(update: SetupStateUpdate): Promise<PersistedSetupState> {
  // Only the very first save awaits the read. Once loaded, the update is
  // visible to readers synchronously, as the old whole-state assignment was.
  if (!cache) await loadSetupState()
  pending.push(update)
  // An update that throws must never stay pending (#1403 verification c):
  // the cache would show forever a change no write could apply.
  try {
    recomputeCache()
  } catch (error) {
    pending.splice(pending.indexOf(update), 1)
    recomputeCache()
    throw error
  }
  const write = writeQueue
    .catch(() => {})
    .then(async () => {
      // Settle bookkeeping INSIDE the queue step, so the next queued update
      // is applied to this one's outcome and never to its unwritten result.
      const settle = (): void => {
        pending.splice(pending.indexOf(update), 1)
        recomputeCache()
      }
      let snapshot: PersistedSetupState
      try {
        // Inside the try, so a throwing update settles like a failed write.
        snapshot = {
          ...update(durable ?? DEFAULT_SETUP_STATE),
          version: 1,
          updatedAt: Date.now(),
        }
        await mkdir(STATE_DIR, { recursive: true })
        // WHY setup state uses the same temp+rename discipline as workspace
        // state even though the single-process lock should prevent concurrent
        // app mains:
        //
        // Setup paths are user-visible configuration. A failed write should not
        // leave `setup.json` truncated and force the user through tool discovery
        // again. Temp+rename gives atomic visibility to readers; it is not a full
        // fsync durability protocol for power-loss recovery, which would be a
        // separate requirement.
        const tmp = `${SETUP_STATE_FILE}.${process.pid}.${Date.now()}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`
        try {
          await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
          await rename(tmp, SETUP_STATE_FILE)
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => undefined)
          throw err
        }
      } catch (err) {
        settle()
        throw err
      }
      durable = snapshot
      settle()
    })
  writeQueue = write
  await write
  return recomputeCache()
}

/** Whole-state replacement. Kept for callers that already hold a complete
 *  state; prefer `updateSetupState` so the change is applied to what is on
 *  disk rather than to a state read before other saves settled. */
export async function saveSetupState(
  next: PersistedSetupState,
): Promise<PersistedSetupState> {
  return await updateSetupState(() => next)
}

export async function updateToolPaths(
  paths: Partial<Record<SetupToolId, string | null>>,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => {
    const toolPaths = { ...state.toolPaths }
    for (const [tool, path] of Object.entries(paths) as Array<[SetupToolId, string | null]>) {
      if (path) toolPaths[tool] = path
      else delete toolPaths[tool]
    }
    return { ...state, toolPaths }
  })
}

// Records a user-supplied override from setup:set-tool-path. Writes BOTH
// maps: manualToolPaths is the durable record of user intent (what makes
// the override win over future auto-probes — see the type comment above),
// and toolPaths is the effective cache that refreshToolchainFromState /
// applyToolEnv consume immediately, so the override takes effect in the
// same round-trip instead of waiting for the next checkPrerequisites
// write-back. Callers are expected to have validated the path (executable
// regular file) BEFORE calling — this module stays pure bookkeeping.
export async function setManualToolPath(
  tool: SetupToolId,
  path: string,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({
    ...state,
    manualToolPaths: { ...state.manualToolPaths, [tool]: path },
    toolPaths: { ...state.toolPaths, [tool]: path },
  }))
}

export async function markOptionalSkipped(
  tool: SetupToolId,
  skipped: boolean,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({
    ...state,
    skippedOptionalTools: {
      ...state.skippedOptionalTools,
      [tool]: skipped,
    },
  }))
}

/** Records that the user chose to continue with no provider installed. */
export async function markNoProvidersAcknowledged(): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({ ...state, acknowledgedNoProviders: true }))
}

/** Persist the user's CLI auto-update preference. Written by the setting
 *  row in the renderer via IPC — same shape as markOptionalSkipped:
 *  pure bookkeeping over the persisted state. */
export async function setCliUpdateBehavior(
  behavior: CliUpdateBehavior,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({ ...state, cliUpdateBehavior: behavior }))
}

/** Replace the provider-enablement override map (#1102). Whole-map write,
 *  for callers that own the entire map; per-provider changes go through
 *  `setProviderEnablementOverride`. */
export async function setProviderEnablementOverrides(
  overrides: UserProviderOverrides,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({ ...state, providerEnablementOverrides: overrides }))
}

/** Set (or with `null`, clear) ONE provider's enablement override. WHY
 *  per key (#1403 review): the settings row used to compute the whole next
 *  map from the optimistic cache, so a map built while an earlier toggle's
 *  write was still pending carried that toggle to disk even when its own
 *  write failed. Applied at write time to the durable map, a failed toggle
 *  cannot ride along with a later one. */
export async function setProviderEnablementOverride(
  kind: keyof UserProviderOverrides,
  enabled: boolean | null,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => {
    const overrides = { ...state.providerEnablementOverrides }
    if (enabled === null) delete overrides[kind]
    else overrides[kind] = enabled
    return { ...state, providerEnablementOverrides: overrides }
  })
}

/** Persist the selected OpenCode usage source (#1102/#1104). */
export async function setOpencodeUsageSource(
  opencodeUsageSource: OpencodeUsageSource,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({ ...state, opencodeUsageSource }))
}

/** Persist a successful latest-version probe. Called after every non-error
 *  cliLatestVersion query so the next launch can start with a known-good
 *  ETag (Codex) and version (Claude). Failed probes leave the previous
 *  cache untouched — the whole point of the "on failure keep last state"
 *  degradation. */
export async function updateCliUpdateCache(
  cli: CliUpdateKind,
  entry: CliUpdateCacheEntry,
): Promise<PersistedSetupState> {
  return await updateSetupState(state => ({
    ...state,
    cliUpdateCache: { ...state.cliUpdateCache, [cli]: entry },
  }))
}
