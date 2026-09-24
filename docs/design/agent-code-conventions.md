# Agent Code managed personal skills

Agent Code can store machine-wide personal Agent Skills and expose them to every
registered agent provider. Agent Code Conventions is the reserved, encouraged
skill with its own Settings experience. Custom Skills is a separate manager for
instruction-only skills authored inside Agent Code. Installed Skills is a third,
source-management surface for reviewed packages imported from public GitHub
repositories. All three publish through the same ownership and reconciliation
authority; project, plugin, organization, and externally installed skills remain
outside Agent Code ownership.

The feature is intentionally a native skill rather than hidden prompt text.
That keeps provider activation semantics honest: providers discover metadata
and load the body when relevant, active sessions are not silently rewritten,
and the same CLI can discover the skill when launched outside Agent Code.

## Sources of truth

`~/.config/agent-code/conventions.json` is the legacy-named, sole canonical
collection and desired-state record. Schema v3 retains the Conventions and
custom-skill fields and adds GitHub source provenance, installed package
manifests, and package-level pending operations. Keeping the existing path lets
schema-v1 and schema-v2 ownership evidence migrate without creating competing
canonical stores. Provider skill directories are generated artifacts. Editing
one never imports content back into Agent Code.

Reviewed package bytes live separately under the private, content-addressed
`managed-skill-snapshots` state directory. The JSON document names an immutable
manifest digest; it never embeds binary assets or accepts a renderer path. A
snapshot becomes durable before desired state can reference it, and every read
rechecks its bounded manifest and hashes.

Snapshots that no record, materialization or pending operation references are
removed (#1161). This happens after delete and update, and in a sweep at
startup. Removal never uses recursive deletion:

1. The directory is renamed to `.trash-<digest>-<uuid>` inside the root.
2. Its manifest is rebuilt **from disk** and must hash to the digest. Content
   addressing makes the name a proof of the exact bytes.
3. Each file is re-hashed and unlinked.
4. Directories are removed deepest-first with `rmdir`, which refuses anything
   non-empty.

Anything that fails the proof stays in place, inert. The residual
ancestor-swap race can at worst unlink a file byte-identical to one of our own
snapshot files at the same relative path. `.staging-*` leftovers carry no
digest to prove, so they are left alone.

This replaced the former "retain forever" rule and its 256 MiB root cap. In
practice that cap became a hidden limit on how many skills a user could
install.

There is no cap on how many skills Agent Code manages. Every remaining limit
bounds one package or one network response. The 16 MiB state document is the
only aggregate ceiling. It holds thousands of skills, and exceeding it is an
ordinary I/O error, never recovery.

The persisted revision is a compare-and-swap token for renderer mutations.
Deployment health is separate from desired `enabled` state: an enabled document
can be degraded, conflicted, unsupported, or awaiting state recovery.

The renderer receives paths and health through typed IPC. It never constructs
provider paths or writes arbitrary files. Preview also runs in main so the
product-owned wrapper has one implementation.

## Isolation boundary

`AgentCodeManagedSkillsService` is the subsystem's single writer and the only
production consumer of `persistence.ts`, `ownershipPolicy.ts`, and
`skillPathSafety.ts`. The ownership policy is pure and reconciles untrusted
state identities with current registry targets without touching disk. Path
safety owns bounded inspection, link rejection, directory creation,
journal-temp cleanup, and capture-before-delete mechanics; it does not know
providers or UI. The service consumes both and emits typed, surface-specific
snapshots over one canonical collection.

Production code outside `src/main/agentCodeConventions/` must not import those
low-level modules, mutate managed skill state, or arbitrate between provider
roots. IPC may call the service, renderer code may consume snapshots, and the
session manager may invoke the opaque pre-session reconciliation callback.
Provider modules declare discovery capabilities only. This single-consumer
shape is intentional: duplicating even one deletion or collision rule in a
consumer would create a second source of ownership truth.

Agent Status uses the service's read-only `getInstalledSkillLocations` projection
to attribute known deployments. It neither initializes nor audits the service,
and it derives file paths from the resolved target registry and the canonical
document — never from a status's user-facing `displayPath`. A status whose id no
longer names a current target (retired, unsupported, initialization error)
cannot produce an Agent Code label. The separate `src/main/agentSkills/`
collector reads metadata from native skill roots declared by provider discovery
adapters, walks each root in the layout its provider actually uses, and labels
matching files as Agent Code-managed. Missing files are omitted, never repaired
by inspection; unmanaged files remain outside this service's ownership. The
inventory reports installation evidence, not the running provider's activation
or loaded context.

`githubSkillSource.ts` and `installedSkillPackageStore.ts` are focused helpers,
not additional authorities. Acquisition returns inert, bounded package bytes;
the service alone decides whether those bytes may enter canonical state or a
provider root. `installedSkillMaterializer.ts` receives only an already-durable
package operation and returns evidence for the service to persist.

## Provider discovery capability

Every entry in the exhaustive main provider registry declares whether it
supports personal Agent Skills and, if so, how to resolve its discovery roots.
The conventions service owns all writes and deletion policy; providers own only
the discovery fact.

Claude honors `CLAUDE_CONFIG_DIR` and otherwise uses `~/.claude/skills`. Codex
uses `~/.agents/skills`. OpenCode documents both roots, so it is attributed to
both physical targets even though Agent Code writes only two identical files.
Target resolution deduplicates canonical physical paths and a future unsupported
provider prevents a new “all agents” enable.

## Generated artifact

The directory and frontmatter name are always `agent-code-conventions`. Agent
Code owns the description, wrapper, and management marker. User Markdown appears
only below `## User-authored conventions`, never in YAML, which prevents
frontmatter injection and keeps discovery stable. Rendering normalizes newlines,
caps the UTF-8 body at 32 KiB, and produces one trailing newline.

The management marker is identification, not ownership proof. Anyone can copy
public marker text.

Custom skill names are immutable lowercase kebab-case identifiers no longer
than 64 characters. Descriptions are structured single-line values no longer
than 1,024 characters, and instructions have the same bounded, normalized
Markdown treatment as Conventions. Agent Code serializes `name` and
`description` frontmatter itself; the editor never accepts raw YAML. Custom
names cannot claim the reserved `agent-code-conventions` or `agent-code-tldr` destinations.

Custom management deliberately excludes personal skills installed by other
tools, repository-local skills, plugins, and skills with scripts, references,
or assets. The service inspects only an exact destination it is about to
publish. A pre-existing unmanaged destination is a collision and cannot be
adopted or replaced from the Custom Skills UI.

## Product-owned reporting skill

TLDR uses the same single writer and ownership journal for the reserved
`builtin:agent-code-tldr` instruction record. Its canonical content lives in
`src/shared/types/tldr.ts`, and its snapshot is marked as product-managed so
Custom Skills cannot edit, disable, or delete it. Enabling TLDR for a session
reconciles this skill before starting the provider; a collision fails that
launch rather than silently dropping the reporting instructions. Personal
Conventions remain independently enabled and unchanged.

Once deployed, the skill stays installed because other agents can still need
it. Its instructions are inactive unless the current session exposes the TLDR
MCP tool. Disabling a single session revokes that capability; it does not remove
shared provider files. MCP initialization also supplies the same reporting
instructions because native skill discovery alone cannot guarantee activation.

## GitHub-installed packages

### Accepted input

Settings → Skills → Add accepts the same input people paste from READMEs and
skills.sh:

- `npx skills add <source> [--skill …|'*'] [-a …] [--all] [--full-depth]`. The
  flags `-g`, `-y` and `--copy` are accepted and change nothing here.
- `owner/repo[@skill]`, `owner/repo/path`, `owner/repo#ref`, `github:`,
  `git@github.com:…`, skills.sh pages, and public `https://github.com/<owner>/<repo>`
  and `/tree/<ref>/<path>` URLs.

`src/shared/skills/installSource.ts` parses the text. Main re-parses it as the
authority. Other hosts and local paths are refused with a clear message: local
import needs a main-owned folder picker, because a renderer path is never
accepted.

### Discovery

Candidate folders are chosen by the rules of vercel-labs `npx skills` 1.7:

1. A `SKILL.md` at the search path is the only candidate, unless `--full-depth`
   is given.
2. Otherwise these containers are searched:
   - the direct children of the search path;
   - `skills/`, `skills/.curated`, `skills/.experimental` and `skills/.system`,
     three levels deep, stopping below each skill found;
   - every top-level `.<agent>/skills` folder;
   - folders listed in `.claude-plugin/marketplace.json`.
3. If nothing was found, a depth-5 recursive fallback runs. It skips
   `node_modules`, `.git`, `dist`, `build` and `__pycache__`.
4. Duplicate names are resolved first-found-wins, with a notice.
5. `metadata.internal` skills appear only when named.

Packages install under their frontmatter name. The source folder's name is not
required to match it.

### Lazy acquisition

Discovery downloads each candidate's `SKILL.md` and nothing else. The review's
file list, sizes and executable bits come from the commit tree, and each
reviewed file is bound to its blob ID.

`acquire` fetches a selected package at install or update time. It verifies
every byte against those blob IDs, then computes the sha256 manifest.
Acquisition runs outside the mutation lock, and the mutation re-checks the
revision and the staged review. Update checks acquire only the one package
they diff and keep no bytes.

The details of ref resolution and transport follow. Discovery uses a hardened `git ls-remote`
without a shell to resolve advertised branch/tag identity; its subprocess
environment is allowlisted so askpass, credential, proxy, and TLS overrides
cannot cross into acquisition. Repository content is never cloned. The exact
commit's recursive tree and only selected raw blobs come from allowlisted
GitHub HTTPS endpoints through streaming in-memory limits, and every raw blob
must match the Git object ID in that commit tree before review. This keeps
repository-controlled acquisition off disk until the bounded, reviewed package
is admitted to the private snapshot store. One discovery-wide content budget
reserves each tree-advertised blob before transport and charges accepted,
rejected, and transport-failed candidates; an invalid collection cannot
multiply its allowance by failing late.
Symbolic links, gitlinks, unsafe or cross-platform-colliding paths, oversized
packages, malformed YAML anywhere in bounded frontmatter, non-string portable
identity fields, and directory/name mismatches are rejected before installation.

A reviewed installed record pins repository, requested ref and branch/tag
namespace, exact source path,
resolved commit, file hashes, sizes, and executable bits. All package files—not
only `SKILL.md`—belong to its immutable snapshot. Executable files are disclosed
in review and preserved for provider compatibility, but Agent Code never runs
repository content during discovery or installation. Provider-specific and
unrecognized metadata remains byte-for-byte intact and is surfaced as a warning.

Update checks are explicit network actions. They reacquire the same repository,
ref, source path, and skill name and return a deterministic added/changed/removed
file review. Nothing changes until the user applies that staged review. There
are no background checks or automatic updates, and source-managed packages are
view-only rather than editable as Custom Skills.

## Provider choices

Installed and custom records may carry `providers` (#1161). When it is absent,
the skill goes to every provider, so existing documents need no migration.

- **Roots, not providers.** A record selects every current root shared with a
  chosen provider. Roots are physical and shared: OpenCode reads both, and Codex
  and Pi share `~/.agents/skills`. So "Claude only" is still visible to
  OpenCode, and Settings shows that as "shared".
- **Changing the choice** is one durable intent:
  - newly chosen roots are preflighted, so a collision changes nothing;
  - reconciliation journals syncs for chosen roots and deletes for deselected
    ones, through the same write-ahead journal as every other change.
- **Health** is judged over chosen roots only.

## Skills other tools installed

`src/main/agentSkills/externalSkills.ts` lists skills in the current personal
roots that are not Agent Code materializations. These are installed by
`npx skills`, Codex's `$skill-installer`, or by hand.

- **Scanning.** Each root is scanned separately, so an `npx skills` symlink
  shows in every root it is visible from.
- **Provenance.** It is read from `~/.agents/.skill-lock.json`, which Agent Code
  **never writes**. A lock entry would let `npx skills update` rewrite
  journal-owned files.
- **Actions.** These skills can be revealed (the path is re-derived in main from
  a root id and one folder name) or hidden (a per-viewer setting). They are
  never adopted: an unmanaged destination has no ownership record. "Manage with
  Agent Code" means removing the folder and reinstalling through the review.

## Agent proposals

The off-by-default `skills` built-in MCP domain gives agents four tools:
`skills_list`, `skills_find`, `skills_add` and `skills_remove`. They drive the
same service methods as Settings.

- **`skills_add`** saves records disabled with
  `pendingReview: { by: 'agent', sessionId, requestedAt }`. Nothing reaches a
  provider root.
- **Enabling is the user's.** The user enabling the skill is the review, and
  clears the marker. Persistence rejects an enabled record that still carries
  one.
- **`skills_remove`** only withdraws unreviewed proposals.
- **Orchestration children** cannot be handed the domain by a parent that lacks
  it.

## Ownership and crash recovery

The state file records the path and hash for every successful single-file
materialization. Installed packages record the same evidence as a sorted
per-target file manifest plus snapshot digest; package-level pending operations
carry the previous and desired manifests so partial multi-file publication can
be reconciled without claiming an unexpected sibling file.
It deliberately records no leaf-directory ownership: portable APIs cannot make
fixed-name directory creation atomic with app-state persistence, so any such
claim could transfer to a concurrent or replacement directory. Before changing
a provider file, the service durably records a pending operation containing its
path, previous hash, desired hash, and any fingerprint-bound overwrite approval.
This write-ahead record is the only evidence that permits generated bytes to be
adopted after a crash.

Mutations are serialized. Enable/save preflights every target before changing
desired state, so a known collision cannot produce an avoidable partial install.
After preflight, desired state plus pending operations are persisted first;
provider writes may then fail independently and surface as degraded health.
Reconciliation can finish journaled work on boot, Settings refresh, mutations,
and immediately before Agent Code starts a provider session.

Missing, malformed, newer-schema, and unsafe-path state are different cases.
Only a missing file becomes an empty default. Other failures preserve the file
and enter Recovery required until the user reveals or explicitly resets it.

## Collision and removal policy

Provider reads are bounded and reject symlinks, FIFOs, sockets, devices, and
non-regular files. Existing unmanaged Conventions files are never overwritten
without a target-specific approval tied to the exact observed filesystem
version. Custom skills intentionally offer no overwrite path: a freely chosen
name cannot grant Agent Code ownership of an external installation. GitHub-
installed packages follow the same no-overwrite rule and additionally treat
every unexpected sibling file or executable-mode change as external. Main
rechecks every approved Conventions fingerprint under the mutation lock and the
atomic writer checks the version again immediately before publication.

Disable persists `enabled: false` and pending deletes before touching provider
files. Removal first renames the target into an operation-derived quarantine,
then unlinks only the captured regular file whose hash still matches; an
unverified replacement is restored with an atomic no-clobber link. It never
removes the leaf directory. Portable filesystem APIs cannot atomically create a
fixed-name directory and durably record who won that mkdir race, so retaining a
harmless empty directory is safer than inventing deletion authority. Externally
modified files remain conflicts. Any filesystem error leaves the installed
record, materialization, and pending operation intact; removal cannot report
success until every owned file is gone or the user explicitly abandons a
fingerprint-reviewed conflict.

Historical paths are preservation evidence, not mutation authority. If a
provider root such as `CLAUDE_CONFIG_DIR` moves, Agent Code installs the current
target and reports the old copy as Retired for manual cleanup or explicit
state abandonment. It does not read, reveal, overwrite, or delete a path merely
because app state names a known provider id; automatic filesystem mutation is
limited to records whose stable target id and exact path both match the current
registry target. A path becoming current under a different provider id does not
transfer authority from a retired record.

Clear is two-phase. Modified remnants keep the canonical body until the user
repairs them or explicitly chooses “Leave external file and clear.” Abandonment
forgets ownership after rechecking the fingerprint; it never deletes the
external bytes.

## Lifecycle and privacy boundary

Agent Code reconciles before sessions it launches. It cannot gate a CLI started
in another terminal, and existing sessions may require restart depending on the
provider. No filesystem watcher or automatic running-session reload exists in
v1 of the Custom or Installed Skills UI.

The Markdown is plaintext and may be sent to a model provider when the skill is
activated. Agent Code does not intentionally serialize it or content-derived
hashes into logs, incidents, journals, prompts, or transcripts. Like any local
plaintext processed by an application, it can still exist in ordinary process
memory and local crash/heap captures.

## Warning

Never replace the pending-operation journal with marker-based ownership. Never
write `~/.agents/.skill-lock.json` or adopt an external skill folder. Never
use recursive deletion (snapshot cleanup is content-proven and non-recursive;
keep it that way), delete a directory Agent Code did not create, accept an
arbitrary renderer path, follow a provider symlink, log user content, or add a
provider-name branch to the service. Provider discovery belongs in the
exhaustive registry; ownership and materialization must remain one central
state machine.
