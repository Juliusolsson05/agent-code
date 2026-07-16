import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

import { STATE_DIR } from '@main/storage/paths.js'
import { detectCliInstallMethod } from '@main/setup/cliInstallMethod.js'
import { queryLatestVersion } from '@main/setup/cliLatestVersion.js'
import { compareSemver, readInstalledVersion, severity } from '@main/setup/cliVersion.js'
import { loadSetupState, updateCliUpdateCache } from '@main/setup/setupState.js'
import type { CliUpdateCacheEntry } from '@main/setup/setupState.js'
import { runShellCommand } from '@main/setup/shell.js'
import { getToolPath } from '@main/setup/toolchain.js'
import type { SessionManager } from '@main/sessionManager.js'
import type {
  CliInstallMethod,
  CliUpdateBehavior,
  CliUpdateKind,
  CliUpdateSnapshot,
  CliUpdateState,
} from '@shared/types/cliUpdate.js'
import { DEFAULT_CLI_UPDATE_SNAPSHOT } from '@shared/types/cliUpdate.js'

// CLI update orchestrator.
//
// One instance per app run. Owns:
//   - the in-memory CliUpdateSnapshot the renderer mirrors
//   - the boot-time probe schedule (one per CLI, in parallel)
//   - the actual update spawn when a CLI is behind
//   - failure-mode classification (command-failed vs version-unchanged vs
//     timeout vs network)
//
// Emits `state` after every transition. The IPC layer subscribes and
// pushes the full snapshot to the renderer. Full-snapshot rather than
// per-CLI so the renderer only needs one message to draw the whole
// banner, and there's no ordering hazard when two CLIs transition in
// rapid succession.
//
// WHY the SessionManager dependency:
//   Updating a CLI whose binary is currently being executed by a live
//   session is safe on POSIX (the running process holds its file
//   handle; the new binary replaces the inode for future spawns) but
//   corrupts things on Windows (file lock), and either way races the
//   session's own config-file writes. The orchestrator refuses to
//   update a CLI whose sessions are currently spawned by us. See the
//   `deferred` state — silent, and the next launch tries again.

// One-shot per-CLI concurrency guard. The orchestrator's `run()` is
// callable multiple times (boot + manual "check now" from the settings
// page) but must not run two updates on the same CLI concurrently: they
// would race on npm's lockfile / the native installer's cache directory.
type PerCliMutex = { claude: boolean; codex: boolean }

/** Where per-run update logs are stored. One file per run so investigation
 *  after a failure has the full stdout+stderr. Retention isn't automated
 *  here — these are small (~KB) and the diagnostic value of a two-year-old
 *  failed-update log is nonzero; if this ever grows large enough to
 *  matter, wire it into debugRetention.ts alongside the other roots. */
const CLI_UPDATE_LOG_DIR = join(STATE_DIR, 'cli-update-logs')

/** Update-command timeout. The npm dispatch can genuinely take ~60 s
 *  when postinstall builds the platform binary; brew is faster but the
 *  first `brew update` (which brew silently runs on `brew upgrade`) can
 *  hit the 60 s mark. 120 s is generous enough that we don't false-fail
 *  a healthy update, tight enough that a truly stuck command (interactive
 *  prompt waiting for confirmation) doesn't hang the app forever. */
const UPDATE_TIMEOUT_MS = 120_000

// Boot-time delay before the first probe fires. The very-first-launch
// case is the reason: on install day, the user wants Agent Code to open
// and be usable RIGHT NOW; a synchronous network probe against
// registry.npmjs.org that adds 100 ms to the first paint would be a
// visible tax. 500 ms after boot the window is interactive and the
// initial state is drawn, and any latency the probe adds is invisible.
const BOOT_PROBE_DELAY_MS = 500

type OrchestratorEvents = {
  state: [CliUpdateSnapshot]
}

// Small strongly-typed emitter. We don't need node's EventEmitter symbol
// dance beyond `on/emit` here, but keeping it as EventEmitter under the
// hood means the IPC layer can subscribe using the standard `.on('state',
// handler)` pattern that every other main-side broadcaster uses.
export interface CliUpdateOrchestrator {
  on<K extends keyof OrchestratorEvents>(
    event: K,
    listener: (...args: OrchestratorEvents[K]) => void,
  ): this
  off<K extends keyof OrchestratorEvents>(
    event: K,
    listener: (...args: OrchestratorEvents[K]) => void,
  ): this
}

export function hasActiveCliLease(
  manager: Pick<SessionManager, 'list' | 'getSessionKind'>,
  cli: CliUpdateKind,
  hasActiveWorkflow?: (cli: CliUpdateKind) => boolean,
): boolean {
  // Workflow attempts launch outside SessionManager, so checking only visible terminal sessions
  // can replace Codex between two agents in one durable run. Keep the app-owned workflow lease in
  // the same decision function so boot probes, manual updates, and tests cannot drift apart.
  if (hasActiveWorkflow?.(cli) === true) return true
  for (const sessionId of manager.list()) {
    // getSessionKind returns null for terminals — irrelevant here.
    if (manager.getSessionKind(sessionId) === cli) return true
  }
  return false
}

export class CliUpdateOrchestrator extends EventEmitter {
  private snapshot: CliUpdateSnapshot = DEFAULT_CLI_UPDATE_SNAPSHOT
  private readonly running: PerCliMutex = { claude: false, codex: false }

  constructor(
    private readonly manager: SessionManager,
    private readonly options: { hasActiveWorkflow?: (cli: CliUpdateKind) => boolean } = {},
  ) {
    super()
  }

  /** Current authoritative snapshot. Freshly-attached IPC subscribers use
   *  this to draw the initial state without waiting for the next event. */
  getSnapshot(): CliUpdateSnapshot {
    return this.snapshot
  }

  /** Kick off the boot-time probe. Called from main/index.ts after
   *  initializeToolchain() completes. Idempotent: repeated calls before
   *  the first probe finishes are collapsed into one via the per-CLI
   *  mutex. Runs in the background — never `await`ed by the caller,
   *  because a 5 s network probe on the boot path would delay the window
   *  from appearing. */
  scheduleBootProbe(): void {
    // Deliberately delayed so window paint precedes the probe. See the
    // constant's WHY.
    setTimeout(() => {
      void this.probeAll().catch(err => {
        console.warn('[cli-update] boot probe failed:', err)
      })
    }, BOOT_PROBE_DELAY_MS)
  }

  /** Force a fresh probe on demand — invoked by the IPC handler that
   *  the "Check for updates now" button in Settings dispatches. Runs
   *  both CLIs in parallel; returns when both settle. */
  async refresh(): Promise<CliUpdateSnapshot> {
    await this.probeAll()
    return this.snapshot
  }

  /** Run a one-shot update for the given CLI, bypassing the behavior
   *  gate. Used by the banner's "Update now" button in notify mode:
   *  the user asked for THIS update to run without switching to
   *  automatic mode for every future launch.
   *
   *  Correctness review caught the previous implementation flipping
   *  behavior to 'automatic' permanently — surprising and irreversible
   *  from the user's perspective. This path leaves the persisted
   *  behavior untouched and runs the same update pipeline the
   *  automatic path uses (session-active check + spawn + re-probe +
   *  failure classification). */
  async updateOnce(cli: CliUpdateKind): Promise<CliUpdateSnapshot> {
    // Same mutex as scheduled probes — never let a manual click race
    // an in-flight automatic update on the same CLI.
    if (this.running[cli]) return this.snapshot
    this.running[cli] = true
    try {
      await this.updateOnceInner(cli)
    } finally {
      this.running[cli] = false
    }
    return this.snapshot
  }

  private async updateOnceInner(cli: CliUpdateKind): Promise<void> {
    const binary = getToolPath(cli, '')
    if (!binary) return
    const installed = await readInstalledVersion(binary)
    if (!installed.ok) return

    // Read the latest from cache first — the click follows a notify
    // banner which was populated from a fresh probe, so cachedVersion
    // is authoritative here. We do NOT re-query the network on click:
    // the click is "please act on what the banner said", not "please
    // re-check freshness."
    const setup = await loadSetupState()
    const cachedLatest = setup.cliUpdateCache[cli]?.latestVersion
    const latestVersion = cachedLatest ?? ''
    if (!latestVersion || compareSemver(installed.version, latestVersion) >= 0) {
      // Nothing to do — either the banner was stale (cache empty) or
      // an earlier auto-run beat us to it. Silent.
      return
    }

    const installMethod = await detectCliInstallMethod(binary)
    if (this.hasActiveSession(cli)) {
      this.updateSnapshot(cli, {
        kind: 'deferred',
        cli,
        from: installed.version,
        wantedLatest: latestVersion,
        reason: 'session-active',
        checkedAt: Date.now(),
      })
      return
    }
    await this.runUpdate(cli, {
      binary,
      from: installed.version,
      to: latestVersion,
      installMethod,
    })
  }

  /** Persist the user's behavior preference and update our in-memory
   *  copy. Does NOT re-probe — the setting change only affects future
   *  transitions. Turning the feature off between launches means the
   *  next launch skips the probe entirely. */
  async setBehavior(behavior: CliUpdateBehavior): Promise<void> {
    this.snapshot = { ...this.snapshot, behavior }
    this.emit('state', this.snapshot)
  }

  /** Load the persisted preference. Called once during construction from
   *  main/index.ts so the in-memory snapshot reflects setup.json before
   *  the renderer connects. */
  async loadInitialBehavior(): Promise<void> {
    const state = await loadSetupState()
    this.snapshot = { ...this.snapshot, behavior: state.cliUpdateBehavior }
    this.emit('state', this.snapshot)
  }

  /** Run probe + (maybe) update for both CLIs, in parallel. Both
   *  networks are independent; the CLIs are independent; there's no
   *  reason to serialize. */
  private async probeAll(): Promise<void> {
    if (this.snapshot.behavior === 'off') {
      // Feature entirely disabled. Leave state as `idle` — the renderer
      // hides the banner, nothing to say.
      return
    }
    await Promise.all([this.probeOne('claude'), this.probeOne('codex')])
  }

  private async probeOne(cli: CliUpdateKind): Promise<void> {
    if (this.running[cli]) return
    this.running[cli] = true
    try {
      await this.probeOneInner(cli)
    } finally {
      this.running[cli] = false
    }
  }

  private async probeOneInner(cli: CliUpdateKind): Promise<void> {
    const binary = getToolPath(cli, '')
    if (!binary) {
      // CLI not resolved. The SetupGate flow handles "install this
      // missing tool"; the update flow is a no-op here. Leave the state
      // as whatever it was (idle by default) — silent.
      return
    }
    const installed = await readInstalledVersion(binary)
    if (!installed.ok) {
      // Same treatment as "not resolved": whatever went wrong with the
      // spawn is the setup flow's problem, not ours. Silent-fall-through
      // covers the "user just uninstalled it out from under Agent Code"
      // case without producing a scary banner.
      return
    }
    // Read the cached ETag before the network call, so GitHub can 304
    // us. Losing this cache (fresh install, corrupted setup.json) costs
    // one full-body response — inconvenient but not broken.
    const setup = await loadSetupState()
    const cached = setup.cliUpdateCache[cli]
    const cachedEtag = cached?.etag ?? null
    const cachedVersion = cached?.latestVersion ?? null

    const latest = await queryLatestVersion(cli, cachedEtag)
    let latestVersion: string
    let newEtag: string | null
    if (latest.ok && 'notModified' in latest) {
      // GitHub 304 — nothing changed since we cached. Reuse the cached
      // version+etag. This is the whole point of the ETag path.
      if (!cachedVersion) {
        // 304 with no cachedVersion is only possible if setup.json was
        // hand-edited or partially corrupted between the fetch that gave
        // us the etag and now. Clear the etag so the NEXT launch does an
        // unconditional refetch — otherwise GitHub keeps 304-ing us and
        // we're permanently stuck with no version to compare against.
        // (Correctness review: the previous comment claimed this cleared
        // the etag but the code silently returned instead.)
        await updateCliUpdateCache(cli, {
          latestVersion: '',
          etag: null,
          lastCheckedAt: Date.now(),
        })
        return
      }
      latestVersion = cachedVersion
      newEtag = cachedEtag
    } else if (latest.ok) {
      latestVersion = latest.version
      newEtag = latest.etag
    } else {
      // Network failure. Fall back to the last-known-good cache, if any.
      // No user-visible banner: the user can't do anything about
      // registry.npmjs.org being down, and Agent Code itself works
      // regardless. Log for diagnostic value.
      if (!cachedVersion) return
      latestVersion = cachedVersion
      newEtag = cachedEtag
    }

    // Persist the fresh cache regardless of the up-to-date/behind decision
    // below — the next launch benefits either way. Only successful (or
    // 304-cached) latest reads write here; a network failure leaves the
    // previous cache untouched.
    const entry: CliUpdateCacheEntry = {
      latestVersion,
      etag: newEtag,
      lastCheckedAt: Date.now(),
    }
    await updateCliUpdateCache(cli, entry)

    const installMethod = await detectCliInstallMethod(binary)
    const cmp = compareSemver(installed.version, latestVersion)
    if (cmp >= 0) {
      // Up-to-date. Emit the state so the renderer can render a subtle
      // "Codex ✓ 0.144.0" indicator if it chooses, or nothing at all —
      // that's a UI decision. State is authoritative regardless.
      this.updateSnapshot(cli, {
        kind: 'up-to-date',
        installed: installed.version,
        latest: latestVersion,
        installMethod,
        checkedAt: Date.now(),
      })
      return
    }

    // Behind. What happens next depends on the user's behavior setting.
    // Re-read behavior HERE (not from the closure at probeAll entry)
    // because probeOneInner awaits the network — a user who flipped the
    // setting from 'automatic' to 'off' or 'notify' during those seconds
    // must NOT get an update they explicitly said they don't want.
    // Correctness review caught the previous version defaulting the
    // 'off' branch to auto-update.
    const sev = severity(installed.version, latestVersion) ?? 'patch'
    const currentBehavior = this.snapshot.behavior
    if (currentBehavior === 'off') {
      // Turned off mid-probe. Leave state untouched so the banner stays
      // silent; the cache was updated above so the next launch after
      // switching back on has the latest version pre-loaded.
      return
    }
    if (currentBehavior === 'notify') {
      this.updateSnapshot(cli, {
        kind: 'notify',
        cli,
        installed: installed.version,
        latest: latestVersion,
        severity: sev,
        installMethod,
        checkedAt: Date.now(),
      })
      return
    }

    // behavior === 'automatic': run the update, unless a session of this
    // kind is currently spawned (see the class-level WHY on the
    // SessionManager dep).
    if (this.hasActiveSession(cli)) {
      this.updateSnapshot(cli, {
        kind: 'deferred',
        cli,
        from: installed.version,
        wantedLatest: latestVersion,
        reason: 'session-active',
        checkedAt: Date.now(),
      })
      return
    }

    await this.runUpdate(cli, {
      binary,
      from: installed.version,
      to: latestVersion,
      installMethod,
    })
  }

  private async runUpdate(
    cli: CliUpdateKind,
    ctx: { binary: string; from: string; to: string; installMethod: CliInstallMethod },
  ): Promise<void> {
    this.updateSnapshot(cli, {
      kind: 'updating',
      cli,
      from: ctx.from,
      to: ctx.to,
      installMethod: ctx.installMethod,
      startedAt: Date.now(),
    })

    const logPath = await this.openLog(cli)
    const command = updateCommandFor(cli, ctx.installMethod)
    let commandFailed = false
    let timedOut = false
    let commandOutput = ''
    try {
      // Route through runShellCommand so the update inherits the user's
      // curated PATH. On POSIX that's a login shell (bash -lc) so brew,
      // nvm, volta, asdf, bun, and pnpm shims are all discoverable. On
      // Windows PATH is inherited from the system env by every process,
      // so the runner dispatches PowerShell -Command instead. This is
      // the whole reason we drive the update ourselves instead of
      // trusting the CLI's own `claude update` / `codex update`: when
      // the CLI is spawned by Agent Code, its spawn context inherits
      // Electron's environment, which on POSIX does NOT include the
      // user's login-shell PATH additions. That's the documented Codex
      // banner-loop failure — the CLI runs `brew upgrade` without brew
      // on PATH and the update silently no-ops while the banner keeps
      // re-prompting.
      //
      // `2>&1` on POSIX merges stderr into stdout; PowerShell's `2>&1`
      // is the same syntax with the same meaning, so the command
      // literal is portable.
      const result = await runShellCommand(
        `${command} 2>&1`,
        {
          timeoutMs: UPDATE_TIMEOUT_MS,
          // 4 MB — npm's postinstall output can be verbose. Above this
          // the shell wrapper throws MaxBufferError and we treat it as
          // command-failed with a truncated log; below any healthy
          // update fits comfortably.
          maxBuffer: 4 * 1024 * 1024,
        },
      )
      commandOutput = result.stdout + result.stderr
    } catch (err) {
      // Distinguish timeout from generic failure. runLoginShell wraps
      // execFile which sets `killed` when the child was terminated by
      // the timer; we also see ETIMEDOUT on some Node versions.
      const nodeErr = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string }
      if (nodeErr.code === 'ETIMEDOUT' || nodeErr.killed) timedOut = true
      commandFailed = true
      commandOutput = String(nodeErr.stdout ?? '') + String(nodeErr.stderr ?? '') + `\n[Agent Code] update command errored: ${nodeErr.message}`
    }
    await appendLog(logPath, `$ ${command}\n${commandOutput}\n`)

    // Diagnostic context: which `<cli>` binaries exist on PATH, and what
    // does the resolved binary report after the update? The most common
    // "npm reports success, --version still stale" failure mode has a
    // multi-install root cause — Homebrew's Node.js and nvm both hold a
    // global copy, npm installed into one prefix, PATH resolves to the
    // other. Without this diagnostic in the log, "View log" shows only
    // the npm output ("changed 2 packages") and the user has no signal
    // that they have two `codex` binaries fighting for PATH.
    //
    // Best-effort: swallow errors and skip individual sections if the
    // probe fails. The log is diagnostic, not truth — the re-probe below
    // is what decides success.
    await appendDiagnostics(logPath, cli, ctx.binary)

    // Re-probe to see if the update stuck. This is the crucial step:
    // the Codex npm vendored-binary bug means the command can exit 0
    // and `<cli> --version` still reports the old number. Without this
    // re-probe we'd cheerfully claim success and let the CLI's own
    // banner nag the user forever.
    //
    // Correctness review caught that "any advance = success" is wrong:
    // if brew jumps to an intermediate version (e.g. the cask lags GH
    // releases by a version), we'd report success while still behind
    // the wanted latest, and the next launch would try to update again
    // and repeat forever. The success criterion is "reached OR passed
    // the target", not merely "advanced from the starting point".
    const after = await readInstalledVersion(ctx.binary)
    const afterVersion = after.ok ? after.version : ctx.from
    const reachedTarget = after.ok && compareSemver(afterVersion, ctx.to) >= 0

    if (reachedTarget) {
      const sev = severity(ctx.from, afterVersion) ?? 'patch'
      this.updateSnapshot(cli, {
        kind: 'updated',
        cli,
        from: ctx.from,
        to: afterVersion,
        severity: sev,
        installMethod: ctx.installMethod,
        finishedAt: Date.now(),
      })
      return
    }

    // Update didn't stick. Classify the failure so the banner can render
    // the right hint.
    const reason = timedOut
      ? 'timeout'
      : commandFailed
        ? 'command-failed'
        : 'version-unchanged'
    this.updateSnapshot(cli, {
      kind: 'failed',
      cli,
      from: ctx.from,
      wantedLatest: ctx.to,
      installMethod: ctx.installMethod,
      reason,
      logPath,
      finishedAt: Date.now(),
    })
  }

  private hasActiveSession(cli: CliUpdateKind): boolean {
    return hasActiveCliLease(this.manager, cli, this.options.hasActiveWorkflow)
  }

  private updateSnapshot(cli: CliUpdateKind, state: CliUpdateState): void {
    this.snapshot = { ...this.snapshot, [cli]: state }
    this.emit('state', this.snapshot)
  }

  private async openLog(cli: CliUpdateKind): Promise<string> {
    await mkdir(CLI_UPDATE_LOG_DIR, { recursive: true })
    // ISO timestamp with `:` replaced (Windows-friendly filename). One
    // file per attempt so a re-run doesn't overwrite the last failure's
    // log while a user is trying to inspect it.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return join(CLI_UPDATE_LOG_DIR, `${cli}-${stamp}.log`)
  }
}

/** Command to run for a given CLI + install method. Uses login-shell
 *  syntax — the caller wraps this in `runLoginShell(command)` so PATH is
 *  correct.
 *
 *  WHY not just call `<cli> update` for everything:
 *   The CLIs' own self-dispatchers exist (`claude update`, `codex
 *   update`) and would be simpler, but they're the source of the bugs
 *   we're trying to route around — Codex's dispatcher shells to `brew
 *   upgrade` without a login shell, and Claude's has a documented
 *   history of misdetecting native-vs-npm installs. Dispatching
 *   directly here means we know the exact command that ran, and if it
 *   fails the log actually shows a package-manager error the user can
 *   act on. `unknown` remains the "fall back to the CLI's dispatcher"
 *   path because if we don't know the install method, the CLI has
 *   better odds of getting it right than we do. */
function updateCommandFor(cli: CliUpdateKind, method: CliInstallMethod): string {
  if (cli === 'claude') {
    switch (method) {
      case 'native':
        // Claude's native installer supports `claude update` reliably —
        // it's what Anthropic's own auto-updater dispatches to. No PATH
        // gotchas here because the binary is self-contained.
        return 'claude update'
      case 'npm':
        // Explicit `@latest` because `npm update -g` respects the
        // original semver range and can fail to move to the newest
        // release (documented in the Claude docs). Never `sudo` —
        // if the prefix is not writable, we want the EACCES to surface
        // as a failure banner, not silently escalate privileges.
        return 'npm install -g @anthropic-ai/claude-code@latest'
      case 'brew':
        // Two Homebrew casks exist — `claude-code` (stable channel)
        // and `claude-code@latest`. We can't tell which one the user
        // installed from the binary path alone; `brew upgrade
        // claude-code` fails silently if only the @latest cask is
        // installed, and vice versa. Try both — the first hit wins,
        // the second no-ops. `-q` keeps output smaller in the log.
        return 'brew upgrade -q claude-code 2>/dev/null || brew upgrade -q claude-code@latest'
      case 'winget':
        // `--silent` skips the confirm prompt. WinGet still fails when
        // the target binary is locked by a running process; that's the
        // hasActiveSession guard's job to prevent.
        return 'winget upgrade --silent Anthropic.ClaudeCode'
      case 'unknown':
      default:
        return 'claude update'
    }
  }
  // Codex
  switch (method) {
    case 'native':
      // Codex standalone installer is idempotent — re-running it
      // upgrades in place. Split by platform because the install script
      // is a different URL and interpreter per OS. On Windows the
      // installer is PowerShell (irm | iex); on POSIX it's the sh-based
      // script. `CODEX_NON_INTERACTIVE=1` suppresses the "install
      // succeeded" prompt so the command exits cleanly.
      if (process.platform === 'win32') {
        return '$env:CODEX_NON_INTERACTIVE=1; irm https://chatgpt.com/codex/install.ps1 | iex'
      }
      return 'sh -c "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"'
    case 'npm':
      return 'npm install -g @openai/codex@latest'
    case 'brew':
      // The `--cask` is critical: an unrelated `codex` formula from
      // 2012 exists and `brew upgrade codex` (no --cask) may target
      // it. The OpenAI CLI ships as a cask. Brew never exists on
      // Windows, so this branch is POSIX-only in practice.
      return 'brew upgrade --cask codex'
    case 'unknown':
    default:
      return 'codex update'
  }
}

async function appendLog(logPath: string, chunk: string): Promise<void> {
  try {
    // `flag: 'a'` — the log path is unique per attempt but this file
    // opens once per attempt too, so we don't strictly need append. Use
    // it anyway so a future re-run into the same path (dev/manual)
    // doesn't stomp on the previous content.
    await writeFile(logPath, chunk, { flag: 'a' })
  } catch (err) {
    console.warn('[cli-update] failed to append log:', err)
  }
}

/** Post-update diagnostic dump. Runs three cheap probes and appends their
 *  output to the log so "View log" shows the multi-install situation
 *  without asking the user to open a terminal:
 *
 *    - `which -a <cli>` (POSIX) / `where.exe <cli>` (Windows): every
 *      copy of the binary on PATH, in PATH order. This is the single
 *      most useful signal — two lines usually means "the update landed
 *      on one but PATH resolves to the other."
 *    - `<resolvedBinary> --version`: what the binary we detected
 *      actually reports right now. Different from the re-probe below in
 *      that it's captured in the log for the user's own reading.
 *    - `echo $PATH` (POSIX only): order of PATH entries so the user can
 *      see which shim is winning. Trimmed to keep the log small.
 *
 *  Not routed through runShellCommand because we don't want a stuck
 *  probe to bleed into the update's success/failure classification —
 *  each probe has its own short timeout, and any error becomes a "diag
 *  section unavailable" line rather than a thrown exception. */
async function appendDiagnostics(logPath: string, cli: CliUpdateKind, binary: string): Promise<void> {
  const sections: string[] = ['\n--- Agent Code diagnostics ---\n']
  // 1. which -a / where.exe
  try {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? 'where.exe' : 'which'
    const args = isWin ? [cli] : ['-a', cli]
    const result = await execFileAsync(cmd, args, { timeout: 3_000, env: process.env })
    sections.push(`$ ${cmd} ${args.join(' ')}\n${result.stdout || result.stderr || '(no output)'}\n`)
  } catch (err) {
    // ENOENT on `which` would be exotic; on Windows the where.exe hit
    // may fail if PATH is unusually restricted. Either way, degrade
    // gracefully — a missing diagnostic section is still better than
    // aborting the whole log write.
    sections.push(`$ which -a ${cli}\n(diagnostic unavailable: ${(err as Error).message})\n`)
  }
  // 2. resolved binary --version
  try {
    const result = await execFileAsync(binary, ['--version'], {
      timeout: 3_000,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    })
    sections.push(`$ ${binary} --version\n${result.stdout || result.stderr || '(no output)'}\n`)
  } catch (err) {
    sections.push(`$ ${binary} --version\n(diagnostic unavailable: ${(err as Error).message})\n`)
  }
  // 3. PATH order (POSIX only — on Windows PATH is inherited from the
  // system env verbatim, less commonly the source of shadowing issues).
  if (process.platform !== 'win32') {
    const pathEntries = (process.env.PATH ?? '').split(':').filter(Boolean)
    sections.push(`$ echo $PATH | tr ':' '\\n'\n${pathEntries.join('\n')}\n`)
  }
  await appendLog(logPath, sections.join('\n'))
}
