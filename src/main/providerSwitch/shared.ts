import type { AgentProviderKind } from '@shared/types/providerKind.js'
// Shared fs + transcript helpers used by both switchProvider and
// duplicateSession.
//
// WHY split: the two features read/write the same transcript shapes
// (Claude per-cwd jsonl, Codex date-bucketed rollout), so helpers
// get duplicated if they live in feature files. Moving them here
// keeps each feature file focused on its own translation / cloning
// logic without re-implementing path math and jsonl IO.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, mkdir, open, readdir, rm, stat } from 'fs/promises'
import { dirname, join } from 'path'

import { getProjectDirForCwd } from '@shared/runtime/projectDir.js'
import { getCodexSessionsDir } from '@providers/codex/runtime/projectDir.js'
import { getMainProvider } from '@providers/registry.main.js'

// ---------------------------------------------------------------------------
// JSONL io
// ---------------------------------------------------------------------------

export function encodeJsonl(items: readonly unknown[]): string {
  // Append-oriented JSONL in both providers — trailing newline keeps
  // the result aligned with native writers and avoids odd diffs when
  // debugging translated files by hand.
  return `${items.map(item => JSON.stringify(item)).join('\n')}\n`
}

/**
 * How long an abandoned stage may sit before a later publish sweeps it (#928
 * review, finding 4).
 *
 * Generous on purpose: the only thing that distinguishes an abandoned stage
 * from one being written right now is age, and deleting a live stage out from
 * under a concurrent publish would recreate the corruption this file exists to
 * prevent. An hour is far longer than any publish and far shorter than
 * "forever", which is what it was before.
 */
const STALE_STAGE_MS = 60 * 60 * 1000

/**
 * Publish a projected native transcript so that nothing can ever discover a
 * PARTIAL one (#928).
 *
 * ── WHAT WAS WRONG ──
 * Both writers called `writeFile` on the final, discoverable native filename —
 * `~/.claude/projects/<slug>/<uuid>.jsonl`, `~/.codex/sessions/<y>/<m>/<d>/
 * rollout-<ts>-<uuid>.jsonl`. `writeFile` truncates and then streams, so a
 * crash, a full disk or a killed process mid-write leaves a TRUNCATED file
 * under exactly the name the provider enumerates and will happily resume from.
 * Validating the projection in memory first cannot help: the projection was
 * perfect, the bytes on disk are not.
 *
 * ── WHAT AN EXISTING TARGET MEANS, HONESTLY ──
 * An earlier draft said an existing target is "overwhelmingly our own retry
 * after an interruption". Review showed that is false: every entry point —
 * switchProvider, duplicateSession, rewindSession, stripCodexCyberPolicy —
 * mints a fresh `randomUUID()` immediately before projecting, and the
 * projector stamps it on every row, so a retry produces a NEW filename. No
 * caller can currently produce the retry that claim describes.
 *
 * So the identical-contents branch is what it is: a safety net that keeps this
 * function idempotent, and a guard against a uuid collision. The
 * recovery-receipt half of #928 — "recognize completed publication without
 * duplicate creation" — is NOT delivered here, because delivering it needs a
 * stable retry id threaded from whatever would do the retrying, and there is
 * no retry wrapper between the IPC handler and this writer to hang one on.
 *
 * ── WHY link() IS THE PREFERRED PUBLISH ──
 * `rename` is atomic but it CLOBBERS. The target name embeds a session id, so
 * anything already there is either our own completed publish or a session
 * another process adopted, and overwriting the second is exactly the "never
 * delete a target adopted by another process" rule this must not break. `link`
 * is the atomic create-exclusive primitive: it either creates the name or
 * fails EEXIST, with no window in between and no way to destroy an incumbent.
 * It also refuses to follow a symlink at the target, so a symlinked name
 * cannot defeat the guarantee.
 *
 * ── WHY THERE IS A FALLBACK, AND WHAT IT COSTS ──
 * `link` is not available everywhere. Review measured `ENOTSUP` on a real
 * FAT32 volume, and both provider roots are user-settable (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`) — an exFAT external drive or a network mount is an ordinary
 * setup. `writeFile` worked there before this change, so failing outright
 * would be a regression, and the raw errno libuv produces for it
 * ("operation not supported on socket") explains nothing.
 *
 * So when the filesystem cannot link, we create the target with `wx` — still
 * atomic create-exclusive, so no-clobber survives — and write into it. What is
 * given up is the zero-width window: for the duration of the write the final
 * name exists holding partial bytes. That is strictly no worse than the
 * behaviour this PR replaces, which truncated the name first, and it is the
 * best the filesystem offers. The distinction is recorded on the result so a
 * caller (and a reader) can tell which guarantee they actually got.
 *
 * ── DURABILITY ──
 * The bytes are fsynced before the file has a discoverable name. The directory
 * fsync afterwards is best-effort, because opening a directory for read is not
 * portable, and the ordering guarantee that matters is already established by
 * the file fsync.
 *
 * ── MODE ──
 * 0600, where `writeFile` previously produced 0644 under a typical umask. A
 * transcript is conversation content; the tighter mode matches the Grok writer
 * and the state directory. Called out because it is a silent change to files
 * a user may already have.
 */
export async function publishNativeTranscript(
  filePath: string,
  contents: string,
): Promise<{ path: string; atomic: boolean }> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  await sweepStaleStages(directory)
  // Staged in the SAME directory: `link` cannot cross a filesystem, and a temp
  // dir may well be on another one. The suffix keeps a partial file from ever
  // matching the providers' own discovery globs (`*.jsonl`, `rollout-*.jsonl`),
  // so an abandoned stage is inert rather than resumable.
  const staged = join(directory, `${STAGE_PREFIX}${randomUUID()}.partial`)
  try {
    await writeStage(staged, contents)
    try {
      await link(staged, filePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        if (await sameContents(filePath, contents)) return { path: filePath, atomic: true }
        throw new Error(
          `Refusing to overwrite ${filePath}: a different transcript already exists under that name.`,
        )
      }
      if (!LINK_UNSUPPORTED.has(code ?? '')) throw error
      await publishWithoutLink(filePath, contents)
      await syncDirectory(directory)
      return { path: filePath, atomic: false }
    }
    await syncDirectory(directory)
    return { path: filePath, atomic: true }
  } finally {
    // The staged copy is ours alone and is never the published name, so
    // removing it can never touch an adopted target.
    await rm(staged, { force: true }).catch(() => undefined)
  }
}

/** Errors that mean "this filesystem has no hard links", not "this failed". */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
const STAGE_PREFIX = '.agent-code-publish-'

async function writeStage(staged: string, contents: string): Promise<void> {
  const handle = await open(staged, 'wx', 0o600)
  let written = false
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    written = true
  } finally {
    // WHY the close error is only allowed to surface on the success path: a
    // deferred write error is commonly reported at close, so on a failing
    // write `close()` throwing would REPLACE the real ENOSPC with something
    // far less useful. On the success path a close failure is itself the only
    // evidence that the write did not land, so it must not be swallowed.
    if (written) await handle.close()
    else await handle.close().catch(() => undefined)
  }
}

/**
 * Create the final name exclusively and write into it, for filesystems with no
 * hard links. No-clobber survives (`wx` fails EEXIST); atomicity does not.
 */
async function publishWithoutLink(filePath: string, contents: string): Promise<void> {
  let handle
  try {
    handle = await open(filePath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (await sameContents(filePath, contents)) return
    throw new Error(
      `Refusing to overwrite ${filePath}: a different transcript already exists under that name.`,
    )
  }
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Is the file already exactly these bytes?
 *
 * ── WHY SIZE THEN HASH, AND NOT readFile ──
 * Review measured the largest real rollout on the owner's machine at 325 MB,
 * whose `readFile(…, 'utf8')` cost a 577 MB RSS spike in the MAIN process — in
 * a codebase with a documented OOM history — and anything past Node's 512 MB
 * string limit throws outright. Comparing the byte length first is O(1) and
 * settles almost every case; the streamed hash never holds more than a chunk.
 *
 * A read failure answers FALSE, which routes to "refusing to overwrite". That
 * is the safe direction: an incumbent we cannot read is one we must not
 * destroy.
 */
async function sameContents(filePath: string, contents: string): Promise<boolean> {
  const expected = Buffer.from(contents, 'utf8')
  try {
    const info = await stat(filePath)
    if (info.size !== expected.byteLength) return false
    const actual = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) actual.update(chunk as Buffer)
    return actual.digest('hex') === createHash('sha256').update(expected).digest('hex')
  } catch {
    return false
  }
}

/**
 * Remove stages abandoned by an interrupted publish (#928 review, finding 4).
 *
 * Nothing else ever would: Claude's own retention sweep skips anything that is
 * not `.jsonl`/`.cast`, Codex's rollout maintenance only parses
 * `rollout-*.jsonl`, and Agent Code's debug retention never looks outside
 * STATE_DIR. A stage that survives a `link` plus a failed `rm` is a SECOND
 * HARD LINK to the inode, so the bytes are never reclaimed even after the
 * provider ages the transcript out — and a dotfile is invisible in Finder, so
 * nobody would ever find it.
 *
 * Best-effort in every direction: this is hygiene, and a publish must not fail
 * because a neighbouring file could not be tidied.
 */
async function sweepStaleStages(directory: string): Promise<void> {
  try {
    const now = Date.now()
    for (const name of await readdir(directory)) {
      if (!name.startsWith(STAGE_PREFIX) || !name.endsWith('.partial')) continue
      const staged = join(directory, name)
      const info = await stat(staged).catch(() => null)
      if (!info || now - info.mtimeMs < STALE_STAGE_MS) continue
      await rm(staged, { force: true }).catch(() => undefined)
    }
  } catch {
    // Hygiene only.
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  } catch {
    // Best-effort; see the WHY above.
  }
}

// ---------------------------------------------------------------------------
// Claude: per-cwd project dir, flat `<sessionId>.jsonl`
// ---------------------------------------------------------------------------

export async function getClaudeSessionFilePath(
  cwd: string,
  providerSessionId: string,
): Promise<string> {
  // Source reads must follow the same native relocation as live observation
  // and history pagination. Only the projection writer below creates a new
  // session at the target cwd; reusing that path math here strands rewind and
  // provider switching after EnterWorktree even when the visible feed recovers.
  const file = await getMainProvider('claude').resolveTranscriptPath(cwd, providerSessionId)
  if (!file) throw new Error(`Claude transcript not found for session ${providerSessionId}`)
  return file
}

export async function writeProjectedClaudeSessionFile(
  cwd: string,
  values: readonly Record<string, unknown>[],
): Promise<string> {
  const providerSessionId = projectedClaudeSessionId(values)
  const projectDir = await getProjectDirForCwd(cwd)
  const filePath = join(projectDir, `${providerSessionId}.jsonl`)
  return (await publishNativeTranscript(filePath, encodeJsonl(values))).path
}

// ---------------------------------------------------------------------------
// Codex: date-bucketed `<year>/<month>/<day>/rollout-<ts>-<uuid>.jsonl`
// ---------------------------------------------------------------------------

export async function findCodexRolloutPathBySessionId(
  providerSessionId: string,
): Promise<string | null> {
  const sessionsDir = getCodexSessionsDir()
  const matches: Array<{ path: string; mtimeMs: number }> = []
  await walkCodexRollouts(sessionsDir, async filePath => {
    if (!filePath.endsWith(`-${providerSessionId}.jsonl`)) return
    try {
      const fileStat = await stat(filePath)
      matches.push({ path: filePath, mtimeMs: fileStat.mtimeMs })
    } catch {
      // Ignore files that disappeared mid-scan.
    }
  })
  if (matches.length === 0) return null
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.path ?? null
}

export async function findCodexRolloutPathsBySessionIds(
  providerSessionIds: readonly string[],
): Promise<Map<string, string>> {
  const targets = [...new Set(providerSessionIds.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  const latest = new Map<string, { path: string; mtimeMs: number }>()
  if (targets.length === 0) return new Map()

  // WHY fleet lookup gets a dedicated one-walk helper: the provider registry's
  // single-session resolver is the right primitive for resume, but calling it
  // once per Agent Management row would rescan the entire date-bucketed Codex
  // sessions tree N times. One walk with the same newest-mtime tie-break keeps
  // canonical path semantics while making project inventory proportional to
  // the transcript tree, not agents × transcript tree.
  await walkCodexRollouts(getCodexSessionsDir(), async filePath => {
    const providerSessionId = targets.find(id => filePath.endsWith(`-${id}.jsonl`))
    if (!providerSessionId) return
    try {
      const fileStat = await stat(filePath)
      const current = latest.get(providerSessionId)
      if (!current || fileStat.mtimeMs > current.mtimeMs) {
        latest.set(providerSessionId, { path: filePath, mtimeMs: fileStat.mtimeMs })
      }
    } catch {
      // Match the single-session resolver: disappearing/unreadable candidates
      // are absent rather than fatal to the rest of the project inventory.
    }
  })
  return new Map([...latest].map(([id, value]) => [id, value.path]))
}

export async function resolveProviderTranscriptPath(params: {
  kind: AgentProviderKind
  cwd: string
  providerSessionId: string
}): Promise<string | null> {
  // WHY this helper lives beside provider-switch cloning helpers instead of in
  // one caller: transcript ownership is a provider storage contract. History
  // pagination, transcript-template resolution, duplicate/rewind flows, and
  // provider switching must agree on the exact same path semantics or the UI can
  // resume one durable file while older-history pagination reads another. The
  // provider registry owns those semantics now: Claude follows native worktree
  // relocation for an exact session UUID, while Codex resolves a global rollout
  // file by structured thread id. Delegating here lets history loading,
  // transcript templates, and provider
  // templates share one call site without moving provider-specific storage rules
  // back into each feature. Provider-switch/duplicate/rewind still use the
  // Codex-specific helper above when they need the source path directly, and
  // that helper intentionally uses the same mtime tie-break as the registry.
  return getMainProvider(params.kind).resolveTranscriptPath(
    params.cwd,
    params.providerSessionId,
  )
}

export async function walkCodexRollouts(
  dir: string,
  onFile: (filePath: string) => Promise<void>,
  depth = 0,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const fullPath = join(dir, name)
    try {
      const fileStat = await stat(fullPath)
      if (fileStat.isDirectory() && depth < 3) {
        await walkCodexRollouts(fullPath, onFile, depth + 1)
        continue
      }
      if (fileStat.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        await onFile(fullPath)
      }
    } catch {
      // Ignore unreadable entries while scanning the sessions tree.
    }
  }
}

export async function writeProjectedCodexRolloutFile(
  values: readonly Record<string, unknown>[],
): Promise<string> {
  const sessionMeta = projectedCodexSessionMeta(values)
  const timestamp = resolveCodexRolloutTimestamp(sessionMeta.timestamp)
  const sessionsDir = getCodexSessionsDir()
  const dayDir = join(
    sessionsDir,
    String(timestamp.getUTCFullYear()),
    pad2(timestamp.getUTCMonth() + 1),
    pad2(timestamp.getUTCDate()),
  )
  const filename = `rollout-${formatCodexRolloutTimestamp(timestamp)}-${sessionMeta.id}.jsonl`
  const filePath = join(dayDir, filename)
  return (await publishNativeTranscript(filePath, encodeJsonl(values))).path
}

export function projectedClaudeSessionId(values: readonly Record<string, unknown>[]): string {
  const sessionId = values.find(value => (
    typeof value.sessionId === 'string' && value.sessionId.length > 0
  ))?.sessionId
  if (typeof sessionId !== 'string') {
    throw new Error('Projected Claude transcript did not contain a sessionId.')
  }
  return sessionId
}

export function projectedCodexSessionMeta(
  values: readonly Record<string, unknown>[],
): { id: string; timestamp: string } {
  for (const value of values) {
    if (value.type !== 'session_meta' || !isRecord(value.payload)) continue
    if (typeof value.payload.id !== 'string' || typeof value.payload.timestamp !== 'string') continue
    return { id: value.payload.id, timestamp: value.payload.timestamp }
  }
  throw new Error('Projected Codex rollout did not contain valid session metadata.')
}

export function resolveCodexRolloutTimestamp(raw: string): Date {
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed) : new Date()
}

export function formatCodexRolloutTimestamp(date: Date): string {
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    `${pad2(date.getUTCHours())}-${pad2(date.getUTCMinutes())}-${pad2(date.getUTCSeconds())}`,
  ].join('T')
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
