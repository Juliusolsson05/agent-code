import type { AgentProviderKind } from '@shared/types/providerKind.js'
// Shared fs + transcript helpers used by both switchProvider and
// duplicateSession.
//
// WHY split: the two features read/write the same transcript shapes
// (Claude per-cwd jsonl, Codex date-bucketed rollout), so helpers
// get duplicated if they live in feature files. Moving them here
// keeps each feature file focused on its own translation / cloning
// logic without re-implementing path math and jsonl IO.

import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, rm, stat } from 'fs/promises'
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
 * What happened when a projected transcript was published (#928).
 *
 * `created` — this call wrote the file.
 * `already-published` — the exact same bytes were already there under that
 * name. A retry after an interruption between the publish and the caller's own
 * bookkeeping lands here, and it is a success, not a collision.
 */
export type PublishOutcome = 'created' | 'already-published'

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
 * perfect, the bytes on disk are not. A switch, duplicate or rewind that dies
 * halfway leaves a conversation that opens and is silently missing its tail.
 *
 * ── WHY link() AND NOT rename() ──
 * `rename` is atomic but it CLOBBERS. The target name embeds a session id, so
 * if something is already there it is either our own completed publish or a
 * session another process adopted — and overwriting the second is exactly the
 * "never delete a target adopted by another process" rule this must not break.
 * `link` is the atomic create-exclusive primitive: it either creates the name
 * or fails EEXIST, with no window in between and no way to destroy an
 * incumbent. The temporary file is unlinked afterwards, so the inode keeps one
 * name.
 *
 * ── WHY EEXIST IS NOT AUTOMATICALLY A FAILURE ──
 * We generated the session id in this process, so an existing target is
 * overwhelmingly our own retry after an interruption. Comparing the bytes
 * settles it without guessing: identical means the publish already happened
 * and the caller may proceed; different means a genuine collision, which
 * throws rather than destroying someone else's conversation.
 *
 * ── DURABILITY ──
 * The file is fsynced before it is given a discoverable name, and the
 * directory is fsynced after, so the name survives a power loss too. A
 * directory fsync is not portable — on some platforms opening a directory for
 * read fails — so it is best-effort and never fails the publish: the ordering
 * guarantee that matters (contents before name) is already established by the
 * file fsync.
 */
export async function publishNativeTranscript(
  filePath: string,
  contents: string,
): Promise<{ path: string; outcome: PublishOutcome }> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  // Staged in the SAME directory, because `link` cannot cross a filesystem and
  // a temp dir may well be on another one. The suffix keeps a partial file
  // from ever matching the providers' own discovery globs (`*.jsonl`,
  // `rollout-*.jsonl`), so an abandoned stage is inert rather than resumable.
  const staged = join(directory, `.${randomUUID()}.partial`)
  try {
    const handle = await open(staged, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(staged, filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readFile(filePath, 'utf8').catch(() => null)
      if (existing === contents) return { path: filePath, outcome: 'already-published' }
      throw new Error(
        `Refusing to overwrite ${filePath}: a different transcript already exists under that name.`,
      )
    }
    await syncDirectory(directory)
    return { path: filePath, outcome: 'created' }
  } finally {
    // The staged copy is ours alone and is never the published name, so
    // removing it can never touch an adopted target.
    await rm(staged, { force: true }).catch(() => undefined)
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
