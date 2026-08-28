# GitHub Skill Installation

> Status: implemented; two-agent PR review feedback is incorporated and the remediation is locally verified for issue #664.

## Goal

Add a separate **Installed Skills** setting where a user can discover and
install portable Agent Skills from a public GitHub repository or directory
URL. Imported skills retain immutable source provenance, are reviewed before
installation or update, and materialize through the same collision-safe
personal-skill authority as Agent Code Conventions and Custom Skills.

This is source management, not another authoring surface. A GitHub-installed
package remains upstream-owned and cannot be edited as though Agent Code wrote
it. Existing provider, project, plugin, admin, and organization skills remain
outside Agent Code ownership.

## Product behavior

Settings > Agents gains a third distinct row:

1. **Agent Code Conventions** — the encouraged personal standards skill.
2. **Custom Skills** — instruction-only skills authored in Agent Code.
3. **Installed Skills** — reviewed package snapshots imported from GitHub.

The Installed Skills manager supports:

- entering a public `https://github.com/<owner>/<repo>` URL or a GitHub
  `/tree/<ref>/<path>` URL;
- discovering one skill at the requested directory or multiple descendant
  skills in a collection repository;
- reviewing name, description, source path, resolved commit, files, byte size,
  executable files, and compatibility warnings before confirmation;
- selecting one or more discovered skills for installation;
- enabling, disabling, revealing, and safely removing each installed skill;
- checking one installed skill for upstream changes;
- reviewing added, changed, and removed files before explicitly applying an
  update.

Discovery, update checks, and previews never execute repository content.
Installed skills are enabled on confirmation because the installation review
is the explicit activation decision. Provider discovery may require a new
agent session, matching the existing managed-skill lifecycle.

## Source and trust boundary

V1 accepts public GitHub HTTPS URLs only. Private repository authentication,
arbitrary Git remotes, plugin installation, and unattended updates are
deliberate non-goals.

Main uses a hardened `git ls-remote` without a shell to resolve advertised
branch/tag identity, but never clones repository content. The Git subprocess
receives an OS-variable allowlist rather than ambient Git, credential, proxy,
or TLS controls. The resolved commit's recursive tree and only selected raw
blobs are fetched from allowlisted GitHub HTTPS endpoints through hard streaming
memory limits. Every blob must match the Git object ID advertised by the exact
commit tree. Repository-controlled bytes therefore cannot enter temporary Git
packfiles or a working tree before the user has reviewed a bounded package. A
single fatal discovery-wide package-content budget reserves tree-advertised
blob sizes before transport and includes candidates later rejected by
validation or transport, so hostile collections cannot multiply their transfer
allowance through skippable failures.

GitHub `/tree/` URLs are resolved against advertised heads and tags, choosing
the longest matching ref so branch names containing slashes remain
unambiguous. Same-name branch/tag URLs are rejected, and the canonical source
record stores the ref namespace so an update cannot silently switch from a tag
to a later branch. The canonical source record stores:

- repository owner and name;
- requested ref, including the resolved default branch when none was supplied;
- skill-relative source directory;
- resolved 40-character commit;
- canonical repository and skill URLs.

Discovery rejects symbolic links, gitlinks/submodules, unsafe or
cross-filesystem-colliding paths, malformed
or oversized `SKILL.md` frontmatter, duplicate skill names, excessive file
counts, excessive individual files, and excessive total package bytes. It
returns explicit warnings for executable modes and provider-specific metadata.
Staged previews are opaque, bounded, short-lived main-process records; the
renderer receives metadata and an unguessable discovery id, never mutation
authority or raw local paths.

## Portable package contract

A candidate is a directory containing `SKILL.md`. If the requested directory
itself contains `SKILL.md`, it is the single candidate. Otherwise every safe
descendant `SKILL.md` identifies one candidate package.

Frontmatter must contain portable `name` and `description` string fields and
the directory name must equal `name`. Other frontmatter is retained byte-for-
byte, but the complete bounded YAML document is parsed so malformed nested
provider metadata cannot be approved as active. Other fields are reported when
provider-specific or experimental. Every regular
file below the candidate directory belongs to the immutable package snapshot.

Package limits are product constants shared by acquisition, persistence, IPC,
and tests. Binary assets are supported. Executable files are never run by
Agent Code; their presence is prominent in confirmation and their executable
bit is preserved because provider runtimes may intentionally invoke them after
the user installs the skill.

## Canonical state and migration

Upgrade the shared managed-skill document from schema v2 to v3. Pure migrations
from v1 and v2 retain all Conventions/custom-skill desired state, ownership
records, and pending operations unchanged.

V3 adds separate maps for:

- GitHub-installed skill records;
- per-target installed-package materializations;
- package-level pending operations.

An installed record includes source provenance, enabled state, immutable
snapshot digest, a sorted file manifest containing relative path, size, SHA-256,
and executable bit, plus created and updated timestamps. Custom and installed
names share one namespace and cannot claim `agent-code-conventions`.

Package bytes live outside the JSON document under a private app-owned,
content-addressed snapshot root. Main writes a complete snapshot into a random
private staging directory, validates every file, and renames it to a directory
derived from the package digest before state can reference it. A crash may
leave an unreferenced immutable snapshot, but can never leave state pointing at
partial bytes. Reconciliation verifies stored bytes against the persisted
manifest before using them. Unreferenced snapshots are deliberately retained:
portable Node APIs cannot recursively delete relative to a securely opened
root handle, so automatic GC could be redirected into unmanaged data by an
ancestor replacement race. The entire root, including failed staging remnants,
is capped at 256 MiB and 32,768 filesystem entries before another package is
admitted, so safe retention cannot grow without bound.

## One managed-skill authority

`AgentCodeManagedSkillsService` remains the only production writer for every
provider personal-skill root. Installed-skill acquisition and package I/O live
in focused single-consumer helpers, but all desired-state mutations and target
reconciliation run through the service's existing serialization queue and
shared revision.

Installed packages use the provider registry's existing deduplicated physical
targets. They do not branch on provider names. A package collision is checked
against both canonical managed names and the exact destination directory. An
unmanaged destination, unexpected file, symlink, non-regular object, or
externally changed managed file is preserved and reported; imported skills
never offer an overwrite button.

## Package ownership and recovery

Single-file Conventions/custom ownership records remain unchanged. Installed
packages add a package manifest per physical target rather than pretending the
`SKILL.md` hash owns sibling files.

Before a provider package changes, state durably records a pending package
operation containing the previous owned manifest, desired snapshot digest,
desired manifest, target id, exact destination, and operation id. Reconciliation
then handles every relative file independently:

- a desired file already matching its desired hash is adopted only when the
  pending journal or prior materialization proves ownership;
- a prior owned file may be replaced only while its current version and hash
  still match the prior manifest;
- a newly desired file uses no-clobber publication;
- a removed or disabled file is quarantined and unlinked only while its hash
  still matches the prior manifest;
- an external change stops that target and is never overwritten or deleted;
- partial writes remain journaled and resume on audit, startup, mutation, or
  pre-session reconciliation.

The materializer never recursively deletes provider skill directories. Empty
directories may remain after disable/removal because fixed-name directory
creation does not confer portable deletion ownership.

Provider-root movement rehomes current package records using stable target id
plus exact path. Historical copies become retired preservation evidence and
are surfaced for manual handling rather than mutated under stale authority.

## Update model

**Check for updates** reacquires the stored repository and requested ref, then
selects the candidate at the exact stored source directory. Renames are not
silently followed because source path plus package name is part of the reviewed
identity.

If the commit and package digest are unchanged, Settings reports up to date.
Otherwise main returns an opaque staged update containing the new provenance,
manifest, warnings, and a deterministic added/changed/removed file summary.
Only **Apply reviewed update** changes canonical desired state. Updating uses
the same write-ahead package reconciliation as initial installation. There is
no timer, startup network call, or automatic update policy in v1.

## IPC and Settings integration

Add typed Installed Skills contracts and a dedicated IPC/preload facade for:

- snapshot and audit;
- GitHub discovery;
- confirmed installation from a staged discovery;
- enable/disable;
- update check and confirmed staged update;
- reveal target/source snapshot;
- safe removal and recovery actions.

IPC parses every unknown renderer value. Source URLs, ids, selected candidates,
revision tokens, and conflict approvals are bounded before reaching the
service. The renderer announces accepted mutations through the existing
managed-skills revision event so all three Settings rows stay synchronized.

The Settings manager uses explicit review steps instead of a single URL field:

```text
Repository URL -> Discover -> Select and review -> Install selected skills
```

Installed rows show provenance, pinned commit, update state, deployment health,
and target details. Imported package contents are view-only; users can reveal
the immutable source snapshot or provider copy for inspection.

## Implementation sequence

1. Add typed installed-skill contracts, schema-v3 records, and v1/v2 migration.
2. Add pure GitHub URL/ref parsing plus bounded GitHub tree/blob discovery.
3. Add immutable package snapshot storage and manifest verification.
4. Add package path safety, ownership policy, write-ahead materialization, and
   reconciliation inside the shared managed-skills authority.
5. Add install, enable/disable, update-review, update-apply, reveal, and remove
   service operations.
6. Add validated IPC and preload APIs.
7. Add the Installed Skills Settings registry row, discovery/review manager,
   source/update details, and target health UI.
8. Keep README and the managed-skills design note synchronized with the shipped
   product boundary.

## Meaningful verification

Tests protect behavior and security boundaries rather than implementation
shape:

- GitHub root and directory URLs normalize correctly, including slash refs;
- unsupported hosts, credentials, malformed URLs, and ambiguous refs fail
  without launching acquisition;
- streamed GitHub responses stop at their hard memory boundary and raw bytes
  must match the reviewed commit tree;
- rejected and transport-failed candidates consume the same fatal acquisition
  budget as accepted candidates;
- discovery finds a single package and multi-skill repositories;
- invalid frontmatter, directory/name mismatch, duplicate names, symlinks,
  gitlinks, traversal paths, file/directory portability collisions, and package
  limits are rejected;
- executable and provider-specific content is visible before confirmation;
- confirmed installation pins the resolved commit and exact manifest;
- staged discovery ids expire and cannot be reused after mutation;
- custom, installed, reserved, and unmanaged destination collisions are
  refused without overwrite;
- multiple files, binary assets, nested directories, and executable modes
  materialize across deduplicated provider roots;
- partial publication resumes from its durable package journal;
- external edits are preserved during update, disable, and removal;
- failed removal retains the skill, materialization, and pending operation so a
  later retry still has deletion authority;
- retained and failed-staging snapshots cannot exceed the aggregate private
  storage boundary;
- update review reports deterministic file changes and applying it updates
  provenance only after confirmation;
- schema-v1/v2 migration preserves prior managed-skill ownership;
- the Settings flow requires discovery and review before install/update and
  keeps sibling managed-skill revisions current.

Run focused unit, system, and renderer suites while developing, followed by
typecheck, the repository quality command, package-output verification, and a
final unrelated-diff review.

## Issue and PR synchronization

Issue #664 is the authoritative problem and acceptance record. The completed
PR uses a Conventional Commit title describing GitHub skill installation,
contains `Fixes #664`, reports exact verification, and records the public-only,
manual-update V1 limitations. Opening the PR does not authorize merging it.
