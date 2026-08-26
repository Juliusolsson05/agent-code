# Agent-authored Personal Skill Management

> Status: planned.

## Goal

Add a dedicated **Custom Skills** setting where users can create, edit, enable,
disable, preview, and safely remove portable personal Agent Skills authored
inside Agent Code.

Keep **Agent Code Conventions** as its own encouraged Settings experience. It is
still a native personal skill at the provider boundary, but it retains its
opinionated starter, copy, and editor rather than becoming an ordinary row in
the custom-skill list.

The two Settings surfaces must share one provider-discovery, ownership,
publication, crash-recovery, and reconciliation authority. A generated path
must never acquire two competing writers merely because the product exposes two
entry points.

This work also fixes #640: the existing Conventions setting is machine-wide and
conservatively applies to new sessions, not project-scoped and immediate.

## Product boundary

### Managed by Agent Code

The Custom Skills screen lists only skills whose canonical source was created
inside Agent Code. For v1 each custom skill contains:

- an immutable portable name;
- a description that explains what the skill does and when it applies;
- a Markdown instruction body;
- an independent enabled state;
- per-target deployment health.

Enabled skills are materialized into every supported provider personal-skill
root. Disabled drafts remain only in app-owned state.

### Explicitly outside this feature

Agent Code does not enumerate, import, adopt, edit, enable, disable, or delete:

- personal skills installed by another application or directly on disk;
- repository or directory-local skills;
- plugin, admin, system, or organization-managed skills;
- supporting scripts, references, assets, or provider-specific metadata.

The service may inspect only the exact personal destination it is about to
publish. An existing unmanaged destination is a collision, not an import
candidate. V1 refuses that name instead of offering replacement.

Project skills remain entirely provider-owned even when they share a name with
an Agent Code-managed personal skill. Provider precedence remains authoritative
and Agent Code does not scan repositories to predict it.

## UX

Settings > Agents exposes two distinct rows:

1. **Agent Code Conventions** — encouraged personal development standards, with
   its existing toggle, starter, editor, and deployment status.
2. **Custom Skills** — a summary such as “3 skills · 2 active” and a
   **Manage custom skills…** action.

The custom manager presents only Agent Code-authored custom skills. It supports:

- create;
- edit description and instructions;
- preview the exact generated `SKILL.md`;
- enable or disable one skill;
- reveal generated target copies;
- delete after safe artifact removal;
- explicit “leave external file and forget ownership” recovery only when an
  originally managed copy was modified outside Agent Code.

Names are immutable in v1. A rename is a crash-safe multi-target move with
collision semantics, not a text-field update; deferring it prevents a shallow
implementation from silently leaving two skill identities behind.

There is no global Custom Skills toggle. Each skill owns its enabled state.

## Portable skill contract

Agent Code owns frontmatter serialization. The editor accepts structured name
and description fields plus Markdown instructions; it never accepts raw YAML.

Names must match:

```text
^[a-z0-9]+(-[a-z0-9]+)*$
```

and be at most 64 characters. Descriptions are non-empty and at most 1,024
characters. Instruction bodies are newline-normalized, reject NUL bytes, and
remain bounded. The parent directory and frontmatter name always match.

Generated custom skills use only the portable Agent Skills fields `name` and
`description`. Provider-specific invocation controls, tool permissions, and UI
metadata are deliberately absent because their semantics differ across Claude
Code, Codex, and OpenCode.

The generated file contains an Agent Code management marker for diagnosis, but
the marker is never ownership proof. App-owned state plus exact path and hash
remain the only mutation authority.

The reserved name `agent-code-conventions` cannot be created as a custom skill.

## Architecture

### One managed-skill authority

Generalize the Conventions subsystem into one main-process managed-personal-
skills authority. The service owns a collection containing:

- the reserved Conventions record and its specialized renderer;
- zero or more custom records and the portable renderer;
- all materialization and pending-operation records;
- serialized mutations and reconciliation.

The existing Conventions IPC remains an opinionated typed facade over the
reserved record. New Custom Skills IPC exposes collection operations. Renderer
code never receives mutation-capable paths and never writes files.

WHY keep one authority: both settings publish into the same provider roots.
Separate state machines could disagree about a name, collision, historical
path, or pending delete. Centralizing the collection preserves the existing
design invariant that exactly one component decides whether bytes are owned.

### Persisted state and migration

Introduce a versioned collection document with a global compare-and-swap
revision, skill definitions, materializations, and pending operations.
Materialization identity includes both stable skill id and provider target id;
provider target id alone cannot represent multiple skills.

Migrate schema-v1 Conventions state into a reserved Conventions record while
preserving:

- the Markdown body and enabled state;
- revision and update time;
- exact materialization paths and hashes;
- crash-left pending operations;
- malformed/newer/unsafe state recovery behavior.

Retain the existing app-owned state path during v2 so migration does not create
two canonical files. The filename is legacy storage detail, not product API.

### Provider target resolution

Separate physical personal-skill roots from skill-specific destinations:

```text
provider capability -> deduplicated physical root -> <skill-name>/SKILL.md
```

Claude/OpenCode overlap remains one physical write with both providers shown in
health. Provider modules declare discovery locations only; no provider-name
branch enters the service.

### Ownership and reconciliation

Preserve the current safety guarantees for every skill:

- preflight every physical target before desired state changes;
- persist write-ahead operations before external mutation;
- use bounded regular-file reads and reject symlinks/non-regular objects;
- bind collision and abandonment decisions to exact fingerprints;
- atomically publish generated bytes;
- adopt crash-left bytes only with matching journal proof;
- delete only captured regular files whose hashes still match;
- never recursively delete or claim ownership of a leaf directory;
- retain moved-root artifacts as retired preservation evidence;
- reconcile at startup, audit/refresh, mutations, and before provider spawn.

One conflicted custom skill must not prevent unrelated skills from reconciling.
Recovery-required app state remains a collection-wide mutation stop because the
service cannot safely infer which persisted ownership records are trustworthy.

## Shared contracts

Add collection types for:

- custom skill summary and editable document;
- per-skill health and per-target status;
- create/update/enable/disable/delete requests;
- revision, validation, name-collision, target-conflict, clear-blocked,
  unsupported, recovery-required, and I/O results;
- exact generated preview.

Keep Conventions contracts stable where practical so the existing Settings row
does not become coupled to custom-skill UI state.

## Implementation sequence

1. Add the v2 managed-skill document and pure v1-to-v2 migration.
2. Generalize rendering, target construction, path validation, ownership keys,
   and operation-derived temporary paths around a managed skill identity.
3. Adapt the existing Conventions service behavior to the reserved record and
   retain its typed facade.
4. Add serialized custom-skill CRUD, per-skill reconciliation, preview, reveal,
   collision refusal, and safe abandonment.
5. Reconcile the shared service once before starting any provider session.
6. Add typed IPC and preload APIs for the custom collection.
7. Add the separate Settings registry row and custom manager/editor UI.
8. Correct Conventions Settings metadata and rationale for #640.
9. Add focused unit, system, renderer, migration, and registry tests.

## Meaningful verification

Tests should protect behavior and ownership boundaries rather than mirror the
implementation. Required scenarios are:

- a valid instruction-only custom skill renders deterministic portable bytes;
- invalid names, descriptions, empty enabled bodies, NULs, and oversized bodies
  are rejected;
- a disabled draft writes no provider artifact;
- enabling two skills materializes both across deduplicated physical roots;
- a pre-existing unmanaged destination blocks creation/enable without overwrite;
- editing one skill does not rewrite or degrade another;
- disabling/deleting removes only hash-proven owned files;
- an externally modified managed copy is preserved and blocks deletion until
  exact-fingerprint abandonment;
- crash-left writes/deletes reconcile without broadening ownership;
- moved provider roots preserve retired copies and install current copies;
- schema-v1 Conventions state migrates without losing content or ownership;
- malformed or unsafe state remains recovery-required;
- Conventions remains a distinct Settings control while Custom Skills opens its
  own manager;
- Settings metadata reports Conventions as app-wide/new-session behavior;
- pre-session reconciliation covers both Conventions and custom skills.

Run focused suites during development, then the repository typecheck, relevant
unit/system/renderer projects, the complete quality command, and distributable
output verification. Any unrelated baseline failure must be reproduced on
unmodified `main` and documented rather than hidden.

## PR and Issue synchronization

The implementation PR title should describe the delivered custom-skill manager
using Conventional Commit form, not this plan filename. Its body must use
`Fixes #640`, report concrete verification results, and keep limitations such as
instruction-only skills and immutable names explicit.

Opening and reviewing the PR does not authorize merging it. After review
feedback is resolved and current CI is green, report the final state and wait
for explicit user confirmation.
