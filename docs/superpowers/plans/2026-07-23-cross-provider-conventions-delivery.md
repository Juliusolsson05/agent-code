# Cross-Provider Conventions Delivery Implementation Plan

> **Plan-only starting point:** This is the first file on the long-lived feature
> branch. The same branch, worktree, and pull request are intended to carry the
> complete implementation after this plan is approved. Do not create a second
> `plan/*` branch or a replacement PR when implementation begins.

**Goal:** Add an off-by-default **Agent Code Conventions** setting that lets a
user save personal development rules as Markdown and materializes those rules
as one portable Agent Skill for every agent provider supported by Agent Code.

**Architecture:** A main-process `AgentCodeConventionsService` owns the canonical
document, desired enabled state, revision, and hashes of every file Agent Code
materialized. Provider-specific personal skill locations are capabilities of the
exhaustive main provider registry, not branches inside the service. The renderer
uses a self-fetching Settings row over typed IPC, because a renderer
`localStorage` boolean cannot truthfully represent whether writes to external
user directories succeeded. One deterministic `SKILL.md` is installed into the
deduplicated provider targets. Agent Code reconciles before it launches a new
provider session; CLIs launched elsewhere observe the last successful
materialization because their lifecycle is outside Agent Code's control.

**Tech stack:** TypeScript, Electron main/preload/renderer boundaries, React 19,
the existing Settings registry and dialog primitives, Node `fs/promises`, the
native Claude Code/Codex/OpenCode Agent Skills discovery mechanisms, Vitest.

**Branch:** `feat/agent-code-conventions`

**Worktree:** `.worktrees/agent-code-conventions`

**Pull request intent:** Feature-scoped and initially opened as a draft with this
plan only. It becomes ready for review only after the implementation and all
verification in this document land on the same branch.

## Implementation Status — 2026-07-23

The production implementation now lives on this feature branch and follows the
architecture below:

- [x] exhaustive provider discovery capabilities for Claude Code, Codex, and
  OpenCode, including `CLAUDE_CONFIG_DIR` and physical-path deduplication;
- [x] deterministic portable skill rendering, main-owned revisioned state,
  write-ahead ownership, bounded reads, atomic writes, collision fingerprints,
  symlink/non-regular rejection, reconciliation, safe disable, two-phase clear,
  and explicit recovery;
- [x] typed main/preload/renderer IPC, pre-session reconciliation, the Agents
  Settings category, health-aware row, explicit-save editor, preview, warnings,
  conflict replacement, abandonment, and stale-draft recovery;
- [x] durable design documentation plus focused core/system/renderer regression
  coverage;
- [x] four-agent Claude/Codex review hardening: isolated filesystem safety,
  create-only publication, journal-only cleanup, operation-bound crash temps,
  external-root migration, private state permissions, and serialized snapshots;
- [x] `npm run check` (contract, composite typecheck, 222 test files / 1,253
  tests, production build, and packaged-entry verification).

The live-provider acceptance matrix and Settings screenshots remain deliberately
human-run. They are not implementation gaps, and no GUI or running Agent Code
instance is automated as part of this branch verification.

## Product Contract

The following behavior is part of the feature, not an implementation detail:

1. **Off means zero provider-directory side effects.** A fresh Agent Code install
   does not create `.agents`, `.claude`, or skill folders.
2. **The document survives disable.** Disabling uninstalls managed copies but
   retains the user's Markdown for later re-enable.
3. **The setting is machine-wide.** The providers' personal skill directories
   are global, so a convention enabled in Agent Code is also discoverable when
   the same CLI is launched outside Agent Code. The UI says this before enable.
4. **Skill semantics are honest.** Agent Skills expose metadata at startup and
   load their bodies when relevant. Agent Code does not claim the full body is
   present in every model turn. The generated description is deliberately broad
   enough to trigger for normal software-development work.
5. **New sessions are the compatibility boundary.** Agent Code reconciles the
   materialization before it launches a new provider session. Existing sessions
   may observe a live skill update, but Agent Code does not promise that across
   providers and does not auto-reload active agents after a save. Sessions
   launched outside Agent Code see the last successful materialization and
   cannot be gated against later external edits.
6. **Local instructions remain more specific.** Explicit conversation
   instructions and repository-local instructions normally win when they
   conflict with these personal defaults.
7. **No secrets.** Content is plaintext on disk and can be sent to model
   providers when the skill activates. The editor warns against credentials,
   API keys, customer data, and other secrets.
8. **No silent destruction.** Agent Code never overwrites an unmanaged collision
   and never removes a file that differs from the exact hash it last wrote.
   Ownership adoption requires a matching persisted pending operation; public
   marker text or matching generated bytes alone are not ownership proof.
9. **All registered agent providers must decide.** Adding an
   `AgentProviderKind` requires its main registry entry to declare supported
   personal skill locations or explicitly declare that personal Agent Skills
   are unsupported. A new enable is blocked while any registered provider is
   unsupported so the UI never calls a partial installation “all agents.”
10. **The canonical document is singular.** Provider copies are generated
    artifacts, never independent sources of truth.

## Research Basis and Provider Targets

The portable file format follows the [Agent Skills specification](https://agentskills.io/specification):
a directory containing a `SKILL.md` with required `name` and `description`
frontmatter. No provider-specific frontmatter belongs in the shared artifact.

Current provider discovery paths are based on the official documentation:

| Provider | Personal discovery root | Agent Code target |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/skills) | `$CLAUDE_CONFIG_DIR/skills`, falling back to `~/.claude/skills` | `<resolved Claude config>/skills/agent-code-conventions/SKILL.md` |
| [Codex](https://developers.openai.com/codex/skills/) | `~/.agents/skills` | `~/.agents/skills/agent-code-conventions/SKILL.md` |
| [OpenCode](https://opencode.ai/docs/skills/) | `~/.agents/skills` | `~/.agents/skills/agent-code-conventions/SKILL.md` |

Codex and OpenCode deliberately share one physical `.agents` materialization.
OpenCode also scans Claude's personal skill root, so it can discover the same
name from both physical copies when Claude is installed. The bytes are
deliberately identical, the UI attributes OpenCode to both discovered targets,
and manual acceptance must verify the pinned OpenCode version deduplicates this
without a warning or ambiguous selection. Do not add `~/.codex/skills` or
`~/.config/opencode/skills`: those would add copies without removing the
unavoidable overlap created by supporting Claude and Codex together.

Libraries or future providers that require programmatic skill sources rather
than personal filesystem discovery can add a different delivery capability in a
later extension. This PR's contract is the native provider runtimes currently
registered in Agent Code.

## Generated Skill Contract

The skill name and discovery description are product-owned constants. Only the
Markdown below `## User-authored conventions` is user-authored. Keeping user
input out of YAML eliminates quoting/frontmatter injection problems and prevents
a user from accidentally making their own skill undiscoverable.

The deterministic renderer produces exactly this shape, with LF line endings
and one trailing newline:

```markdown
---
name: agent-code-conventions
description: Personal development conventions configured in Agent Code. Use at the beginning of every task in a software project, including planning, coding, refactoring, testing, reviewing, documentation, terminal work, Git operations, and commit creation.
---

<!-- agent-code-managed:v1 -->

# Agent Code conventions

Apply the user-authored conventions below throughout the task.

Treat these as personal defaults. Explicit instructions in the current
conversation and more-specific repository-local instructions take precedence
when they conflict.

When delegating development work, carry these conventions into the delegated
task and review the result against them.

## User-authored conventions

<the normalized user Markdown>
```

Do not generate `scripts/`, `references/`, `assets/`, `agents/openai.yaml`, a
README, or provider variants. This feature is a rules document, and a single
portable `SKILL.md` is the smallest correct artifact.

## UI Contract

Add an `Agents` category between Workspace and Commands:

```text
┌────────────────────────────── Settings ──────────────────────────────────┐
│ Search settings                                                         │
├───────────────────┬──────────────────────────────────────────────────────┤
│ All Settings      │ Agents                                               │
│ Appearance        │ Shared behavior and instructions for agent runtimes. │
│ Workspace         │                                                      │
│ Agents          1 │ ┌─ Agent Code Conventions ─────────────────────────┐ │
│ Commands          │ │ Apply personal development rules to every       │ │
│ Dictation         │ │ supported agent provider.                       │ │
│ Experimental      │ │                                                  │ │
│ Safety            │ │ Status      Disabled                    [ ○ Off ] │ │
│                   │ │ Rules       14 lines saved                        │ │
│                   │ │                                                  │ │
│                   │ │ [ Edit conventions… ]   [ View install paths ]   │ │
│                   │ └──────────────────────────────────────────────────┘ │
└───────────────────┴──────────────────────────────────────────────────────┘
```

The row renders deployment health, not only desired enabled state:

- **Disabled** — no managed copy should exist; saved content may still exist.
- **Active** — every deduplicated supported target matches the expected hash.
- **Degraded** — desired state is enabled but at least one target is missing or
  could not be read/written.
- **Conflict** — a target is unmanaged or has changed since Agent Code wrote it.
- **Unsupported** — reserved for a future registered agent provider that cannot
  consume personal skills; do not silently call the feature “all agents” in
  that state.
- **Recovery required** — canonical state is malformed, newer than this app, or
  contains unsafe persisted paths. Preserve it and block writes until the user
  reveals/exports it or explicitly resets it.

Health precedence is `recovery-required`, `unsupported`, `conflict`,
`degraded`, `active`, then `disabled`; the highest-risk state must not be hidden
by a true desired-state boolean.

The editor is an explicit-save modal; typing never writes provider files:

```text
┌──────────────────── Agent Code Conventions ─────────────────────────────┐
│                                                                         │
│ Give supported agents the same personal development defaults.           │
│ These are global CLI skills and may also apply outside Agent Code.       │
│ Do not include passwords, API keys, or other secrets.                    │
│                                                                         │
│ Enable conventions                                      [ ● On ]         │
│                                                                         │
│ Rules — Markdown                                                        │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ # Development practices                                             │ │
│ │                                                                     │ │
│ │ - Read repository instructions before changing files.              │ │
│ │ - Keep changes scoped to the request.                               │ │
│ │ - Run relevant checks before reporting completion.                 │ │
│ │                                                                     │ │
│ │ # Git                                                               │ │
│ │                                                                     │ │
│ │ - Do not create commits unless explicitly asked.                   │ │
│ │ - Use `type(scope): imperative summary` for commit messages.        │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│ 11 lines · 379 characters · 379 bytes                                   │
│ Keep this concise: it enters model context when the skill is activated. │
│                                                                         │
│ Installations                                                           │
│ ✓ Claude, OpenCode  <Claude config>/skills/agent-code-conventions       │
│ ✓ Codex, OpenCode   ~/.agents/skills/agent-code-conventions             │
│                                                                         │
│ [Insert starter] [Preview generated skill]       [Cancel] [Save changes]│
└─────────────────────────────────────────────────────────────────────────┘
```

Interaction details:

- Enabling with no saved body opens the editor; it never installs an empty
  skill.
- Enabling with a previously saved valid body can install immediately.
- The first successful save while disabled says **Save & Enable** if the modal
  toggle is on; subsequent saves say **Save changes**.
- Closing a dirty editor asks before discarding.
- **Insert starter** fills only an empty editor. If content exists, require a
  replacement confirmation.
- **Preview generated skill** shows the exact generated plaintext, including
  product-owned wrapper and frontmatter. It is a preview, not a second editor.
- Disable asks for confirmation, removes managed copies, and retains Markdown.
- **Clear saved rules** is a separate destructive action. If enabled, it is
  presented as **Disable and clear**. The canonical body is erased only after
  every owned copy was safely removed. If a modified copy remains, the first
  action disables but retains the body and offers **Reveal**, **Retry**, or the
  separately confirmed **Leave external file and clear** action. That last
  action forgets ownership without deleting external bytes.
- The existing generic Reset Settings action does not clear this main-owned
  personal document, matching other main-owned Settings rows such as the stored
  dictation credential. Disable/clear live in this row where their effects are
  explicit.
- After an enabled save, show: “Conventions saved. Agent Code will reconcile
  before starting new agents. Existing agents may need to be restarted.” Do not
  add an automatic or implicit reload.

## Persistence Model

Add `AGENT_CODE_CONVENTIONS_STATE_FILE` under `STATE_DIR`, for example
`~/.config/agent-code/conventions.json`. The exact path is app-owned state;
provider copies are user-owned integration surfaces.

```ts
export type AgentCodeConventionsDocument = {
  schemaVersion: 1
  revision: number
  enabled: boolean
  markdown: string
  updatedAt: string | null
  materializations: Record<
    string,
    {
      path: string
      sha256: string
    }
  >
  pendingOperations: Record<
    string,
    {
      operationId: string
      targetId: string
      path: string
      kind: 'write' | 'delete'
      previousSha256: string | null
      desiredSha256: string | null
      expectedConflictFingerprint?: string
    }
  >
}
```

Rules:

- `revision` starts at zero and increments only after a successful desired-state
  mutation. IPC mutations include `expectedRevision`; stale saves return a typed
  revision conflict rather than replacing newer text.
- `materializations` records only successful Agent Code writes. It is ownership
  evidence for the exact generated file, not a target catalog; targets come
  from the provider registry. Agent Code never claims or removes the leaf skill
  directory. Fixed-name directory creation and durable ownership recording are
  not one portable atomic filesystem operation, so retaining an empty leaf is
  the only policy that cannot transfer deletion authority across a crash or
  concurrent user mkdir.
- `pendingOperations` is a write-ahead ownership journal. Persist an operation
  before touching a provider file, retain the previous materialization until
  publication succeeds, and remove the pending record only after the resulting
  ownership state is durable. A generated file may be adopted after a crash
  only when its path/hash match a pending write. A missing file may finish a
  pending delete. Matching marker/content without that journal remains
  unmanaged.
- A missing state file yields the disabled empty default. Malformed JSON,
  unsupported schemas, and invalid persisted paths enter a typed **Recovery
  required** state: preserve or safely quarantine the original file, retain any
  readable user-authored body and ownership evidence, block mutations that
  could overwrite it, and never crash app startup. Recovery offers explicit
  export/reveal and reset; it never silently converts unknown state to empty.
- Store no provider names in the canonical document. Status derives the current
  provider set so adding a provider does not require a state migration.
- Use UTF-8 and mode `0o600` for the state file where the platform honors Unix
  modes. `STATE_DIR` is shared and may already exist with a process-lock-created
  mode, so this feature does not promise to chmod it or claim a `0o700`
  directory it does not own.
- Never log `markdown`, rendered skill contents, previews, or text fragments.
  Diagnostics may contain revision, byte count, target id, path, duration, and
  error code. Do not intentionally serialize text or content-derived hashes;
  local crash/heap dumps can still contain ordinary process memory.

## Validation and Normalization

Pure validation runs before a desired-state write:

- Accept empty Markdown while disabled.
- Require non-whitespace content while enabled.
- Reject NUL characters.
- Normalize CRLF/CR to LF.
- Trim only outer blank lines; preserve all internal Markdown bytes.
- Hard cap UTF-8 content at 32 KiB.
- Return non-blocking warnings above 500 lines, 8,000 characters, or 8,000 UTF-8
  bytes. The UI displays both character and byte counts because multibyte input
  reaches the hard byte cap earlier.
- Render with exactly one final newline.
- Never interpolate user content into YAML or the management marker.

The starter is an explicit UI action, not persisted default content:

```markdown
# Development workflow

- Read repository-local instructions before changing files.
- Keep changes scoped to the request.
- Run relevant checks before reporting completion.
- Explain non-obvious decisions and constraints.

# Git

- Do not create commits unless explicitly asked.
- Use Conventional Commits: `type(scope): imperative summary`.
- Keep commit subjects concise and explain rationale in the body when needed.
```

## Filesystem Ownership and Transaction Rules

### Target preflight

For each deduplicated target:

1. Resolve the provider root, canonicalize it for physical-path deduplication,
   and validate the persisted/current path relation. Reject symlinked roots,
   symlinked leaf directories, symlinked `SKILL.md` files, non-directories,
   FIFOs, sockets, devices, and any path escape as a conflict in v1.
2. Read state and collision files through bounded regular-file handles using
   `O_NOFOLLOW` where available. Capture an opaque conflict fingerprint/version
   for every unmanaged file and revalidate it under the mutation lock directly
   before an authorized replacement.
3. If neither the skill directory nor `SKILL.md` exists, it is writable. The
   service may create the leaf directory but never treats that fact as removal
   authority.
4. If the directory exists and is empty, it is writable and is likewise never
   removed by Agent Code.
5. If `SKILL.md` matches the exact hash in the current materialization record,
   it is Agent Code-owned and writable/removable.
6. If `SKILL.md` equals the desired bytes and matches a persisted pending write
   for this exact target/path/hash, finish that interrupted operation and adopt
   it. Matching bytes or the public management marker alone never prove
   ownership.
7. Any other existing `SKILL.md` is a conflict.
8. A non-empty skill directory without an owned `SKILL.md` is also a conflict;
   unknown scripts/assets must not be adopted accidentally.

Run collision preflight for all targets before writing the first provider copy.
This avoids a known unmanaged collision producing an avoidable partial install.
I/O can still fail after preflight; partial runtime failures become **Degraded**
and are repaired by retry/reconciliation rather than a fragile rollback.

### Atomic writes

- Reuse the repository's hardened bounded-read and atomic-text-write primitives
  from `src/main/editorFileIO.ts`; do not create a third rename implementation.
  They provide `O_NOFOLLOW`, `O_EXCL` temporary siblings, file `fsync`, parent
  directory sync, version rechecks, no-clobber creation, Windows-aware
  replacement, and exact-temp cleanup.
- Give conventions operations identifiable operation-bound temp names if the
  shared helper needs a small extension, and clean only those exact stale temps
  during pending-operation recovery.
- Serialize service mutations through one in-process queue/mutex. Two renderer
  invokes must not interleave preflight/state/materialization phases.
- Preserve original errors in the typed result but return safe user-facing
  messages to the renderer.
- Revalidate collision fingerprints immediately before publication. The final
  publish still cannot be a portable cross-process compare-and-swap, so the
  implementation must use the shared no-clobber/version protections and never
  imply a stronger guarantee in comments.

### Enable/save ordering

1. Validate and normalize.
2. Enter mutation lock and check `expectedRevision`.
3. Resolve/deduplicate current provider targets.
4. If any registered provider is unsupported, return `unsupported` without a
   desired-state mutation. Preflight every supported target, including
   fingerprint-bound explicit conflict resolutions. An unresolved collision
   returns `target-conflict` before changing desired state or any target.
5. Persist canonical desired state with incremented revision, `enabled: true`,
   the previous ownership records intact, and pending writes for every target.
6. Materialize targets independently, revalidating fingerprints, and collect
   results.
7. Persist successful materialization hashes and clear completed pending writes
   without incrementing the user revision again.
8. Return `active`, `degraded`, or `conflict` with per-target status.

Persisting desired state before provider copies makes recovery deterministic:
after a crash, boot reconciliation knows the intended state and can finish it.

### Disable ordering

1. Enter mutation lock and check revision.
2. Persist `enabled: false` and increment revision.
3. Persist pending deletes while retaining the materialization records.
4. For each materialization, atomically capture the target into an
   operation-derived quarantine and unlink the capture only if its regular-file
   hash still matches the record. Restore an unverified replacement without
   clobbering. A missing file finishes a journaled delete.
5. Retain the leaf skill directory even when it is empty; only the generated
   `SKILL.md` has durable ownership proof.
6. Persist completed removals; preserve externally modified or unknown files
   and their ownership tombstones and return conflict status.
7. Retain the Markdown.

### Clear ordering

1. Clear invokes the disable transition first.
2. If any modified materialization remains, return `clear-blocked` with the body
   retained and fingerprinted targets for Reveal/Retry. This durable disable is
   the one revision increment for the blocked request.
3. A separately confirmed **Leave external file and clear** request includes
   target id plus expected conflict fingerprint. Revalidate every fingerprint,
   forget only those ownership records without deleting their bytes, then erase
   the canonical body and increment revision. When no conflict exists, the
   disable/removal/body-clear operation is one user revision even though its
   crash-safe state writes happen in phases.
4. Never erase the body before the durable state can still explain every file
   Agent Code owns or explicitly abandoned.

### Boot reconciliation

Reconcile before the renderer window can restore agent sessions, but contain
every error so conventions can never prevent Agent Code from opening:

- Enabled + missing target: recreate.
- Enabled + matching owned target: leave unchanged.
- Enabled + newly registered provider target: install.
- Persisted + retired/moved provider target: install the new current target but
  preserve the historical copy as a visible tombstone for manual cleanup or
  explicit abandonment. Persisted history alone never authorizes mutation
  outside a current provider root.
- Enabled + modified/unmanaged target: preserve and report conflict.
- Disabled + unchanged recorded materialization: remove.
- Disabled + modified recorded materialization: preserve and report conflict.
- Any permission/read/write failure: preserve desired state and report degraded.

Do not add a filesystem watcher in v1. Audit on boot, Settings-row mount/refresh,
before Agent Code starts a provider session, and every mutation. A watcher adds
cross-platform churn and a second mutation source. External CLI launches remain
outside Agent Code's reconciliation boundary.

## Shared IPC Contract

Create the contract in `src/shared/types/agentCodeConventions.ts` so main,
preload, renderer, tests, and any future remote exposure consume one shape.

Minimum public types:

```ts
export type AgentCodeConventionsHealth =
  | 'disabled'
  | 'active'
  | 'degraded'
  | 'conflict'
  | 'unsupported'
  | 'recovery-required'

export type AgentCodeConventionsTargetState =
  | 'installed'
  | 'missing'
  | 'conflict'
  | 'error'
  | 'not-installed'
  | 'unsupported'
  | 'retired'

export type AgentCodeConventionsTargetStatus = {
  id: string
  providers: AgentProviderKind[]
  displayPath: string
  state: AgentCodeConventionsTargetState
  message?: string
  canOverwrite?: boolean
  conflictFingerprint?: string
}

export type AgentCodeConventionsSnapshot = {
  revision: number
  enabled: boolean
  markdown: string
  updatedAt: string | null
  health: AgentCodeConventionsHealth
  warnings: string[]
  unsupportedProviders: AgentProviderKind[]
  recovery?: { message: string; stateFilePath: string }
  targets: AgentCodeConventionsTargetStatus[]
}

export type AgentCodeConventionsConflictResolution = {
  targetId: string
  expectedConflictFingerprint: string
}

export type SaveAgentCodeConventionsRequest = {
  expectedRevision: number
  enabled: boolean
  markdown: string
  overwriteTargets?: AgentCodeConventionsConflictResolution[]
}

export type ClearAgentCodeConventionsRequest = {
  expectedRevision: number
  abandonTargets?: AgentCodeConventionsConflictResolution[]
}

export type AgentCodeConventionsMutationResult =
  | { ok: true; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'validation'; message: string; warnings?: string[] }
  | { ok: false; code: 'revision-conflict'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'target-conflict'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'clear-blocked'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'unsupported'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'recovery-required'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'io-error'; message: string; snapshot: AgentCodeConventionsSnapshot }
```

`displayPath` may use `~` for readability, but IPC mutation inputs never accept
arbitrary paths. Reveal handlers accept only a target id and resolve that id
again in main. This avoids turning a Settings affordance into a generic
filesystem-reveal primitive.

Preload methods:

```ts
getAgentCodeConventions(): Promise<AgentCodeConventionsSnapshot>
saveAgentCodeConventions(
  request: SaveAgentCodeConventionsRequest,
): Promise<AgentCodeConventionsMutationResult>
disableAgentCodeConventions(
  expectedRevision: number,
): Promise<AgentCodeConventionsMutationResult>
clearAgentCodeConventions(
  request: ClearAgentCodeConventionsRequest,
): Promise<AgentCodeConventionsMutationResult>
previewAgentCodeConventions(markdown: string): Promise<
  | { ok: true; renderedSkill: string; warnings: string[] }
  | { ok: false; code: 'validation'; message: string; warnings?: string[] }
>
auditAgentCodeConventions(): Promise<AgentCodeConventionsSnapshot>
revealAgentCodeConventionsTarget(targetId: string): Promise<{ ok: boolean; message?: string }>
revealAgentCodeConventionsRecoveryFile(): Promise<{ ok: boolean; message?: string }>
resetAgentCodeConventionsRecovery(): Promise<AgentCodeConventionsMutationResult>
```

## Provider Capability Contract

Extend `MainProviderConfig` with an explicit Agent Skills capability rather than
teaching the conventions service provider names:

```ts
export type PersonalAgentSkillLocation = {
  id: string
  resolveDirectory: (context: {
    homeDirectory: string
    environment: Readonly<Record<string, string | undefined>>
  }) => string
}

export type MainProviderConfig = {
  // existing fields...
  personalAgentSkills:
    | { supported: true; locations: readonly PersonalAgentSkillLocation[] }
    | { supported: false; reason: string }
}
```

Registry declarations:

```ts
claude.personalAgentSkills.locations = [
  {
    id: 'claude-personal-skills',
    resolveDirectory: ({ homeDirectory, environment }) =>
      join(environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'skills'),
  },
]

codex.personalAgentSkills.locations = [
  {
    id: 'agents-standard-personal-skills',
    resolveDirectory: ({ homeDirectory }) => join(homeDirectory, '.agents', 'skills'),
  },
]

opencode.personalAgentSkills.locations = [
  {
    id: 'agents-standard-personal-skills',
    resolveDirectory: ({ homeDirectory }) => join(homeDirectory, '.agents', 'skills'),
  },
  {
    id: 'claude-personal-skills',
    resolveDirectory: ({ homeDirectory, environment }) =>
      join(environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory, '.claude'), 'skills'),
  },
]
```

Add a typed `listMainProviders()` accessor that iterates
`AGENT_PROVIDER_KINDS` through the exhaustive record. The service groups
locations first by stable id and then by canonical physical directory, asserts
stable ids cannot silently move to an unrelated path, and aggregates provider
display names for the UI. This makes OpenCode's documented overlap visible on
both targets without producing a third write.

The production service receives the same effective user home and environment
inherited by provider processes. Tests inject an isolated temporary home and
environment. Honor `CLAUDE_CONFIG_DIR`; never rewrite `HOME`, `CODEX_HOME`,
Claude configuration roots, or provider authentication locations to scope this
feature to Agent Code, because doing so would fork credentials, transcripts,
settings, and caches.

## Global Constraints During Implementation

- Follow root `AGENTS.md`: thick WHY comments explain ownership, recovery,
  provider boundaries, conflict policy, and invariants. Do not narrate obvious
  control flow.
- This is app code, not a runtime artifact. Nothing belongs in `vendor/` or
  `third_party/`.
- Do not modify project `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, or
  `.claude/skills` in any opened repository.
- Do not append hidden text to user prompts or transcripts.
- Do not override Codex `developer_instructions` or Claude system prompts.
- Do not modify provider user configuration files.
- Do not change the headless package submodules; native CLIs already discover
  these personal locations.
- Do not add provider-name conditionals outside provider registry declarations.
- Do not log conventions content at any level.
- Do not auto-reload running sessions.
- Never use recursive deletion for a personal skill target.
- Keep UI square-cornered and monospace, matching existing Settings surfaces.
- Use `apply_patch` for implementation edits and preserve unrelated worktree
  changes.
- Commit coherent tasks separately on the existing feature branch. Do not open
  another PR for implementation.

## Worktree Bootstrap for Implementation

The plan-only commit does not need a built dependency tree. Before implementation
or typechecking in this worktree:

```bash
git submodule update --init --recursive
ln -sfn ../../node_modules node_modules
```

Confirm `node_modules` resolves to the root checkout's installation and do not
commit the symlink if it is ignored as expected.

---

## Task 1: Shared constants, contracts, validation, and deterministic renderer

**Files:**

- Create: `src/shared/types/agentCodeConventions.ts`
- Create: `src/main/agentCodeConventions/renderSkill.ts`
- Create: `src/main/agentCodeConventions/renderSkill.test.ts`

- [ ] Define the stable skill name, management marker, schema version, byte
  limit, warning thresholds, starter Markdown, IPC request/result types, target
  status types, and persisted document type.
- [ ] Implement `normalizeAgentCodeConventionsMarkdown(value)` as a pure
  validation function returning normalized Markdown, byte/line/character
  counts, warnings, or a typed validation error.
- [ ] Implement `renderAgentCodeConventionsSkill(markdown)` as a deterministic
  pure function. Keep the YAML and wrapper product-owned and append exactly one
  final LF.
- [ ] Implement `sha256Text(text)` next to the main renderer or in an existing
  shared Node-only hash helper if one already fits. Do not introduce a browser
  crypto dependency into shared types.
- [ ] Test empty-disabled validation, empty-enabled rejection, CRLF/CR
  normalization, outer whitespace, internal blank lines, Unicode byte limits,
  NUL rejection, code fences, user `---` lines, management-marker-like user
  text, warning thresholds, and byte-for-byte deterministic rendering.
- [ ] Add a fixture assertion for the complete expected `SKILL.md`, so a future
  wrapper change is a deliberate contract review rather than invisible drift.

**Verification:**

```bash
npm run test:unit -- src/main/agentCodeConventions/renderSkill.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/shared/types/agentCodeConventions.ts src/main/agentCodeConventions
git commit -m "feat(conventions): define the portable conventions skill contract"
```

---

## Task 2: Provider-owned personal skill discovery capability

**Files:**

- Modify: `src/shared/types/providerConfig.ts`
- Modify: `src/providers/registry.main.ts`
- Modify: relevant registry/provider contract tests if present

- [ ] Add the supported/unsupported `personalAgentSkills` capability to
  `MainProviderConfig`.
- [ ] Declare Claude's environment-aware config root, the shared `.agents`
  root, and OpenCode's documented discovery of both physical targets.
- [ ] Add `listMainProviders()` without exposing the mutable backing record.
- [ ] Add a pure target resolver that groups stable ids and canonical physical
  paths, rejects inconsistent id/path aliases, sorts provider labels and
  targets deterministically, and produces no duplicate physical write.
- [ ] Test current registry coverage: Claude resolves its configured target,
  Codex resolves `.agents`, OpenCode is attributed to both, a custom
  `CLAUDE_CONFIG_DIR` moves the Claude target, and every `AGENT_PROVIDER_KIND`
  has an explicit capability decision.
- [ ] Add a thick WHY comment to the registry field explaining why discovery
  roots are provider capabilities while ownership/materialization remains a
  central app concern.

**Verification:**

```bash
npm run test:unit -- src/providers
npm run typecheck
```

**Commit:**

```bash
git add src/shared/types/providerConfig.ts src/providers/registry.main.ts src/providers
git commit -m "feat(conventions): declare provider skill discovery targets"
```

---

## Task 3: Main-owned persistence and atomic file primitives

**Files:**

- Modify: `src/main/storage/paths.ts`
- Create: `src/main/agentCodeConventions/persistence.ts`
- Create: `src/main/agentCodeConventions/persistence.system.test.ts`

- [ ] Add the canonical state-file constant beneath `STATE_DIR`.
- [ ] Implement defensive state parsing. Only a missing file becomes the empty
  disabled default. Malformed/newer/unsafe shapes preserve or quarantine the
  source and return typed recovery-required state without throwing into app
  composition.
- [ ] Reuse `readBoundedTextFile()` and `atomicWriteTextFile()` from
  `src/main/editorFileIO.ts`, extending the shared helper narrowly only if
  operation-bound temp recovery requires it.
- [ ] Implement `readFileHash` without reading arbitrary large files into
  diagnostics. The skill itself is capped, but an unmanaged collision could be
  huge; cap reads used for ownership inspection and return conflict/error rather
  than consuming unbounded memory.
- [ ] Keep filesystem dependencies injectable: state path, home directory,
  clock, UUID/temp suffix, and optionally I/O functions needed for deterministic
  failure tests.
- [ ] Test no-file default, round-trip, malformed/newer-state recovery,
  preservation of readable body/ownership evidence, atomic replacement, temp
  cleanup, permissions where supported, symlink/non-regular rejection,
  oversized collision handling, and simulated rename/write failures.

**Verification:**

```bash
npm run test:system -- src/main/agentCodeConventions/persistence.system.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/main/storage/paths.ts src/main/agentCodeConventions/persistence.ts src/main/agentCodeConventions/persistence.system.test.ts
git commit -m "feat(conventions): persist managed conventions state atomically"
```

---

## Task 4: `AgentCodeConventionsService` ownership state machine

**Files:**

- Create: `src/main/agentCodeConventions/AgentCodeConventionsService.ts`
- Create: `src/main/agentCodeConventions/AgentCodeConventionsService.system.test.ts`
- Create: `src/main/agentCodeConventions/index.ts` only if a narrow public barrel
  reduces composition imports; do not create a broad convenience barrel.

Public service surface:

```ts
class AgentCodeConventionsService {
  initialize(): Promise<void>
  getSnapshot(options?: { audit?: boolean }): Promise<AgentCodeConventionsSnapshot>
  save(request: SaveAgentCodeConventionsRequest): Promise<AgentCodeConventionsMutationResult>
  disable(expectedRevision: number): Promise<AgentCodeConventionsMutationResult>
  clear(request: ClearAgentCodeConventionsRequest): Promise<AgentCodeConventionsMutationResult>
  preview(markdown: string): AgentCodeConventionsPreviewResult
  audit(): Promise<AgentCodeConventionsSnapshot>
  resolveRevealTarget(targetId: string): Promise<string | null>
  resolveRecoveryFile(): Promise<string | null>
  resetRecovery(): Promise<AgentCodeConventionsMutationResult>
}
```

- [ ] Serialize all mutations and audited reads that can adopt/repair state.
- [ ] Implement regular-file/symlink-safe target preflight, managed hash
  comparison, pending-operation-only crash adoption, unmanaged-directory
  conflict detection, fingerprint-bound overwrite approval, and per-target
  status.
- [ ] Implement preflight-before-mutation collision blocking, desired-state plus
  pending-write persistence, successful-materialization hash persistence, and
  degraded post-preflight I/O failure.
- [ ] Implement safe disable using exact hash proof and `unlink`, while always
  retaining the leaf directory because its creation cannot be journaled
  atomically with portable filesystem APIs.
- [ ] Implement clear as a two-phase disable-first flow. Retain the body while a
  modified copy remains; clear only after safe removal or fingerprint-bound
  explicit abandonment that never deletes the external file.
- [ ] Implement boot reconciliation and keep initialization errors contained in
  the service snapshot.
- [ ] Ensure audit is observational except for journal-proven crash recovery
  and desired-state reconciliation. It must never adopt marker/content alone or
  overwrite a conflict just because Settings was opened.
- [ ] Test against a fresh `mkdtemp` home only. Include: off creates no provider
  dirs; enable writes two physical copies for three providers; bytes are
  identical; save update; disable retain body; clear; duplicate target
  deduplication; revision race; unmanaged collision; unknown sidecar file;
  external modification; fingerprint race; crash at every state/file boundary;
  missing target repair; pending delete recovery; permission failures;
  symlink/FIFO rejection; one-target partial failure; newly registered and
  retired/moved targets; recovery-required state; and concurrent serialization.
- [ ] Assert every delete in the implementation is an exact-file `unlink`. No
  test or production path may call `rmdir` or recursive removal on a provider
  target.

**Verification:**

```bash
npm run test:system -- src/main/agentCodeConventions/AgentCodeConventionsService.system.test.ts
npm run typecheck
```

**Commit:**

```bash
git add src/main/agentCodeConventions
git commit -m "feat(conventions): materialize and reconcile managed provider skills"
```

---

## Task 5: Typed IPC and preload bridge

**Files:**

- Create: `src/main/ipc/agentCodeConventions.ts`
- Modify: `src/main/ipc/index.ts`
- Create: `src/preload/api/agentCodeConventions.ts`
- Modify: `src/preload/api/index.ts`
- Modify: `src/preload/index.ts` only if shared type re-exports are needed
- Modify: `src/preload/index.d.ts` only if the composed API type does not already
  flow through automatically

- [ ] Register get/save/disable/clear/preview/audit/reveal/recovery handlers with
  the service passed explicitly through `IpcDeps`.
- [ ] Validate IPC payload primitives before calling the service. The renderer
  is trusted UI, but malformed DevTools or stale-version calls must fail closed.
- [ ] Reveal by target id only; resolve the current known path in main and call
  Electron `shell.showItemInFolder` for the concrete `SKILL.md` when present or
  `shell.openPath` on the known directory when appropriate.
- [ ] Compose the narrow preload methods into the existing flat `window.api`
  surface.
- [ ] Do not emit content-bearing events. A Settings row can refetch after its
  own mutation; an app-wide subscription is unnecessary in v1.
- [ ] Add focused IPC tests only if existing harnesses make them cheap; the IPC
  file must remain a thin adapter and all state-machine behavior stays covered
  at the service layer.

**Verification:**

```bash
npm run typecheck
```

**Commit:**

```bash
git add src/main/ipc src/preload/api src/preload/index.ts src/preload/index.d.ts
git commit -m "feat(conventions): expose managed conventions through typed IPC"
```

---

## Task 6: Main composition and startup reconciliation

**Files:**

- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/index.ts` if not completed with Task 5
- Modify: incident/journal typing only if a content-free diagnostic hook needs it

- [ ] Construct the service with production state path, effective user home,
  provider target resolver, and a content-free diagnostic sink.
- [ ] Await `initialize()` before `createMainWindow()` and therefore before
  renderer workspace restoration can spawn providers.
- [ ] Invoke a contained reconciliation immediately before every Agent
  Code-owned provider session spawn. Do not claim externally launched CLIs can
  be gated.
- [ ] Catch/contain initialization inside the service. Main composition should
  not require a surrounding fatal catch for a convenience feature.
- [ ] Pass the service explicitly into `registerAllIpc`.
- [ ] Record only health, target count, revision, duration, and error codes in
  startup diagnostics. Never text or content-derived hashes; those can become
  cross-log identifiers even when truncated.
- [ ] Verify an unwritable injected home produces a usable main window and a
  degraded Settings snapshot in a test or controlled manual run.

**Verification:**

```bash
npm run typecheck
```

**Commit:**

```bash
git add src/main/index.ts src/main/ipc/index.ts src/main/agentCodeConventions
git commit -m "feat(conventions): reconcile personal skills during app startup"
```

---

## Task 7: Settings category and self-fetching row

**Files:**

- Modify: `src/renderer/src/features/settings/lib/settingsCategories.ts`
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx`
- Create: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx`
- Create: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.renderer.test.tsx`
- Add/modify focused renderer tests as warranted by the existing renderer
  project conventions

- [ ] Add `agents` to `SettingCategoryId` and insert the category between
  Workspace and Commands with the copy from the UI contract.
- [ ] Add a marker control type `agent-code-conventions`, following the existing
  main-owned `cli-update-behavior` and `dictation-api-key` row pattern.
- [ ] Add a searchable registry definition with keywords including conventions,
  rules, instructions, agents, Claude, Codex, OpenCode, skills, commits, Git,
  testing, and development practices.
- [ ] Make the row fetch on mount and expose an explicit refresh affordance for
  degraded/conflict states.
- [ ] Render loading, disabled, active, degraded, conflict, unsupported, and
  recovery-required states without collapsing desired enabled state into health.
- [ ] Enabling with saved valid content calls IPC directly. Enabling without
  content opens the editor. Disabling always confirms.
- [ ] Render provider groups and friendly `~` paths from the main snapshot; do
  not reconstruct paths in the renderer. OpenCode appears on both discovered
  targets while only two physical files are written.
- [ ] Keep mutation errors inline. Never optimistically show Active before main
  returns the audited snapshot.
- [ ] The row owns modal state so `SettingsPage` does not accumulate another
  feature-specific editor target like the theme editor unless the existing
  dialog stacking/focus behavior proves that ownership wrong.

**Verification:**

```bash
npm run test:renderer -- AgentCodeConventionsRow
npm run typecheck
```

If no focused renderer test exists yet, add a small behavior test for state
labels and enable-with-empty opening the modal; do not snapshot Tailwind class
strings.

**Commit:**

```bash
git add src/renderer/src/features/settings
git commit -m "feat(conventions): add agent conventions settings controls"
```

---

## Task 8: Editor, preview, validation feedback, and conflict resolution

**Files:**

- Create: `src/renderer/src/features/settings/ui/AgentCodeConventionsEditorModal.tsx`
- Modify: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx`
- Create: `src/renderer/src/features/settings/ui/AgentCodeConventionsEditorModal.renderer.test.tsx`

- [ ] Implement the modal shown in the UI contract using existing `Dialog`,
  `Button`, and `Textarea` primitives.
- [ ] Keep `{revision, enabled, markdown}` as one modal draft. Save one atomic
  request with the current returned revision; refresh the captured revision
  after every successful mutation so a second save does not conflict with the
  modal's own first save.
- [ ] Display character, UTF-8 byte, and line counts live. Display server-returned warnings
  and validation errors; mirror simple counts in the renderer for immediacy but
  let main validation remain authoritative.
- [ ] Add explicit starter insertion, exact generated-skill preview, dirty-close
  confirmation, secret/context warning, and per-target install status. Preview
  calls main IPC so the product-owned renderer has one source of truth.
- [ ] On revision conflict, preserve the user's draft and offer **Reload latest**
  or **Copy draft**. Never silently replace either side.
- [ ] On unmanaged/modified target conflict, show target path and actions:
  **Reveal**, **Cancel**, and **Replace after confirmation**. The final action
  reissues the same draft/revision request with the confirmed target id and
  exact `expectedConflictFingerprint` returned for the reviewed file.
- [ ] Never offer bulk “overwrite every conflict” without showing each path.
- [ ] After a successful enabled save, render the new-session compatibility
  notice. Do not call `workspace.reloadAgentSessions`.
- [ ] Add disable and two-phase disable-and-clear confirmation copy exactly
  describing retained/deleted data. A blocked clear offers target-specific
  Reveal/Retry and separately confirms **Leave external file and clear** with
  the fingerprint returned for each remnant.
- [ ] Test stale revision, validation error, insert starter, preview switching,
  dirty cancel, target-specific overwrite confirmation, disable retention, and
  save success notice. Mock preload responses; filesystem behavior remains in
  main tests.

**Verification:**

```bash
npm run test:renderer -- AgentCodeConventions
npm run typecheck
```

**Commit:**

```bash
git add src/renderer/src/features/settings/ui/AgentCodeConventions*
git commit -m "feat(conventions): add the conventions editor and deployment status"
```

---

## Task 9: Evergreen design documentation and user-facing copy audit

**Files:**

- Create: `docs/design/agent-code-conventions.md`
- Modify: `docs/design/README.md`
- Add one-line design-doc references to the service, target resolver, shared
  contract, and Settings row where the subsystem invariant is otherwise easy to
  violate
- Modify: root `README.md` only if the finished feature belongs in the public
  capability list; do not advertise it while the PR is still plan-only

- [ ] Convert the implemented architecture—not this task checklist—into an
  evergreen design source of truth.
- [ ] Cover source of truth, provider capability ownership, desired state versus
  deployment health, generated artifact contract, collision policy, startup
  reconciliation, and the new-session boundary.
- [ ] End the design doc with `## Warning`, calling out the no-recursive-delete,
  no-unmanaged-overwrite, no-content-logging, and provider-registry invariants.
- [ ] Add it to `docs/design/README.md` only after implementation matches it.
- [ ] Audit every UI string for the two truths most likely to be lost: global
  CLI scope outside Agent Code and relevance-based skill activation.

**Verification:**

```bash
rg -n "Agent Code Conventions|agent-code-conventions|personalAgentSkills" src docs/design
```

**Commit:**

```bash
git add docs/design README.md src/main/agentCodeConventions src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx
git commit -m "docs(conventions): document managed cross-provider skill delivery"
```

---

## Task 10: Full automated verification

- [ ] Run focused Node service tests.
- [ ] Run focused renderer tests.
- [ ] Run the repository composite TypeScript build. Do not use project-local
  `--noEmit`: the web project consumes emitted node declarations and that raw
  command fails with TS6305 in a fresh tree.
- [ ] Run the full unit and renderer projects.
- [ ] Run the full repository check before marking the PR ready.
- [ ] If package verification requires fetched runtime artifacts unavailable in
  the development environment, record the exact skipped command and let CI run
  it; do not weaken scripts or checks to make the branch green locally.

Commands:

```bash
npm run test:unit -- src/main/agentCodeConventions
npm run test:system -- src/main/agentCodeConventions
npm run test:renderer -- AgentCodeConventions
npm run typecheck
npm run test:unit
npm run test:system
npm run test:renderer
npm run check
```

- [ ] Inspect `git diff origin/main...HEAD --check`.
- [ ] Inspect `git status --short` and ensure no generated skill, temporary
  home, `node_modules` link, test state, or real personal conventions file is
  staged.
- [ ] Search the diff for accidental content logging and dangerous filesystem
  operations:

```bash
git diff origin/main...HEAD | rg "console\.|logger|rm\(|recursive|markdown|SKILL.md"
```

Review every hit; this is an audit, not an assertion that all hits are wrong.

**Commit:** Only if verification uncovers fixes; use a scoped message describing
the real correction rather than `fix tests`.

---

## Task 11: Manual provider acceptance

Use deliberately harmless, distinctive content and remove it through the UI at
the end. Back up any existing colliding paths before starting; the feature
should block rather than touch them.

Test convention:

```markdown
# Acceptance marker

- When asked for the convention marker, answer `AC-CONVENTIONS-0723`.
- For commits, use `type(scope): imperative summary`.
```

- [ ] With feature disabled on a clean profile, verify neither target directory
  is created.
- [ ] Save content while disabled; verify app state exists but provider target
  directories still do not.
- [ ] Enable and verify exactly two physical `SKILL.md` copies exist and are
  byte-identical.
- [ ] Start new Claude Code, Codex, and OpenCode sessions from Agent Code and
  verify each can identify/apply `agent-code-conventions`.
- [ ] In OpenCode, verify the pinned version handles discovery of the same skill
  name from both `.agents` and Claude roots without a warning or ambiguous
  selection; record the observed precedence/deduplication behavior.
- [ ] Repeat Claude acceptance with a disposable `CLAUDE_CONFIG_DIR` and verify
  the target and UI path move with it.
- [ ] Verify an Agent Code-orchestrated child session also sees the global skill.
- [ ] Create a disposable repository-local instruction that conflicts with the
  commit example and verify the more-specific local instruction wins.
- [ ] Update the body, start new sessions, and verify the new marker.
- [ ] Keep one agent running across a save and confirm the UI makes no promise
  that this existing session refreshed.
- [ ] Modify one managed copy externally, audit, and verify conflict status with
  no overwrite. Change it again after opening confirmation and verify the stale
  fingerprint is rejected; then resolve only the newly reviewed target.
- [ ] Create an unmanaged collision on a clean target and verify enable is
  blocked before any other new target is written.
- [ ] Disable and verify unchanged managed `SKILL.md` copies are removed, empty
  leaf directories are retained, and the saved body remains visible.
- [ ] Clear with a modified remnant and verify the body is retained. Then verify
  both safe retry and separately confirmed **Leave external file and clear**;
  the latter must preserve external bytes while clearing canonical state.
- [ ] Exercise symlink/non-regular target rejection and malformed/newer state
  recovery in disposable homes; neither may block the app from opening.
- [ ] Confirm provider configuration, authentication, transcripts, project
  files, global `AGENTS.md`, and global `CLAUDE.md` were untouched.

Capture the provider versions used in the PR verification comment because skill
discovery behavior moves independently in each upstream CLI.

---

## Task 12: Final PR readiness and rollout

- [ ] Rebase or merge current `origin/main` according to the repository's normal
  PR policy; rerun affected verification after conflict resolution.
- [ ] Update the draft PR body from plan-only state to implemented summary,
  screenshots, test evidence, manual provider versions, known limits, and
  follow-ups.
- [ ] Include Settings screenshots for disabled, active/editor, and conflict
  states.
- [ ] Confirm the PR title remains feature-scoped and the branch/worktree remain
  the long-lived implementation locations. Do not rename them to the plan
  filename and do not open a replacement implementation PR.
- [ ] Mark ready only when all acceptance criteria below are satisfied.

## Acceptance Criteria

- [ ] `enabled` defaults false and a fresh user receives no provider filesystem
  writes.
- [ ] One canonical Markdown document materializes identical valid portable
  skills for every supported registered provider.
- [ ] Codex and OpenCode share one `.agents` copy; Claude receives one `.claude`
  copy, and OpenCode's discovery overlap is visible and acceptance-tested.
- [ ] The UI distinguishes desired enabled state from actual deployment health.
- [ ] Empty, oversized, NUL-containing, and stale-revision saves fail safely.
- [ ] No unmanaged or externally modified file is overwritten or deleted
  without target-specific explicit confirmation.
- [ ] Disable retains content and removes only hash-proven managed artifacts.
- [ ] Clear is explicit and does not leave the UI claiming all copies are gone
  when a conflict remains; external abandonment never deletes external bytes.
- [ ] Startup reconciliation repairs missing owned materializations and never
  prevents the app from opening.
- [ ] New/restarted Claude Code, Codex, and OpenCode sessions discover the skill.
- [ ] Existing sessions are not silently reloaded.
- [ ] Provider differences live in the provider registry capability.
- [ ] Renderer code never writes arbitrary filesystem paths.
- [ ] Conventions content is never intentionally serialized into diagnostics,
  logs, prompt wrappers, journals, or transcripts through Agent Code code;
  ordinary local process memory is not misrepresented as scrubbed.
- [ ] No repository file, provider config, authentication store, global
  `AGENTS.md`, or global `CLAUDE.md` is modified.
- [ ] Thick WHY comments make ownership and safety invariants transparent in the
  implementation diff.
- [ ] Focused core/system/renderer tests, composite typecheck, full test tiers, package checks,
  and manual provider acceptance are documented on the PR.

## Deliberate Follow-Ups, Not v1

- An **Always apply to every turn** mode. This requires provider-specific
  instruction delivery and must not be mislabeled as ordinary Agent Skills.
- App-only scope. Native personal skill roots are machine-wide; app-only delivery
  would require per-provider session injection or isolated runtime support.
- Live filesystem watchers and automatic external-edit import.
- Automatic running-agent reload.
- Multiple named convention profiles or per-provider bodies.
- Cloud synchronization or remote-mobile editing.
- Installation for tools that are not registered Agent Code providers.
- Skill scripts, references, assets, or tool permission declarations.

These are excluded to keep v1 centered on one trustworthy invariant: a user's
single saved conventions document is safely and transparently materialized as
the same portable skill for every agent runtime Agent Code currently owns.
