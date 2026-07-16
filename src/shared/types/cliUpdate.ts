// CLI update check — shared wire types.
//
// The two provider CLIs Agent Code wraps (Claude Code, Codex) each have their
// own auto-update mechanism. Codex prints a big TUI banner ("✨ Update
// available! …") on every launch when behind, and Claude's own updater runs in
// the background but only for native/npm channels. Both mechanisms are
// unreliable when driven from Agent Code's spawn context: Codex's `codex
// update` shells out to `brew upgrade --cask codex` / `npm install -g` without
// a login shell, so PATH is missing brew/nvm/volta shims and the update fails
// silently while the TUI keeps re-prompting; Codex npm has a documented bug
// where the vendored per-platform binary in `@openai/codex-<triple>` doesn't
// advance even when the wrapper package does, so `codex --version` reports the
// old number after a "successful" update. Anthropic's auto-updater has its own
// catalog of documented failures around npm prefix mismatches (claude-code
// issues #31772, #22415, #55725).
//
// This module defines the wire types the main-process orchestrator publishes
// to the renderer so Agent Code's chrome can (a) auto-update the CLI on launch
// using a login-shell context that fixes the PATH problem, and (b) surface
// failures inline instead of hiding them inside a TUI banner the semantic
// renderer suppresses. See src/main/setup/cliUpdateOrchestrator.ts for the
// scheduling half of the story.

/** Which of the two agent CLIs a status entry describes. Terminal sessions
 *  and opencode intentionally have no auto-update surface here — the shell
 *  isn't a versioned CLI in the same sense, and opencode is not in scope for
 *  this PR. Adding a third entry means teaching the orchestrator the latest-
 *  version endpoint AND the update command per channel. */
export type CliUpdateKind = 'claude' | 'codex'

/** How the CLI was installed on disk, determined by matching the resolved
 *  binary path against known install roots. This drives the update command
 *  we invoke — Homebrew installs upgrade with `brew upgrade`, npm installs
 *  with `npm install -g @<pkg>@latest`, etc. `unknown` collapses to the
 *  CLI's own self-dispatcher (`claude update` / `codex update`), which
 *  works in most cases but is where the reliability failures come from.
 *
 *  Kept as a shared type so the renderer can render an accurate hint next
 *  to a failure banner without re-detecting; the main process is the
 *  authoritative decider. */
export type CliInstallMethod =
  | 'native' // Claude native installer under ~/.local/share/claude/versions/, or Codex standalone under ~/.local/bin/codex
  | 'npm' // path is inside a node_modules tree (nvm/volta/asdf/bun/pnpm/plain global — all classify as 'npm')
  | 'brew' // /opt/homebrew or /usr/local/Cellar (Homebrew Cellar) or /home/linuxbrew (Linuxbrew)
  | 'winget' // Windows: AppData\Local\Microsoft\WinGet
  | 'unknown'

/** Severity of the version delta between installed and latest. `patch` covers
 *  the noisy Claude case (30 releases/month, most are patches) — the UI can
 *  render patch bumps quieter than minor/major. `prerelease` shouldn't
 *  normally fire because we compare against the stable channel, but Codex
 *  publishes multiple alphas per day, so anyone opting into a bleeding-edge
 *  channel would end up here. */
export type CliUpdateSeverity = 'patch' | 'minor' | 'major' | 'prerelease'

/** What the orchestrator decided about this CLI on the most recent probe.
 *  The renderer treats each variant as a distinct banner state; see
 *  CliUpdateBanner.tsx for the rendering rules. */
export type CliUpdateState =
  /** Probe never ran, or the CLI is not installed on this machine (setup gate
   *  handles missing CLIs separately). The banner is silent. */
  | { kind: 'idle' }
  /** Probe ran and either both versions matched or we're actively fetching
   *  the latest. No user action needed. */
  | { kind: 'up-to-date'; installed: string; latest: string; installMethod: CliInstallMethod; checkedAt: number }
  /** An update is running right now — command is executing in the background.
   *  Rendered as a subtle "Updating <cli>…" banner. */
  | {
      kind: 'updating'
      cli: CliUpdateKind
      from: string
      to: string
      installMethod: CliInstallMethod
      startedAt: number
    }
  /** Update finished, version advanced. Cache is updated. Banner shows
   *  briefly if severity is minor/major, silent for patch. */
  | {
      kind: 'updated'
      cli: CliUpdateKind
      from: string
      to: string
      severity: CliUpdateSeverity
      installMethod: CliInstallMethod
      finishedAt: number
    }
  /** Update didn't stick — command exited 0 but version didn't advance
   *  (the Codex vendored-binary bug), or the command exited non-zero, or
   *  we timed out waiting. The banner is sticky and offers "View log". */
  | {
      kind: 'failed'
      cli: CliUpdateKind
      from: string
      wantedLatest: string
      installMethod: CliInstallMethod
      reason: CliUpdateFailureReason
      logPath: string
      finishedAt: number
    }
  /** Update was skipped because a session of this kind is currently spawned
   *  by the SessionManager. Replacing a binary while its process is running
   *  is safe on POSIX but corrupts things on Windows (file lock), and either
   *  way risks racing the update against config-file writes the running
   *  session performs. We retry on the next launch. Silent by default —
   *  users don't need a banner for "we'll do it later". */
  | {
      kind: 'deferred'
      cli: CliUpdateKind
      from: string
      wantedLatest: string
      reason: 'session-active'
      checkedAt: number
    }
  /** User told us not to auto-update (setting: 'off'), but a newer version
   *  is available. Renders a passive info banner offering to switch back
   *  on. When the setting is 'notify', this same variant is used with a
   *  more prominent action button. */
  | {
      kind: 'notify'
      cli: CliUpdateKind
      installed: string
      latest: string
      severity: CliUpdateSeverity
      installMethod: CliInstallMethod
      checkedAt: number
    }

export type CliUpdateFailureReason =
  /** The spawned update command exited non-zero. Log carries stderr/stdout. */
  | 'command-failed'
  /** Command exited 0 but `<cli> --version` still reports the old number.
   *  This catches the Codex vendored-binary bug and any silent no-op. */
  | 'version-unchanged'
  /** Command didn't finish in the timeout window. Likely stuck on an
   *  interactive prompt (brew confirm, npm audit, etc.) — hence the
   *  strict headless env we pass. */
  | 'timeout'
  /** `latest-version` fetch failed (network offline, rate-limited, DNS
   *  blocked). Not really a "failure" — we treat it as silent-degrade
   *  and retry next launch. Included here so the renderer can distinguish
   *  a broken update pipeline from a network hiccup. */
  | 'network'
  /** `<cli> --version` didn't produce a parseable semver. Usually means
   *  the CLI is not installed or the PATH entry points at something
   *  unexpected. */
  | 'unparseable-version'

/** User preference for how aggressive the auto-updater should be. Persisted
 *  in setup.json (not the renderer's settings.json) because setup.json is
 *  main-process-owned and already carries similar tool-config knobs
 *  (skippedOptionalTools, manualToolPaths). Keeping it there means no
 *  renderer store version bump is needed to add this.
 *
 *  `automatic` (default) is aggressive: on every launch, probe versions and
 *  spawn the update immediately if behind. Silent success, sticky banner
 *  on failure.
 *
 *  `notify` still probes on every launch but never spawns — it only surfaces
 *  a banner with an [Update now] button. For users who want awareness
 *  without background writes to their global npm/brew tree.
 *
 *  `off` disables everything. No probe, no banner, no state pushes. Useful
 *  for enterprise deploys where update policy is managed elsewhere
 *  (Anthropic's DISABLE_UPDATES env var is respected regardless, but this
 *  is the user-facing toggle). */
export type CliUpdateBehavior = 'automatic' | 'notify' | 'off'

/** Full renderer-facing snapshot: one entry per CLI plus the current
 *  preference. Pushed to the renderer via IPC on boot and after each
 *  state transition; the renderer treats it as authoritative and mirrors
 *  it into a Zustand slice for the banner to read. */
export type CliUpdateSnapshot = {
  claude: CliUpdateState
  codex: CliUpdateState
  behavior: CliUpdateBehavior
}

export const DEFAULT_CLI_UPDATE_SNAPSHOT: CliUpdateSnapshot = {
  claude: { kind: 'idle' },
  codex: { kind: 'idle' },
  behavior: 'automatic',
}
