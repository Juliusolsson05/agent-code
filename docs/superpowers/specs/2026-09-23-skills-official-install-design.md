# Skills: official install command, no count caps, Settings → Skills — design

Status: user-approved 2026-09-23 · Branch: `feat/skills-official-install`
Issue: #1161 · Builds on: `docs/design/agent-code-conventions.md` (the
managed-skills subsystem), #1143 (the MCP servers grid and the "an agent
proposes, the user approves" rule).

## What the user asked for

- "Why are we limiting skills to 25 … let's not cap it."
- "Skill download should not happen from a repo alone. We need the official
  support. It is kind of specific how the installation command runs."
- "We are trying to discover based on repo. That works optionally, and we
  should still keep that, but I see people run the `--skill XXX`."
- They approved the ASCII redesign: Settings → Skills with provider columns,
  an Add dialog that accepts the command, "Also found on this machine",
  commands, and an agent capability. Then: "build all of this out using the
  agent code conventions."

## Evidence (researched 2026-09-23)

### Nobody caps the number of skills

- Claude Code, Codex, OpenCode and the Agent Skills spec have no count limit.
- The only real constraint is a **context budget** for the listing of skill
  names and descriptions:
  - Claude: about 1% of the context window.
  - Codex: about 2%.
- Both CLIs shorten descriptions when the listing exceeds the budget. They never
  refuse a skill.
- So all of these were invented by Agent Code:
  - `AGENT_CODE_INSTALLED_SKILL_MAX_COUNT = 25`, including the check in
    `persistence.ts` that sends a larger document into **recovery mode**;
  - `AGENT_CODE_CUSTOM_SKILL_MAX_COUNT = 50`;
  - `MAX_CANDIDATES = 100` per repository;
  - the IPC cap of 100 `candidateIds`.
- `AGENT_CODE_INSTALLED_SKILL_SNAPSHOT_ROOT_MAX_BYTES` (256 MiB, 32,768 entries)
  is also a count cap in practice. Snapshots are never deleted, so a
  long-lived install eventually refuses every new package and tells the user
  to "Quit Agent Code and remove old snapshots".

### The official install surface is `npx skills` (vercel-labs/skills 1.7, skills.sh)

The command:

```
npx skills add <source> [-g] [-a <agents…|'*'>] [-s|--skill <names…|'*'>]
                        [-l|--list] [-y] [--copy] [--all] [--full-depth]
```

- `add` has the aliases `a`, `install` and `i`.
- `--all` means `--skill '*' --agent '*' -y`.

**Sources** (`src/source-parser.ts`):
- GitHub shorthand: `owner/repo`, `owner/repo/sub/path`, `owner/repo@skill`
  (a skill filter), `owner/repo#ref` and `owner/repo#ref@skill`.
- `github:owner/repo[/sub/path]`.
- GitHub URLs: `https://github.com/o/r[/tree/<ref>[/<path>]]`.
- `git@github.com:o/r.git`.
- Other hosts: GitLab and `gitlab:`, Azure, any `*.git` URL, well-known HTTPS
  endpoints, archives and local paths.

**Discovery** (`src/skills.ts`). `searchPath` is the source's sub path, or the
repository root.
1. If `<searchPath>/SKILL.md` exists, it is a candidate, and discovery
   **stops there** unless `--full-depth` is passed.
2. Priority containers are searched in this order:
   - `searchPath` itself, at depth 1 (its direct children only), so stray
     `examples/foo/SKILL.md` files are not picked up;
   - `skills/`, `skills/.curated`, `skills/.experimental` and `skills/.system`;
   - each agent's project skill folder (`.agents/skills`, `.claude/skills`,
     `.cline/skills` … `.zencoder/skills`);
   - folders named by plugin manifests.

   Every container except `searchPath` is walked up to
   `DEFAULT_SKILL_CONTAINER_DEPTH` (3), and the walk **stops descending below
   a skill it has found**.
3. If nothing was found, or `--full-depth` is set, discovery falls back to a
   full recursive `findSkillDirs`. It goes up to 5 levels deep, skips
   `node_modules`, `.git`, `dist`, `build` and `__pycache__`, and does not stop
   below a skill.
4. Skills with `metadata.internal: true` are hidden unless the user asked for
   them by name.
5. When names are duplicated, the first one found wins.
6. `--skill` matches, case-insensitively, either the frontmatter `name` or the
   folder name.

**Layout:**
- One canonical copy goes in `~/.agents/skills/<name>`, with a symlink per
  agent (`~/.claude/skills/<name>` → canonical). `--copy` writes real copies
  instead.
- Codex and OpenCode read `~/.agents/skills` directly.
- The lock file is `~/.agents/.skill-lock.json` (v3). It records, per skill:
  `source`, `sourceType`, `sourceUrl`, `ref`, `skillPath` and
  `skillFolderHash`.
- Telemetry is on unless `DISABLE_TELEMETRY=1` is set.

**Vendor CLIs** install *plugins* from marketplaces, not bare skills:
- `claude plugin install x@y`;
- `codex plugin add x@y`.

Codex's `$skill-installer` is a chat skill that writes to the deprecated
`~/.codex/skills`. OpenCode has no installer.

## Decisions

### D1. Parse the command and install through our own pipeline; never run `npx skills`

The user approved option A. Agent Code reads the command and installs through
its own journaled, content-verified pipeline.

Why not run the real binary:
- It would need Node or npx on every machine.
- It sends telemetry.
- It symlinks into provider roots, which breaks the "never follow a provider
  symlink" rule.
- Most importantly, Agent Code's ownership journal could not protect files it
  did not write.

The result on disk is the same as `npx skills add … --copy`: a real copy of the
package in each provider root.

### D2. Corrections to the approved mockup (tell the user)

1. **No symlinks.** The mockup showed `~/.claude/skills/x → ~/.agents/skills/x`.
   The managed-skills Warning forbids following provider symlinks, and the
   materializer's verified-copy mechanics depend on real files. Each physical
   root gets a real copy, exactly like `npx skills --copy`.
2. **`.skill-lock.json` is read-only.** Writing entries would let `npx skills
   update` rewrite files that Agent Code's journal owns. The next reconcile
   would then report a conflict on every such skill. Agent Code reads the lock
   file only to show provenance in "Also found on this machine".
3. **Nothing to migrate from `~/.codex/skills`.** Codex has targeted
   `~/.agents/skills` since the conventions feature shipped (see
   `registry.main.ts`).
4. **No "Adopt".** The ownership rules forbid turning an unmanaged folder into a
   managed one ("a pre-existing unmanaged destination is a collision and cannot
   be adopted"). Name or marker evidence is not ownership proof. "Also found"
   therefore offers:
   - **Reveal** (open the folder);
   - **Hide** (per viewer);
   - **Manage with Agent Code**. When the lock file names a source, this
     prefills the Add dialog with `npx skills add <source> --skill <name>` and
     explains that the existing folder must be removed first (for example with
     the copyable `npx skills remove -g <name>`). Installing over it would
     otherwise hit the normal `target-conflict`.
5. **Pinning.** Installs always pin the exact commit, the recorded behaviour
   today. The dialog's "follow main" radio is dropped. "Update available" comes
   from an explicit check and is always reviewed before it's applied. A
   background auto-follow would break the design doc's "no background checks
   or automatic updates" rule.

### D3. Remove count caps; keep the per-skill guards

Removed:
- `AGENT_CODE_INSTALLED_SKILL_MAX_COUNT`, both the install check and the
  `parseDocument` load reject;
- `AGENT_CODE_CUSTOM_SKILL_MAX_COUNT`;
- `MAX_CANDIDATES`;
- the IPC `candidateIds` and `abandonTargets` length caps.

An install request can only name candidates from a staged discovery, so the
discovery bounds it.

Kept, because they protect against a hostile or huge *package*, not against
having many skills:
- per-file 5 MiB;
- per-package 10 MiB and 256 files;
- `SKILL.md` 128 KiB;
- a 4 MiB tree response;
- a 25 MiB discovery budget, which after D6 is charged only for `SKILL.md`
  reads.

The only aggregate ceiling left is the 16 MiB state document. That is
thousands of skills, and a write over it fails with the existing clear I/O
error, never recovery mode.

`AGENT_CODE_INSTALLED_SKILL_MAX_STAGED_DISCOVERIES` (5) is internal memory
hygiene, not a skills limit. After D6, staged discoveries hold only tree
metadata. "Check all for updates" stages one discovery per source, so 5 would
expire most reviews before the user opens them. The cap is raised to 512, with
TTL eviction first and then least-recently-staged.

### D4. Snapshot cleanup without recursive deletion

The design doc retained unreferenced snapshots because a portable
`rm -rf` cannot be anchored to a validated directory handle. The cleanup below
removes them using **only** non-recursive primitives, each bounded by
content addressing:

1. **Quarantine.** `rename(<root>/<digest>, <root>/.trash-<digest>-<uuid>)`.
   The rename happens within the validated private root, and the new name is
   unguessable.
2. **Recompute.** Walk the quarantined directory with the existing
   `walkRegularFiles`, which rejects links, special files, unsafe paths and
   more than 256 files. Hash each file and rebuild the manifest from disk.
   **Require** `manifestDigest(onDisk) === digest`. Content addressing makes the
   directory name a proof of its exact bytes. Any mismatch (unknown file,
   changed byte, link) aborts, and the quarantined directory is left in place,
   inert.
3. **Unlink.** Unlink each file, but only after re-checking that its hash still
   matches.
4. **Remove directories.** `rmdir` each directory deepest-first, then the
   quarantine root. `rmdir` fails on any non-empty directory, so an unexpected
   entry stops the cleanup instead of widening it.

Residual risk, accepted and documented at the code: if an ancestor is replaced
between the check and the unlink, the unlink could land elsewhere. Even then,
it can only remove a file whose bytes equal a file of our own snapshot, at the
same relative path. That is the same bound the provider-root removal already
accepts.

**Sweep.**
- It runs on initialize under the mutation lock, skipped in recovery.
- It also runs after delete and after update.
- It removes every 64-hex child and every `.trash-<digest>-*` child not
  referenced by `installedSkills`, `installedMaterializations` or
  `installedPendingOperations` (previous and desired digests).
- `.staging-*` leftovers have no digest to prove their identity, so they stay.
  They are rare, inert and bounded per package.
- The root budget check is deleted. Admission is bounded per package and
  cleanup is automatic.

### D5. One install-source parser, shared by main and the renderer

`src/shared/skills/installSource.ts` is pure. The renderer uses it for the live
"Understood: …" line. Main uses it as the authority and re-parses the raw
text, never trusting a renderer-parsed object.

**Tokenizer.** POSIX-shell subset: single and double quotes, backslash, and
whitespace. Command substitution and `$VAR` are refused, because they are
never needed in an install line and cannot be evaluated faithfully.

**Command prefixes:**
- `npx [-y] skills[@<ver>]`;
- `bunx skills`;
- `pnpm dlx skills`;
- `yarn dlx skills`;
- bare `skills`.

Any of these must be followed by `add`, `a`, `install` or `i`. A bare source
with no command prefix is accepted too.

**Flags:**

| Flag | Meaning |
|---|---|
| `-s` / `--skill <names…>` (also `--skill=a,b`) | Choose skills; the list runs until the next flag. `'*'` means all. |
| `-a` / `--agent <agents…>` | Choose providers. `claude-code`/`claude` → claude, `codex` → codex, `opencode` → opencode, `pi` → pi, `'*'` → every provider. Any other agent becomes a notice: "cursor is not managed by Agent Code". |
| `--all` | Same as `--skill '*' --agent '*'`. |
| `--full-depth` | Keep searching below a root `SKILL.md`. |
| `-l` / `--list` | Browse mode: nothing preselected. |
| `-g`, `-y`, `--copy` | Accepted and ignored, because Agent Code always installs per user, with real copies, after review. |

Unknown flags are an error that names the flag.

**Sources.** `@skill` and `#ref` are understood wherever `npx skills`
understands them.
- GitHub shorthand, `github:`, `https://github.com/…`, `github.com/…`
  without a scheme, and `git@github.com:o/r(.git)`.
- skills.sh pages, `https://skills.sh/<owner>/<repo>[/<skill>]`, which is
  where people copy commands from.
- GitLab, Azure, `.git` URLs, well-known URLs, archives and local paths return
  `unsupported-source`. The message says to use a GitHub source.

  Why local paths are refused: the renderer must never hand main an arbitrary
  path ("never accept an arbitrary renderer path"). Local import would need a
  main-owned file picker, which is a follow-up.

**Output:**

```
{ github: { owner, repository, ref?, subpath? },
  skills: string[] | '*' | null,
  providers: AgentProviderKind[] | null,
  fullDepth, listOnly,
  notices: string[] }
```

### D6. Discovery follows `npx skills`, and acquisition is lazy

`GitHubSkillSource.discover(source, { fullDepth, requestedSkills })`:

- **Ref and path resolution** reuses the hardened `git ls-remote` and the
  longest-advertised-ref logic.
  - `#ref` and `tree/<ref>/<path>` resolve as they do today.
  - `owner/repo/sub/path` means the default branch plus a sub path.
- **Candidate folders** are picked by the D5 algorithm, run over the verified
  commit tree (no filesystem access):
  - the root `SKILL.md`, which short-circuits;
  - the priority containers. "Agent project folders" is generalized to **every
    top-level `.<name>/skills` folder**. That is a superset of vercel's
    hard-coded list, which grows every release;
  - `.claude-plugin/marketplace.json` `plugins[].skills` paths;
  - the fallback recursive search at depth 5, with the skip list.
- **Hard failures and notices.** Anything wrong with the source or tree fails
  the discovery. Anything wrong with one skill skips it with a notice:
  - the checks that fail the whole discovery (unsafe paths, links, gitlinks,
    modes, collisions, and file or size limits) are still computed **from the
    tree**, before anything is downloaded;
  - duplicate names become a notice ("skipped the second `pdf`, at `x/pdf`"),
    no longer an error;
  - `metadata.internal` skills are hidden unless requested;
  - **the requirement that a folder's name match its `name:` is dropped.**
    `npx skills` installs under the frontmatter name, and Agent Code already
    materializes to `<root>/<name>`. The rule only rejected real repos, for
    example a root `SKILL.md` in a repo named `foo-skill` whose skill is `foo`.
    Portable name validation (lowercase kebab, at most 64 characters) is kept.
- **Selection.** With `requestedSkills`, only the matching folders are read,
  by name or folder name, case-insensitively. Names that match nothing are
  returned as `missingSkills`.
- **Lazy acquisition.** Discovery downloads **only `SKILL.md`** for each
  candidate, verifying its bytes against the tree blob ID. The review manifest
  (paths, sizes and executable bits) comes from the commit tree.
  - Each staged candidate keeps the tree entries, meaning each file's object
    ID, as its identity.
  - `acquire(staged)` fetches the remaining files at install or update time.
    It verifies every file against the reviewed blob ID and returns today's
    `StagedInstalledSkillCandidate`.
  - Blob IDs tie the downloaded bytes to the exact commit the user reviewed.
    The snapshot digest is computed after acquisition.
  - `candidateId` becomes the hash of repo, commit, root and the sorted
    (path, object ID, mode) tree manifest. That is equally binding and
    available before download.
- **Acquisition happens outside the mutation lock.** The staged lookup and the
  network fetch run first. Then the serialized mutation revalidates the
  revision and stores the acquired packages. Holding the single-writer queue
  across network I/O would freeze every other skills operation.

### D7. Per-provider choices

`AgentCodeInstalledSkillRecord` and `AgentCodeCustomSkillRecord` gain an
optional `providers?: AgentProviderKind[]`. When it is absent, the skill goes
to every supporting provider, which is today's behaviour, so no migration is
needed.

- The strict validators ignore unknown keys. A downgraded app therefore reads
  the document fine and simply deploys everywhere, which is safe.
- **Targets.** A target is included when its `providers` overlap the record's
  providers.
- **OpenCode is derived.** OpenCode reads both physical roots. Choosing only
  Claude still writes to the Claude root, which OpenCode also sees. The grid
  shows that honestly, as "visible via Claude's folder" (derived from the
  included targets), rather than pretending otherwise.
- **Changing providers** (`setInstalledSkillProviders` and
  `setCustomSkillProviders`) takes one durable write.

  *As built:* newly chosen roots are preflighted first, so a collision changes
  nothing. Reconciliation then journals syncs for chosen roots and deletes for
  deselected current roots, through the existing write-ahead journal. The
  skill never goes through a disable/enable flicker, and a dropped root is
  never mistaken for a retired one.

  *Superseded draft:* disable, change the field, re-enable.
- A disabled skill only records the field.
- Install requests carry `providers`, taken from `-a` or the dialog.
- The Conventions skill and product skills stay on every provider.

### D8. "Also found on this machine" (read-only)

`agent-code-skills:external` lists the direct children of every current target
root. It uses `collectInstalledAgentSkills` with the `children` layout, and
passes the union of `getInstalledSkillLocations` across every supporting
provider as "managed" evidence. It returns rows whose source is not
`agent-code`, containing:
- name and description;
- which roots it is in;
- whether the folder is a symlink (the `npx skills` default);
- provenance from `~/.agents/.skill-lock.json`: `source` and `sourceUrl`.
  The lock file is bounded (1 MiB), parsed defensively, and never written.

Reveal re-derives the path in main from `(targetId, name)`, so the renderer
never supplies a path. Hide lives in the renderer's settings, keyed by
`targetId:name`.

### D9. Settings → Skills

There is a new `skills` category after MCP. The three rows under Agents move
into it:

- **`skills`**, the new grid:
  - a toolbar with a filter box, **Check updates** and **+ Add skill…**;
  - provider columns;
  - sections: **Agent Code** (Conventions status, and TLDR and Goal shown as
    managed), **Your skills** (custom; `+ New…` opens the existing editor
    modal), **Installed**, and **Also found on this machine** (collapsible);
  - a footer with the skill count and an estimated description budget.

  Columns appear only for providers that support personal skills and are
  enabled in Settings → Providers. Each cell means "new agents of this
  provider get it". Master on/off, the `⋯` actions (reveal source, reveal each
  target, check update, remove), update badges, conflicts and review-pending
  badges all live in the row.
- **`agent-code-conventions`**: unchanged, moved to the new category.
- **`agent-code-custom-skills`**: unchanged editor, moved.
- **`agent-code-installed-skills`**: retired. The grid replaces it. The old
  modal's review panels (`DiscoveryReview`, `UpdateReviewPanel`,
  `CandidateDetails` and `TargetList`) move into `features/skills/ui`.

**The Add dialog** has:
- one input that accepts the command, a source or a URL;
- a live "Understood: …" line;
- **Find skills**, which runs the main discovery;
- a list preselected from `--skill` (browse mode preselects nothing), with a
  filter and Select all;
- notices, missing skills and warnings;
- provider checkboxes prefilled from `-a`;
- **Install N skills**.

Commands (`features/skills/commands/skillsCommands.ts`):

| Command | What it does |
|---|---|
| `Skills` | Opens Settings → Skills. |
| `Add Skill…` | Opens the Add dialog through the surfaces registry. |
| `Check Skill Updates` | Opens Settings → Skills and starts check-all. |

### D10. The agent `skills` built-in MCP domain

Tools, backed by the same service methods and results as the UI:

- `skills_list`: managed skills with their state, pending review and
  providers, plus a summary of what was also found.
- `skills_find(source)`: takes the command or a source, and returns candidates
  (name, description, path, file count, warnings, internal, missing).
- `skills_add(source, skills?, providers?)`: discovers and installs with
  `enabled: false` and
  `pendingReview: { by: 'agent', sessionId, requestedAt }`.
- `skills_remove(name)`: only for skills that are still pending review, meaning
  an agent can withdraw its own proposals. Removing a skill the user reviewed
  stays a user action.

Rules:
- **Agents can never enable a skill.** The user enabling a skill in the grid
  clears `pendingReview`.
- The domain is **off by default**. It sits in
  `PARENT_HELD_ONLY_BUILT_IN_MCP_DOMAINS`, so orchestration children cannot be
  given it unless the parent holds it. Unlike Root Management, it is not
  confirmation-gated, because its worst case is a disabled proposal.
- Instructions, a toast and the grid badge follow `mcp_servers`.
- New skills reach new agents. Claude and OpenCode rediscover them live, and
  Codex on its next session. The agent is told that.

## Out of scope and follow-ups

- Non-GitHub hosts (GitLab, Azure, generic git, archives) and local paths.
  The latter needs a main-owned folder picker.
- Plugin marketplaces (`claude plugin`, `codex plugin`).
- Writing `.skill-lock.json`.
- Automatic update following.
