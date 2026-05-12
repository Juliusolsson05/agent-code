import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import { sanitizeHtml } from '@renderer/lib/sanitizeHtml'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import {
  exportDebugTraceFiles,
  recordHtmlTraceSnapshot,
  recordScreenTailSnapshot,
} from '@renderer/features/debug/renderTrace'
import { summarizeWorktreeActivity } from '@renderer/workspace/work-context/debug'

// saveDebugBundle — assemble-and-ship side of the "Save Debug Logs"
// command. Runs in the renderer because every data source the
// bundle needs is renderer-local:
//   - DebugPanel's state view       → workspace.getRuntime(sid)
//   - FeedDebugPanel's log          → runtime.feedDebugLog (in-memory
//                                      cap 500; the full series is
//                                      already on disk in feed-debug/,
//                                      but we still write the current
//                                      in-memory slice because it's
//                                      the exact data the panel was
//                                      showing at save time)
//   - ProxyDebugPanel's semantic    → runtime.semantic
//   - HtmlDebugPanel's capture      → document.querySelector by
//                                      data-pane-id
//   - Sanitized HTML                → @renderer/lib/sanitizeHtml
//
// Shipping that cross-process would mean exporting the Zustand store
// shape, the DOM, and sanitizeHtml's detached-document logic into
// main — a huge amount of code movement for a one-shot feature. This
// module stringifies everything locally and hands main a flat list
// of files. Main owns filesystem layout + returns the absolute path.

const BUNDLE_SCHEMA_VERSION = 1

// Files present in every bundle. Declared as a typed const so the
// manifest can list them without duplication, and so any downstream
// tool that wants to machine-read a bundle has a stable contract.
const FILE_NAMES = {
  manifest: 'manifest.json',
  state: 'state-snapshot.json',
  feedDebug: 'feed-debug.jsonl',
  workContext: 'work-context.json',
  semantic: 'proxy-semantic.json',
  htmlRaw: 'html-raw.html',
  htmlClean: 'html-clean.html',
  // Wire-level proxy capture (mitm for Claude, ResponsesProxy for
  // Codex). Files are populated only when the session was started
  // with `useProxy: true` AND the proxy actually wrote any events.
  // For sessions without a proxy log, these entries are simply
  // omitted from the file list — the manifest reflects the actual
  // contents.
  //
  // proxy-events.jsonl carries the request/response wire log:
  // headers (allowlist), request body (≤ 2 MiB or tailed), response
  // chunks, request_shape, etc. See
  // main/storage/proxyEventsReader.ts for the tail cap and search
  // strategy.
  //
  // proxy-session-meta.json is the run dir's session-meta.json,
  // written by the proxy at start. Carries cwd / sessionKey /
  // createdAt context.
  proxyEvents: 'proxy-events.jsonl',
  proxySessionMeta: 'proxy-session-meta.json',
} as const

// Screen text can be tens of KB of ANSI-stripped terminal buffer.
// For the state snapshot we keep only the tail — the DebugPanel UI
// itself only ever shows the last 20 lines (DebugPanel.tsx:29), and
// the broader screen buffer is already available to the user via
// copy-assistant or the reader. 200 lines is generous enough to
// include recent tool output context but stops the snapshot from
// ballooning on very long-lived panes.
const SCREEN_TAIL_LINES = 200
export const AUTO_DEBUG_BUNDLE_INTERVAL_MS = 60_000

function tailLines(text: string, count: number): string {
  const lines = text.split('\n')
  if (lines.length <= count) return text
  return lines.slice(lines.length - count).join('\n')
}

type BundleFile = { name: string; content: string }

// Build a state snapshot from the runtime with non-serializable and
// overly-heavy fields removed. WHY each exclusion:
//
//   entries / toolUseIndex / toolResultIndex / ghosts
//     Maps don't JSON-serialize, and `entries` can be thousands of
//     long records — the raw JSONL is the source of truth, available
//     on disk and via Claude/Codex's own session files. Duplicating
//     it here would bloat bundles for zero debugging value.
//
//   feedDebugLog / semantic
//     Shipped as their own files (feed-debug.jsonl and
//     proxy-semantic.json). Double-embedding them in state-snapshot
//     would create drift risk if the format ever changes.
//
//   screen / screenMarkdown / recentScreen / recentScreenMarkdown
//     Tail-truncated to SCREEN_TAIL_LINES.
function buildStateSnapshot(runtime: SessionRuntime): Record<string, unknown> {
  const {
    entries: _entries,
    toolUseIndex: _toolUseIndex,
    toolResultIndex: _toolResultIndex,
    ghosts: _ghosts,
    feedDebugLog: _feedDebugLog,
    semantic: _semantic,
    screen,
    screenMarkdown,
    recentScreen,
    recentScreenMarkdown,
    ...rest
  } = runtime
  void _entries
  void _toolUseIndex
  void _toolResultIndex
  void _ghosts
  void _feedDebugLog
  void _semantic

  return {
    ...rest,
    screen: tailLines(screen, SCREEN_TAIL_LINES),
    screenMarkdown: tailLines(screenMarkdown, SCREEN_TAIL_LINES),
    recentScreen: tailLines(recentScreen, SCREEN_TAIL_LINES),
    recentScreenMarkdown: tailLines(recentScreenMarkdown, SCREEN_TAIL_LINES),
    // Counts are preserved so you can see "there were 2145 entries
    // in the feed" without having to open the JSONL.
    _counts: {
      entries: runtime.entries.length,
      feedDebugLog: runtime.feedDebugLog.length,
      queuedMessages: runtime.queuedMessages.length,
      toolUseIndex: runtime.toolUseIndex.size,
      toolResultIndex: runtime.toolResultIndex.size,
      ghosts: runtime.ghosts.size,
      semanticLog: runtime.semantic.log.length,
      semanticErrors: runtime.semantic.errors.length,
    },
  }
}

// Feed-debug entries already carry `ts` (wall-clock ms) and `tMs`
// (offset from epoch of the session's first entry). The user asked
// for "timestamps" explicitly — we add `tsIso` so the file is
// grep-able without shell date arithmetic. Order of keys is chosen
// to put the human-readable timestamp first, then the numeric ones,
// then the payload — makes `less` / `jq -c .` readable.
function serializeFeedDebugJsonl(runtime: SessionRuntime): string {
  const lines = runtime.feedDebugLog.map(entry =>
    JSON.stringify({
      tsIso: new Date(entry.ts).toISOString(),
      ts: entry.ts,
      tMs: entry.tMs,
      id: entry.id,
      layer: entry.layer,
      kind: entry.kind,
      summary: entry.summary,
      data: entry.data,
    }),
  )
  // Trailing newline so `cat` / `tail -f` play nice, and so appending
  // (should we ever extend this) doesn't require a pre-write newline
  // check. Empty case: still emit an empty file rather than no file —
  // the manifest.files listing should always match what's on disk.
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

// Proxy semantic state is richer than feed-debug (nested turns,
// blocks, flows). Rather than transform it aggressively, we dump it
// as-is and add an ISO-augmented mirror of the two timestamped
// arrays (`log` and `errors`) alongside the originals. Consumers
// who want the raw numeric ts still have it; consumers who want to
// skim in a text editor have the ISO version.
function serializeSemanticJson(runtime: SessionRuntime): string {
  const s = runtime.semantic
  const payload = {
    _timestampHint:
      'All `ts` fields are Unix ms (Date.now()). `logWithIso` and ' +
      '`errorsWithIso` mirror `log` and `errors` with an extra tsIso ' +
      'field injected for readability.',
    currentTurn: s.currentTurn,
    history: s.history,
    flows: s.flows,
    errors: s.errors,
    errorsWithIso: s.errors.map(err => ({
      ...err,
      tsIso: new Date(err.ts).toISOString(),
    })),
    log: s.log,
    logWithIso: s.log.map(entry => ({
      ...entry,
      tsIso: new Date(entry.ts).toISOString(),
    })),
    nextLogId: s.nextLogId,
  }
  return JSON.stringify(payload, null, 2)
}

// Capture the focused pane's DOM. Same anchor as HtmlDebugPanel —
// TileLeaf stamps `data-pane-id` on its root so no React ref
// plumbing is needed. If the pane isn't mounted (e.g. capture
// fired during a tree rebuild), we still emit empty files rather
// than failing the whole bundle — the other four files are
// independently useful and the user can re-run the command.
function capturePaneHtml(sessionId: string): { raw: string; clean: string } {
  const node = document.querySelector(`[data-pane-id="${sessionId}"]`)
  if (!(node instanceof HTMLElement)) {
    return { raw: '', clean: '' }
  }
  const raw = node.outerHTML
  const clean = sanitizeHtml(raw)
  return { raw, clean }
}

function buildManifest(
  sessionId: string,
  runtime: SessionRuntime,
  kind: string,
  capturedAt: number,
  files: string[],
  reason: string,
  proxyRunDir: string | null,
): string {
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    sessionId,
    kind,
    reason,
    projectDir: runtime.projectDir,
    capturedAt,
    capturedAtIso: new Date(capturedAt).toISOString(),
    files,
    // Pointer to the FULL proxy log on disk. The bundled
    // proxy-events.jsonl is tail-capped at
    // PROXY_EVENTS_BUNDLE_MAX_BYTES (5 MiB at the time of writing —
    // see main/storage/proxyEventsReader.ts); anything older than
    // that tail still lives at this path. Null when the session had
    // no proxy capture at all.
    proxyRunDir,
    // Small bits of runtime state that help orient a consumer
    // without parsing state-snapshot.json first. Deliberately a
    // flat summary, not a duplicate.
    summary: {
      sessionStatus: runtime.sessionStatus,
      streamPhase: runtime.streamPhase,
      activityStatus: runtime.activityStatus,
      entries: runtime.entries.length,
      feedDebugLog: runtime.feedDebugLog.length,
      semanticLog: runtime.semantic.log.length,
      semanticErrors: runtime.semantic.errors.length,
    },
  }
  return JSON.stringify(manifest, null, 2)
}

/**
 * Entry point called by the palette command. Builds the files,
 * ships them to main, then hands the path back so the caller can
 * surface it (copy + toast).
 *
 * Throws on IPC failure; the command handler is responsible for
 * catching and showing a user-visible error.
 */
export async function assembleAndSaveDebugBundle(params: {
  sessionId: string
  runtime: SessionRuntime
  kind: string
  reason?: string
  /** Working directory of the session, used to locate the matching
   *  proxy-events run dir under ~/.config/cc-shell/proxy/. Optional
   *  because sessions that ran without proxy capture (or callers
   *  that don't have the cwd handy) should still produce a bundle —
   *  the proxy section just gets omitted. */
  cwd?: string
  /** providerSessionId (Claude resume id, Codex thread id). When
   *  present, the proxy reader narrows its search to the matching
   *  `resume-<id>` session segment. Falls back to scanning every
   *  session segment under the cwd if absent or unmatched. */
  providerSessionId?: string | null
}): Promise<{ bundlePath: string }> {
  const { sessionId, runtime, kind, reason = 'manual', cwd, providerSessionId } = params
  const capturedAt = Date.now()
  const includeProxyPayload = reason === 'manual'
  await window.api.flushPerformance().catch(() => {})
  const performanceSnapshot = await window.api.getPerformanceSnapshot().catch(() => null)

  const html = capturePaneHtml(sessionId)
  recordHtmlTraceSnapshot(sessionId, html.raw, 'manual')
  recordScreenTailSnapshot(sessionId, runtime.recentScreen)

  // Manual bundles include a bounded proxy tail because a human just
  // asked for a forensic snapshot. Autosave bundles intentionally skip
  // that payload: the full proxy run remains under ~/.config/cc-shell/proxy
  // and retention now budgets that root directly. Copying the same tail into
  // every minute-level autosave was one of the multipliers behind the 108 GB
  // debug-bundles directory; autosave should preserve orientation, not create
  // a second archive of already-persisted wire logs.
  const proxySection = cwd && includeProxyPayload
    ? await window.api.readProxyEvents({
        cwd,
        sessionKey: providerSessionId ? `resume-${providerSessionId}` : null,
      }).catch(() => null)
    : null

  const files: BundleFile[] = [
    {
      name: FILE_NAMES.manifest,
      content: '',
    },
    {
      name: FILE_NAMES.state,
      content: JSON.stringify(buildStateSnapshot(runtime), null, 2),
    },
    {
      name: FILE_NAMES.feedDebug,
      content: serializeFeedDebugJsonl(runtime),
    },
    {
      name: FILE_NAMES.workContext,
      content: JSON.stringify(summarizeWorktreeActivity(runtime.workActivity), null, 2),
    },
    {
      name: FILE_NAMES.semantic,
      content: serializeSemanticJson(runtime),
    },
    { name: FILE_NAMES.htmlRaw, content: html.raw },
    { name: FILE_NAMES.htmlClean, content: html.clean },
    // Proxy section is conditional. Only emit the files when the
    // reader found something — otherwise the manifest would list
    // entries that don't exist on disk, which is worse than a quiet
    // omission. The reader returns nulls for missing/unreadable
    // logs.
    ...(proxySection?.proxyEvents
      ? [{ name: FILE_NAMES.proxyEvents, content: proxySection.proxyEvents }]
      : []),
    ...(proxySection?.sessionMeta
      ? [{ name: FILE_NAMES.proxySessionMeta, content: proxySection.sessionMeta }]
      : []),
    ...exportDebugTraceFiles(sessionId),
    ...(performanceSnapshot?.files ?? []),
  ]

  files[0] = {
    name: FILE_NAMES.manifest,
    content: buildManifest(
      sessionId,
      runtime,
      kind,
      capturedAt,
      files.map(file => file.name),
      reason,
      // Pass the resolved run dir so the manifest can document where
      // the FULL log lives on disk — bundle tail capture is bounded
      // at PROXY_EVENTS_BUNDLE_MAX_BYTES, anything earlier is still
      // available there.
      proxySection?.runDir ?? null,
    ),
  }

  return window.api.saveDebugBundle({ sessionId, files })
}

export type AutoDebugBundleReason =
  | 'autosave-enabled'
  | 'autosave-interval'
  | 'autosave-beforeunload'

export type AutoDebugBundleResult = {
  saved: Array<{ sessionId: string; bundlePath: string }>
  failed: Array<{ sessionId: string; message: string }>
}

export async function autosaveActiveAgentDebugBundles(
  workspace: Workspace,
  reason: AutoDebugBundleReason,
): Promise<AutoDebugBundleResult> {
  const candidates = Object.entries(workspace.runtimes)
    .filter(([sessionId, runtime]) => {
      const meta = workspace.state.sessions[sessionId]
      const kind = meta?.kind ?? 'claude'
      return (kind === 'claude' || kind === 'codex') && runtime.exited === null
    })

  const saved: AutoDebugBundleResult['saved'] = []
  const failed: AutoDebugBundleResult['failed'] = []

  const saveOne = async ([sessionId, runtime]: [string, SessionRuntime]) => {
    const meta = workspace.state.sessions[sessionId]
    const kind = meta?.kind ?? 'claude'
    try {
      const { bundlePath } = await assembleAndSaveDebugBundle({
        sessionId,
        runtime,
        kind,
        reason,
        // cwd + providerSessionId let the assembler pull the latest
        // proxy-events.jsonl into the bundle. Both come from the
        // session metadata Workspace already tracks; no new
        // plumbing needed.
        cwd: meta?.cwd,
        providerSessionId: meta?.providerSessionId ?? null,
      })
      saved.push({ sessionId, bundlePath })
    } catch (err) {
      failed.push({
        sessionId,
        message: (err as Error)?.message ?? String(err),
      })
    }
  }

  if (reason === 'autosave-beforeunload') {
    // Before unload, starting every save promptly matters more than
    // keeping disk pressure perfectly smooth: once the renderer is
    // gone, the DOM/runtime-only parts of the bundle are gone too.
    // Launch all bundle writes immediately so each IPC request has
    // the best chance of reaching main before teardown.
    await Promise.all(candidates.map(saveOne))
  } else {
    // Sequential saves keep disk pressure bounded. These bundles can
    // include DOM, semantic, feed-debug, trace, and performance tails;
    // running N panes in parallel would make the autosave feature
    // itself a source of rendering jank exactly when we're trying to
    // diagnose rendering bugs.
    for (const candidate of candidates) {
      await saveOne(candidate)
    }
  }

  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[debug-autosave] some bundles failed', failed)
  }

  return { saved, failed }
}

// Thin wrapper that resolves the focused pane, calls the assembler,
// copies the resulting path to the clipboard, and routes user
// feedback through showPaneToast. Kept here (not in sessionCommands)
// so the command file stays focused on palette registration and so
// this logic is reusable if we ever surface the command elsewhere
// (e.g. a keybinding or a right-click menu).
export async function runSaveDebugBundleCommand(workspace: Workspace): Promise<void> {
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return
  const meta = workspace.state.sessions[sessionId]
  const runtime = workspace.getRuntime(sessionId)
  const kind = meta?.kind ?? 'claude'

  try {
    const { bundlePath } = await assembleAndSaveDebugBundle({
      sessionId,
      runtime,
      kind,
      cwd: meta?.cwd,
      providerSessionId: meta?.providerSessionId ?? null,
    })

    // Best-effort clipboard copy. A denied clipboard permission
    // shouldn't hide the fact that the save succeeded — we still
    // toast the path so the user can select it from the pane.
    let clipboardOk = true
    try {
      await navigator.clipboard.writeText(bundlePath)
    } catch {
      clipboardOk = false
    }

    // Toast duration overrides the default 2000ms. The user needs
    // time to read a full filesystem path; 6 seconds is long enough
    // to copy-by-eye even on a slow reader, short enough not to
    // stick around forever. The path IS the message — including it
    // verbatim (not truncated) matters because the user might need
    // to paste into a terminal that wraps differently from the
    // toast layout.
    const prefix = clipboardOk ? 'saved · copied path · ' : 'saved (clipboard blocked) · '
    workspace.showPaneToast(sessionId, `${prefix}${bundlePath}`, 6000)
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    workspace.showPaneToast(sessionId, `save failed: ${msg}`, 4000)
    // eslint-disable-next-line no-console
    console.warn('[save-debug-bundle] failed', err)
  }
}
