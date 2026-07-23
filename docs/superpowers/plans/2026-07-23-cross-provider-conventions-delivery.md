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
uses a self-subscribing Settings row over typed IPC, because a renderer
`localStorage` boolean cannot truthfully represent whether writes to external
user directories succeeded. One deterministic `SKILL.md` is installed into the
deduplicated provider targets; new/restarted provider sessions discover it
natively.

**Tech stack:** TypeScript, Electron main/preload/renderer boundaries, React 19,
the existing Settings registry and dialog primitives, Node `fs/promises`, the
native Claude Code/Codex/OpenCode Agent Skills discovery mechanisms, Vitest.

**Branch:** `feat/agent-code-conventions`

**Worktree:** `.worktrees/agent-code-conventions`

**Pull request intent:** Feature-scoped and initially opened as a draft with this
plan only. It becomes ready for review only after the implementation and all
verification in this document land on the same branch.

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
5. **New sessions are the compatibility boundary.** New and restarted sessions
   reliably see the latest materialization. Existing sessions may observe a
   live skill update, but Agent Code does not promise that across providers and
   does not auto-reload active agents after a save.
6. **Local instructions remain more specific.** Explicit conversation
   instructions and repository-local instructions normally win when they
   conflict with these personal defaults.
7. **No secrets.** Content is plaintext on disk and can be sent to model
   providers when the skill activates. The editor warns against credentials,
   API keys, customer data, and other secrets.
8. **No silent destruction.** Agent Code never overwrites an unmanaged collision
   and never removes a file that differs from the exact hash it last wrote
   without a separate explicit conflict-resolution action.
9. **All registered agent providers must decide.** Adding an
   `AgentProviderKind` requires its main registry entry to declare supported
   personal skill locations or explicitly declare that personal Agent Skills
   are unsupported.
10. **The canonical document is singular.** Provider copies are generated
    artifacts, never independent sources of truth.

## Research Basis and Provider Targets

The portable file format follows the [Agent Skills specification](https://agentskills.io/specification):
a directory containing a `SKILL.md` with required `name` and `description`
frontmatter. No provider-specific frontmatter belongs in the shared artifact.

Current provider discovery paths are based on the official documentation:

| Provider | Personal discovery root | Agent Code target |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/skills) | `~/.claude/skills` | `~/.claude/skills/agent-code-conventions/SKILL.md` |
| [Codex](https://developers.openai.com/codex/codex-manual.md) | `~/.agents/skills` | `~/.agents/skills/agent-code-conventions/SKILL.md` |
| [OpenCode](https://opencode.ai/docs/skills/) | `~/.agents/skills` | `~/.agents/skills/agent-code-conventions/SKILL.md` |

Codex and OpenCode deliberately share one physical materialization. Do not also
write `~/.codex/skills` or `~/.config/opencode/skills`: the documented shared
`.agents` root already covers both providers and fewer copies mean fewer drift
and partial-failure states.

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
│ 11 lines · 379 characters                                               │
│ Keep this concise: it enters model context when the skill is activated. │
│                                                                         │
│ Installations                                                           │
│ ✓ Claude Code       ~/.claude/skills/agent-code-conventions             │
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
  presented as **Disable and clear** and must complete a safe uninstall before
  erasing the canonical body.
- The existing generic Reset Settings action does not clear this main-owned
  personal document, matching other main-owned Settings rows such as the stored
  dictation credential. Disable/clear live in this row where their effects are
  explicit.
- After an enabled save, show: “Conventions saved. New agents will use this
  version. Existing agents may need to be restarted.” Do not add an automatic
  or implicit reload.

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
}
```

Rules:

- `revision` starts at zero and increments only after a successful desired-state
  mutation. IPC mutations include `expectedRevision`; stale saves return a typed
  revision conflict rather than replacing newer text.
- `materializations` records only successful Agent Code writes. It is ownership
  evidence, not a target catalog; targets come from the provider registry.
- State coercion treats absent/corrupt/malformed data as disabled with empty
  content. Preserve a corrupt file for diagnostics by renaming it to a
  timestamped sibling only if that move can be done safely; otherwise report the
  read error and continue disabled. Never crash app startup.
- Store no provider names in the canonical document. Status derives the current
  provider set so adding a provider does not require a state migration.
- Use UTF-8, mode `0o600` for the state file, and `0o700` for newly created
  app-state directories where the platform honors Unix modes.
- Never log `markdown`, rendered skill contents, previews, or text fragments.
  Diagnostics may contain revision, byte count, hash prefix, target id, path,
  and error code.

## Validation and Normalization

Pure validation runs before a desired-state write:

- Accept empty Markdown while disabled.
- Require non-whitespace content while enabled.
- Reject NUL characters.
- Normalize CRLF/CR to LF.
- Trim only outer blank lines; preserve all internal Markdown bytes.
- Hard cap UTF-8 content at 32 KiB.
- Return non-blocking warnings above 500 lines or 8,000 characters.
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

1. If neither the skill directory nor `SKILL.md` exists, it is writable.
2. If the directory exists and is empty, it is writable.
3. If `SKILL.md` matches the exact hash in the current materialization record,
   it is Agent Code-owned and writable/removable.
4. If `SKILL.md` already equals the newly generated bytes, it can be adopted as
   the current materialization after verifying the management marker. This
   repairs a crash after file rename but before the state hash was persisted.
5. Any other existing `SKILL.md` is a conflict.
6. A non-empty skill directory without an owned `SKILL.md` is also a conflict;
   unknown scripts/assets must not be adopted accidentally.

Run collision preflight for all targets before writing the first provider copy.
This avoids a known unmanaged collision producing an avoidable partial install.
I/O can still fail after preflight; partial runtime failures become **Degraded**
and are repaired by retry/reconciliation rather than a fragile rollback.

### Atomic writes

- Write state and skill files to a unique temporary sibling in the destination
  directory, close it, then rename on the same filesystem.
- Clean temporary siblings best-effort on failure.
- Serialize service mutations through one in-process queue/mutex. Two renderer
  invokes must not interleave preflight/state/materialization phases.
- Preserve original errors in the typed result but return safe user-facing
  messages to the renderer.
- Account for Windows replacement semantics in the atomic helper; do not assume
  POSIX rename-over-existing behavior without a tested fallback.

### Enable/save ordering

1. Validate and normalize.
2. Enter mutation lock and check `expectedRevision`.
3. Resolve/deduplicate current provider targets.
4. Preflight every target, including requested explicit conflict resolutions.
5. Persist canonical desired state with incremented revision and `enabled: true`.
6. Materialize targets independently and collect results.
7. Persist successful materialization hashes without incrementing the user
   revision again.
8. Return `active`, `degraded`, or `conflict` with per-target status.

Persisting desired state before provider copies makes recovery deterministic:
after a crash, boot reconciliation knows the intended state and can finish it.

### Disable ordering

1. Enter mutation lock and check revision.
2. Persist `enabled: false` and increment revision.
3. For each materialization, unlink only if current hash still matches the
   recorded hash.
4. Remove the skill directory with non-recursive `rmdir` only if empty.
5. Preserve externally modified or unknown files and return conflict status.
6. Retain the Markdown.

### Boot reconciliation

Reconcile before the renderer window can restore agent sessions, but contain
every error so conventions can never prevent Agent Code from opening:

- Enabled + missing target: recreate.
- Enabled + matching owned target: leave unchanged.
- Enabled + newly registered provider target: install.
- Enabled + modified/unmanaged target: preserve and report conflict.
- Disabled + unchanged recorded materialization: remove.
- Disabled + modified recorded materialization: preserve and report conflict.
- Any permission/read/write failure: preserve desired state and report degraded.

Do not add a filesystem watcher in v1. Audit on boot, Settings-row mount/refresh,
and every mutation. A watcher adds cross-platform churn and a second mutation
source without improving the new-session compatibility promise.

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

export type AgentCodeConventionsTargetState =
  | 'installed'
  | 'missing'
  | 'conflict'
  | 'error'
  | 'not-installed'

export type AgentCodeConventionsTargetStatus = {
  id: string
  providers: AgentProviderKind[]
  displayPath: string
  state: AgentCodeConventionsTargetState
  message?: string
}

export type AgentCodeConventionsSnapshot = {
  revision: number
  enabled: boolean
  markdown: string
  updatedAt: string | null
  health: AgentCodeConventionsHealth
  warnings: string[]
  targets: AgentCodeConventionsTargetStatus[]
}

export type SaveAgentCodeConventionsRequest = {
  expectedRevision: number
  enabled: boolean
  markdown: string
  overwriteTargetIds?: string[]
}

export type AgentCodeConventionsMutationResult =
  | { ok: true; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'validation'; message: string; warnings?: string[] }
  | { ok: false; code: 'revision-conflict'; snapshot: AgentCodeConventionsSnapshot }
  | { ok: false; code: 'target-conflict'; snapshot: AgentCodeConventionsSnapshot }
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
  expectedRevision: number,
): Promise<AgentCodeConventionsMutationResult>
auditAgentCodeConventions(): Promise<AgentCodeConventionsSnapshot>
revealAgentCodeConventionsTarget(targetId: string): Promise<{ ok: boolean; message?: string }>
```

## Provider Capability Contract

Extend `MainProviderConfig` with an explicit Agent Skills capability rather than
teaching the conventions service provider names:

```ts
export type PersonalAgentSkillLocation = {
  id: string
  resolveDirectory: (homeDirectory: string) => string
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
  { id: 'claude-personal-skills', resolveDirectory: home => join(home, '.claude', 'skills') },
]

codex.personalAgentSkills.locations = [
  { id: 'agents-standard-personal-skills', resolveDirectory: home => join(home, '.agents', 'skills') },
]

opencode.personalAgentSkills.locations = [
  { id: 'agents-standard-personal-skills', resolveDirectory: home => join(home, '.agents', 'skills') },
]
```

Add a typed `listMainProviders()` accessor that iterates
`AGENT_PROVIDER_KINDS` through the exhaustive record. The service groups
locations by stable id, asserts duplicate ids resolve to the same normalized
directory, and aggregates provider display names for the UI.

The production service receives the same effective user home inherited by
provider processes. Tests inject an isolated temporary home. Never rewrite
`HOME`, `CODEX_HOME`, Claude configuration roots, or provider authentication
locations to scope this feature to Agent Code; doing so would fork credentials,
transcripts, settings, and caches.

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
npx tsc -p tsconfig.node.json --noEmit
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
- [ ] Declare Claude's `.claude/skills` root and the shared `.agents/skills`
  root for Codex/OpenCode.
- [ ] Add `listMainProviders()` without exposing the mutable backing record.
- [ ] Add a pure target resolver that groups the same stable location id,
  verifies duplicate ids resolve to the same normalized path, sorts provider
  labels and targets deterministically, and produces no duplicate physical
  write.
- [ ] Test current registry coverage: Claude resolves one target, Codex and
  OpenCode resolve one shared target, and every `AGENT_PROVIDER_KIND` has an
  explicit capability decision.
- [ ] Add a thick WHY comment to the registry field explaining why discovery
  roots are provider capabilities while ownership/materialization remains a
  central app concern.

**Verification:**

```bash
npm run test:unit -- src/providers
npx tsc -p tsconfig.node.json --noEmit
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
- Create: `src/main/agentCodeConventions/persistence.test.ts`

- [ ] Add the canonical state-file constant beneath `STATE_DIR`.
- [ ] Implement defensive state coercion. Missing, older, malformed, and
  partially written shapes must become a safe disabled document without
  throwing into app composition.
- [ ] Implement an atomic UTF-8 sibling-write helper with cleanup, Unix modes,
  and tested Windows replacement behavior.
- [ ] Implement `readFileHash` without reading arbitrary large files into
  diagnostics. The skill itself is capped, but an unmanaged collision could be
  huge; cap reads used for ownership inspection and return conflict/error rather
  than consuming unbounded memory.
- [ ] Keep filesystem dependencies injectable: state path, home directory,
  clock, UUID/temp suffix, and optionally I/O functions needed for deterministic
  failure tests.
- [ ] Test no-file default, round-trip, malformed state, atomic replacement,
  temp cleanup, permissions where supported, oversized collision handling, and
  simulated rename/write failures.

**Verification:**

```bash
npm run test:unit -- src/main/agentCodeConventions/persistence.test.ts
npx tsc -p tsconfig.node.json --noEmit
```

**Commit:**

```bash
git add src/main/storage/paths.ts src/main/agentCodeConventions/persistence.ts src/main/agentCodeConventions/persistence.test.ts
git commit -m "feat(conventions): persist managed conventions state atomically"
```

---

## Task 4: `AgentCodeConventionsService` ownership state machine

**Files:**

- Create: `src/main/agentCodeConventions/AgentCodeConventionsService.ts`
- Create: `src/main/agentCodeConventions/AgentCodeConventionsService.test.ts`
- Create: `src/main/agentCodeConventions/index.ts` only if a narrow public barrel
  reduces composition imports; do not create a broad convenience barrel.

Public service surface:

```ts
class AgentCodeConventionsService {
  initialize(): Promise<void>
  getSnapshot(options?: { audit?: boolean }): Promise<AgentCodeConventionsSnapshot>
  save(request: SaveAgentCodeConventionsRequest): Promise<AgentCodeConventionsMutationResult>
  disable(expectedRevision: number): Promise<AgentCodeConventionsMutationResult>
  clear(expectedRevision: number): Promise<AgentCodeConventionsMutationResult>
  audit(): Promise<AgentCodeConventionsSnapshot>
  resolveRevealTarget(targetId: string): Promise<string | null>
}
```

- [ ] Serialize all mutations and audited reads that can adopt/repair state.
- [ ] Implement target preflight, managed hash comparison, current-render
  adoption, unmanaged-directory conflict detection, explicit overwrite target
  ids, and per-target status.
- [ ] Implement desired-state-first enable/update, successful-materialization
  hash persistence, and degraded partial failure.
- [ ] Implement safe disable using exact hash proof, `unlink`, and non-recursive
  empty-directory removal.
- [ ] Implement clear as disable-first; do not erase canonical content if a
  required safe-disable state mutation fails before desired state becomes off.
  Modified external copies may remain as conflicts after desired state is off,
  but the user must see that result before content is cleared.
- [ ] Implement boot reconciliation and keep initialization errors contained in
  the service snapshot.
- [ ] Ensure audit is observational except for narrowly defined crash recovery:
  adopting a current generated managed file and finishing desired-state
  reconciliation. It must never overwrite a conflict just because Settings was
  opened.
- [ ] Test against a fresh `mkdtemp` home only. Include: off creates no provider
  dirs; enable writes two physical copies for three providers; bytes are
  identical; save update; disable retain body; clear; duplicate target
  deduplication; revision race; unmanaged collision; unknown sidecar file;
  external modification; crash after skill write; crash after desired state;
  missing target repair; permission failures; one-target partial failure;
  newly registered target; and concurrent save serialization.
- [ ] Assert every delete in the implementation is exact-file `unlink` or empty
  `rmdir`. No test or production path may call recursive removal on a provider
  target.

**Verification:**

```bash
npm run test:unit -- src/main/agentCodeConventions/AgentCodeConventionsService.test.ts
npx tsc -p tsconfig.node.json --noEmit
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

- [ ] Register get/save/disable/clear/audit/reveal handlers with the service
  passed explicitly through `IpcDeps`.
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
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
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
- [ ] Catch/contain initialization inside the service. Main composition should
  not require a surrounding fatal catch for a convenience feature.
- [ ] Pass the service explicitly into `registerAllIpc`.
- [ ] Record only health, target count, revision, duration, and error codes in
  startup diagnostics. Never hashes of user text if those hashes could become a
  cross-log identifier; materialization hash prefixes are allowed only in local
  debug logging when genuinely needed.
- [ ] Verify an unwritable injected home produces a usable main window and a
  degraded Settings snapshot in a test or controlled manual run.

**Verification:**

```bash
npx tsc -p tsconfig.node.json --noEmit
```

**Commit:**

```bash
git add src/main/index.ts src/main/ipc/index.ts src/main/agentCodeConventions
git commit -m "feat(conventions): reconcile personal skills during app startup"
```

---

## Task 7: Settings category and self-subscribing row

**Files:**

- Modify: `src/renderer/src/features/settings/lib/settingsCategories.ts`
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx`
- Create: `src/renderer/src/features/settings/ui/AgentCodeConventionsRow.tsx`
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
- [ ] Render loading, disabled, active, degraded, and conflict states without
  collapsing desired enabled state into health.
- [ ] Enabling with saved valid content calls IPC directly. Enabling without
  content opens the editor. Disabling always confirms.
- [ ] Render provider groups and friendly `~` paths from the main snapshot; do
  not reconstruct paths in the renderer.
- [ ] Keep mutation errors inline. Never optimistically show Active before main
  returns the audited snapshot.
- [ ] The row owns modal state so `SettingsPage` does not accumulate another
  feature-specific editor target like the theme editor unless the existing
  dialog stacking/focus behavior proves that ownership wrong.

**Verification:**

```bash
npm run test:renderer -- AgentCodeConventionsRow
npx tsc -p tsconfig.web.json --noEmit
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
- Add/modify focused renderer tests

- [ ] Implement the modal shown in the UI contract using existing `Dialog`,
  `Button`, and `Textarea` primitives.
- [ ] Keep `{revision, enabled, markdown}` as one modal draft. Save one atomic
  request with the revision captured when the modal opened.
- [ ] Display character and line counts live. Display server-returned warnings
  and validation errors; mirror simple counts in the renderer for immediacy but
  let main validation remain authoritative.
- [ ] Add explicit starter insertion, exact generated-skill preview, dirty-close
  confirmation, secret/context warning, and per-target install status.
- [ ] On revision conflict, preserve the user's draft and offer **Reload latest**
  or **Copy draft**. Never silently replace either side.
- [ ] On unmanaged/modified target conflict, show target path and actions:
  **Reveal**, **Cancel**, and **Replace after confirmation**. The final action
  reissues the same draft/revision request with only the confirmed target id in
  `overwriteTargetIds`.
- [ ] Never offer bulk “overwrite every conflict” without showing each path.
- [ ] After a successful enabled save, render the new-session compatibility
  notice. Do not call `workspace.reloadAgentSessions`.
- [ ] Add disable and disable-and-clear confirmation copy exactly describing
  retained/deleted data and possible external conflict remnants.
- [ ] Test stale revision, validation error, insert starter, preview switching,
  dirty cancel, target-specific overwrite confirmation, disable retention, and
  save success notice. Mock preload responses; filesystem behavior remains in
  main tests.

**Verification:**

```bash
npm run test:renderer -- AgentCodeConventions
npx tsc -p tsconfig.web.json --noEmit
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
- [ ] Run both TypeScript projects directly; `electron-vite build` does not
  replace these gates.
- [ ] Run the full unit and renderer projects.
- [ ] Run the full repository check before marking the PR ready.
- [ ] If package verification requires fetched runtime artifacts unavailable in
  the development environment, record the exact skipped command and let CI run
  it; do not weaken scripts or checks to make the branch green locally.

Commands:

```bash
npm run test:unit -- src/main/agentCodeConventions
npm run test:renderer -- AgentCodeConventions
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm run test:unit
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
- [ ] Verify an Agent Code-orchestrated child session also sees the global skill.
- [ ] Create a disposable repository-local instruction that conflicts with the
  commit example and verify the more-specific local instruction wins.
- [ ] Update the body, start new sessions, and verify the new marker.
- [ ] Keep one agent running across a save and confirm the UI makes no promise
  that this existing session refreshed.
- [ ] Modify one managed copy externally, audit, and verify conflict status with
  no overwrite. Resolve only that target through explicit confirmation.
- [ ] Create an unmanaged collision on a clean target and verify enable is
  blocked before any other new target is written.
- [ ] Disable and verify unchanged managed copies are removed, directories are
  removed only when empty, and saved body remains visible.
- [ ] Clear and verify canonical body is empty.
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
  copy.
- [ ] The UI distinguishes desired enabled state from actual deployment health.
- [ ] Empty, oversized, NUL-containing, and stale-revision saves fail safely.
- [ ] No unmanaged or externally modified file is overwritten or deleted
  without target-specific explicit confirmation.
- [ ] Disable retains content and removes only hash-proven managed artifacts.
- [ ] Clear is explicit and does not leave the UI claiming all copies are gone
  when a conflict remains.
- [ ] Startup reconciliation repairs missing owned materializations and never
  prevents the app from opening.
- [ ] New/restarted Claude Code, Codex, and OpenCode sessions discover the skill.
- [ ] Existing sessions are not silently reloaded.
- [ ] Provider differences live in the provider registry capability.
- [ ] Renderer code never writes arbitrary filesystem paths.
- [ ] Conventions content never enters diagnostics, logs, prompt wrappers, or
  transcripts through Agent Code code.
- [ ] No repository file, provider config, authentication store, global
  `AGENTS.md`, or global `CLAUDE.md` is modified.
- [ ] Thick WHY comments make ownership and safety invariants transparent in the
  implementation diff.
- [ ] Focused tests, both raw TypeScript checks, full test tiers, package checks,
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
