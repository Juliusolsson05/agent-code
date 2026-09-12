# Agent Status installed skills

Status: implemented; review round 1 findings fixed and re-review pending. Issue: #900. PR: #903.

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
   `recursive`, `commands`), derived from the vendored provider source rather
   than documentation. Each adapter also owns its project ancestry, because the
   three providers stop at different boundaries. Never infer enabled plugins
   from caches alone.
3. Reuse a public, metadata-only managed-skill service projection to attribute
   Agent Code deployments. Paths come from the resolved target registry and the
   canonical document, never from UI `displayPath` strings. Do not import
   persistence/ownership internals or introduce another writer. Skill bodies
   remain in main and do not enter diagnostics, IPC, or the status UI.
4. Bound all filesystem work with one budget (listings, entries, and metadata
   reads), deduplicate physical files, cap failure notices, and surface
   incomplete discovery. Opening the panel performs no installations,
   configuration mutations, native prompts, or provider process launches.
5. Add an Installed Skills section following existing dense semantic styling.
   Fetch on target/context changes, explicit refresh, and managed-skill updates;
   fence stale responses and show loading, empty, partial/error, and shell states.
   Provider-disabled skills stay listed and are marked Disabled.
6. Update command search metadata and feature reference to mention skills.

## Validation

- Deterministic filesystem tests use isolated temporary roots, covering managed
  attribution, per-provider layouts and boundaries, plugin resolution,
  duplicates, symlinks, malformed or oversized metadata, the shared budget, and
  source failures without executing skills.
- Renderer tests cover the displayed inventory, disabled marking,
  empty/error/terminal states, refreshing, and switching targets while
  discovery is pending.
- Run focused tests, both TypeScript projects, and CI `quality-gate`.
- Review with independent Claude and Codex agents; merge only when both are clean.

## Constraints

Provider discovery and activation differ. Report actual discovered files and
known exclusions; do not hard-code a supposedly complete list of bundled skills
or label a disk inventory as the running agent's loaded context. Inline WHY
comments explain each provider rule and asynchronous ownership boundary.

## Implemented scope

- Claude (`loadSkillsDir.ts`, `markdownConfigLoader.ts`, `pluginLoader.ts`):
  policy, user, and project `skills/` folders as direct children only; project
  ancestry from cwd up to the nearest `.git` (file or directory), never home.
  Legacy `commands/` Markdown is scanned recursively, with SKILL.md owning its
  folder, and a linked worktree without its own commands falls back to the main
  checkout's. Plugin enablement comes from user, launch-directory project/local,
  and policy settings; project installs must match the launch directory exactly.
  Manifest `skills`/`commands` paths replace the defaults and must stay inside
  the plugin. Command-only plugins are listed. Bundled skills compiled into the
  CLI are disclosed as unlisted.
- Codex (`host_roots.rs`, `loader/`, `core-plugins`): project roots from the
  `project_root_markers` root (default `.git`) to cwd — `.agents/skills`, plus
  `.codex/skills` where a project `.codex` exists. User roots are
  `$CODEX_HOME/skills` and `~/.agents/skills`; defaults are
  `$CODEX_HOME/skills/.system` unless `skills.bundled.enabled = false`; admin is
  `/etc/codex/skills`. All are recursive to six segments with hidden folders
  skipped. Plugins are enabled unless `enabled = false`, and the loaded version
  is `local` or the highest SemVer. Manifest lookup covers agent-plugin root
  `plugin.json` (direct children) and `.codex-plugin`/`.claude-plugin`/`.cursor-plugin`
  manifests (recursive plus migrated command skills). Explicit `./` paths
  replace `skills/`. `[[skills.config]]` rules and Agent Code's session-level
  disable of its external-operator skill mark skills Disabled. Remote-catalog
  plugins and project-config plugin/skill settings are disclosed.
- OpenCode (`skill/index.ts`, `config/paths.ts`): `.claude`/`.agents` `skills/**`
  (hidden included) at home and from cwd up to the worktree, and
  `{skill,skills}/**` in the XDG config dir, `~/.opencode`, project `.opencode`,
  and `OPENCODE_CONFIG_DIR`. Disable flags are parsed case-insensitively, as
  OpenCode does. `skills.paths`/`skills.urls` are disclosed as unlisted.

## Review round 1 (Claude + Codex orchestration agents, both CHANGES REQUIRED)

Confirmed against vendored provider source and fixed, each with a regression test:

- Claude project walk crossed the git root, and ancestor settings/installs
  controlled plugins. Both agents found this, and the vendored
  `getProjectDirsUpToHome` stop logic confirmed it.
- A single generic walk matched no provider: it fabricated Claude skills from a
  stray `skills/SKILL.md`, listed nested archives, and missed Codex nested skills.
  Fixed with per-root layouts.
- Metadata reads under skill-path roots bypassed the scan budget, causing
  unbounded parsing and notices in main. Now one budget plus capped notices.
- Plugin resolution: explicit manifest paths replace the default folder; Codex
  alternate manifests and agent-plugin format; Codex default-enabled plugins and
  highest-version selection; Claude command-only plugins; manifest paths escaping
  the plugin root.
- Missing roots: Codex project `.codex/skills`; OpenCode singular `skill/`,
  `~/.opencode`, Claude-compatibility disable flags, case-insensitive flags.
- Codex disabled skills, including Agent Code's own external-operator exclusion,
  were presented as usable.
- Managed attribution parsed the UI `displayPath` (breaks on `~\` paths).

Not adopted, with reason:

- No main-process guard against overlapping scans. The renderer already discards
  stale responses, and each scan is bounded by the shared budget; cancellation
  plumbing through IPC would add machinery without changing what is displayed.
- OpenCode `skills.paths`/`skills.urls`, Codex remote-catalog plugins, and
  project-config plugin settings are not reproduced. Doing so needs each
  provider's full layered config loader (or a network pull), which would be a
  second, drifting implementation; the panel discloses these instead.

Verification after fixes: both TypeScript projects type-check with no errors;
focused system tests (inventory, provider discovery, managed projection) and
renderer tests pass.
