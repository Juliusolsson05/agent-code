# Agent Status installed skills

Status: implemented; review rounds 1–3 findings fixed; no round-4 review, at the user's direction. Issue: #900. PR: #903.

## Outcome

The existing Agent Status panel lists Agent Code-managed skills and skills in
the selected provider's native/default discovery locations. Names, descriptions,
source labels, and file locations make the result useful without opening Settings.
This is an installed inventory, not a claim that the running model loaded a body.

## Design and ownership

1. Add a shared metadata-only inventory contract. Main owns filesystem discovery;
   the renderer supplies the selected provider/project context over typed IPC.
2. Keep provider-specific discovery rules behind the provider registry. Each
   adapter declares WHERE skills live and HOW each root is laid out (`children`,
   `recursive`, `commands`, plus hidden-folder, folder-symlink and namespace
   policy), derived from the vendored provider source rather than
   documentation. Each adapter owns its project ancestry and root order, because
   the providers stop at different boundaries and deduplicate first-wins. Never
   infer enabled plugins from caches alone.
3. Reuse a public, metadata-only managed-skill service projection to attribute
   Agent Code deployments. Paths come from the resolved target registry and the
   canonical document, never from UI `displayPath` strings. Do not import
   persistence/ownership internals or introduce another writer. Skill bodies
   remain in main and do not enter diagnostics, IPC, or the status UI.
4. Bound all filesystem work with one budget (root probes, listings, entries,
   and metadata reads), fence symlink cycles per root walk, deduplicate physical
   files across roots, cap failure notices, and surface incomplete discovery.
   Opening the panel performs no installations, configuration mutations, native
   prompts, or provider process launches.
5. Add an Installed Skills section following existing dense semantic styling.
   Fetch on target/context changes, explicit refresh, and managed-skill updates;
   fence stale responses and show loading, empty, partial/error, and shell states.
   Provider-disabled skills stay listed and are marked Disabled.
6. Update command search metadata and feature reference to mention skills.

## Validation

- Deterministic filesystem tests use isolated temporary roots, covering managed
  attribution, per-provider layouts, boundaries and root order, plugin
  resolution, duplicates, symlinks, malformed or oversized metadata, the shared
  budget, and source failures without executing skills.
- Renderer tests cover the displayed inventory, disabled marking,
  empty/error/terminal states, refreshing, and switching targets while
  discovery is pending.
- Run focused tests, both TypeScript projects, and CI `quality-gate`.
- Review with independent Claude and Codex agents; merge only when both are clean.
  After round 3 the user chose to merge once its findings were fixed, without a
  further review round.

## Constraints

Provider discovery and activation differ. Report actual discovered files and
known exclusions; do not hard-code a supposedly complete list of bundled skills
or label a disk inventory as the running agent's loaded context. Inline WHY
comments explain each provider rule and asynchronous ownership boundary.

## Implemented scope

- Claude (`loadSkillsDir.ts`, `markdownConfigLoader.ts`, `git.ts`,
  `pluginLoader.ts`): policy, user, and project `skills/` folders as direct
  children only (dot-folders included); project ancestry from cwd up to the
  nearest `.git` (file or directory), never home. Legacy `commands/` Markdown is
  scanned recursively, with SKILL.md owning its folder. A validated linked
  worktree without its own commands falls back to the main checkout's; the
  `worktrees/` parent and gitdir back-link checks apply, and bare-repo worktrees
  resolve to the common dir. Plugin enablement comes from user, launch-directory
  project/local, and policy settings; project installs must match the launch
  directory exactly. Manifest `skills`/`commands` paths replace the defaults and
  must stay inside the plugin. Command-only plugins are listed. Bundled skills
  compiled into the CLI are disclosed as unlisted.
- Codex (`host_roots.rs`, `loader/`, `core-plugins`, `utils/plugins`): root order
  is project `.codex/skills` layers, then `$CODEX_HOME/skills`,
  `~/.agents/skills`, `.system` defaults (unless `skills.bundled.enabled =
  false`; folder symlinks ignored), `/etc/codex/skills`, plugins, and finally
  repo `.agents/skills` from the `project_root_markers` root (default `.git`) to
  cwd. Host roots are recursive to six segments with hidden folders skipped.
  Plugins are enabled unless `enabled = false`, and the loaded version is `local`
  or the highest SemVer. Agent Plugins (root `plugin.json` with the exact v1.0.0
  schema and a valid name) always use `./skills` direct children; other
  agent-plugins.org schemas reject the plugin. Legacy
  `.codex-plugin`/`.claude-plugin`/`.cursor-plugin` manifests reject the plugin
  when their folder or file is not real, and use `./`-relative, `..`-free
  declared paths that replace `skills/`, plus migrated command skills; a blank
  legacy name falls back to the plugin folder name. Agent Plugin skills whose
  real path leaves the plugin are rejected. Plugin skills are named
  `<plugin>:<name>`, and host-root skills get Codex's discovered namespace (a
  linked skill's real-location manifest, a plugin-shaped folder inside the root,
  or a manifest above the root). `[[skills.config]]` rules (one selector,
  trimmed names) and Agent Code's session-level operator exclusion mark skills
  Disabled. Remote-catalog plugins and project-config plugin/skill settings are
  disclosed.
- OpenCode (`skill/index.ts`, `config/paths.ts`): `.claude`/`.agents` `skills/**`
  (hidden included) at home and from cwd up to the worktree, and
  `{skill,skills}/**` in the XDG config dir, `~/.opencode`, project `.opencode`,
  and `OPENCODE_CONFIG_DIR`. Disable flags are parsed case-insensitively, as
  OpenCode does. `skills.paths`/`skills.urls` are disclosed as unlisted.

## Review round 1 (Claude + Codex orchestration agents, both CHANGES REQUIRED)

Confirmed against vendored provider source and fixed in `951d7a0e`, each with a
regression test:

- Claude project walk crossed the git root, and ancestor settings/installs
  controlled plugins.
- A single generic walk matched no provider; replaced by per-root layouts.
- Metadata reads under skill-path roots bypassed the scan budget.
- Plugin resolution gaps for both providers, and escaping manifest paths.
- Missing Codex `.codex/skills` and OpenCode roots/flags.
- Disabled Codex skills presented as usable.
- Managed attribution parsed the UI `displayPath`.

## Review round 2 (both CHANGES REQUIRED; all round-1 fixes confirmed)

Confirmed and fixed, each with a regression test:

- (Codex) Missing command roots and root probes were not charged to the budget.
- (Codex) Agent Plugins manifests were read with legacy rules (declared
  `skills` honored, unsupported schemas accepted).
- (Codex) Plugin disable-by-name rules matched bare instead of
  `<plugin>:<name>` names.
- (Codex) A global visited-folder set suppressed a second layout over the same
  folder.
- (Claude) Branch conflicted with main in `registry.main.ts`; merged and
  resolved.
- (Claude) Worktree canonical-root resolution skipped Claude's validation,
  letting a forged `commondir` add another repository's commands.
- (Claude) Codex root order labelled `~/.agents/skills` as Project for a
  home-level agent.
- (Claude) No test covered registry-based managed attribution.
- (Claude nits) Codex manifest `./` and `..` paths, symlinked legacy manifests,
  hidden children for Codex agent plugins, System-scope folder symlinks, and
  `skills.config` selector rules.

## Review round 3 (Claude CLEAN; Codex CHANGES REQUIRED)

Both reviewers confirmed every round-2 fix. The user directed that the round-3
findings be fixed and the PR merged without a fourth review round. Fixed, each
with a regression test:

- (Codex) Agent Plugin skills whose real path resolves outside the plugin were
  listed as the plugin's own; they are now rejected with a capped notice
  (`loader/host.rs`).
- (Codex) Host-root skills never received Codex's discovered namespace, so a
  personal link into an installed plugin listed as `review` instead of
  `sample:review`, and name rules plus the Disabled chip missed it. The
  collector now mirrors `SkillNamespaceResolver` (link targets, plugin-shaped
  folders inside the root, the manifest inherited from above the root).
- (Claude, minor) Plugin-shaped folders inside host roots stayed unqualified;
  covered by the same resolver.
- (Claude nit) A blank legacy manifest name now falls back to the plugin root's
  folder name (the version folder for installed plugins), and real names are
  kept untrimmed (`manifest.rs` resolve_raw_plugin_manifest).

## Not adopted, with reasons

- No main-process guard against overlapping scans: the renderer discards stale
  responses and each scan is bounded by the shared budget.
- OpenCode `skills.paths`/`skills.urls`, Codex remote-catalog plugins, and
  project-config plugin settings are not reproduced. Doing so needs each
  provider's full layered config loader or a network pull, which would be a
  second, drifting implementation; the panel discloses them instead.
- One shared budget across roots instead of Codex's per-root limits: exhaustion
  is reported in the panel, and per-root budgets would multiply worst-case
  main-process work by the number of roots.

## Verification after round-3 fixes

- The branch includes current `main` (merge `78ee198f`); both TypeScript projects
  (`tsconfig.control-sdk.json` and `tsc -b`) exit 0 on the merged tree.
- Focused system suites pass (inventory, provider discovery, and the
  managed-skill services under `src/main/agentCodeConventions/`): 82 tests in 8
  files. Agent Status renderer tests pass: 6.
- After the round-2 fixes, a read-only scan of real provider folders on a
  development machine completed without errors or scan-limit hits for Claude,
  Codex, and OpenCode. It was not re-run after the round-3 fixes (the ad-hoc
  script no longer resolved path aliases under `tsx`); the regression tests
  above cover the changed behavior.
