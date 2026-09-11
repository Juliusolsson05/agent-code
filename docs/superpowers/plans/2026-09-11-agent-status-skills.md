# Agent Status installed skills

Status: implementation planned. Issue: #900.

## Outcome

The existing Agent Status panel lists Agent Code-managed skills and skills in
the selected provider's native/default discovery locations. Names, descriptions,
source labels, and file locations make the result useful without opening Settings.
This is an installed inventory, not a claim that the running model loaded a body.

## Design and ownership

1. Add a shared metadata-only inventory contract. Main owns filesystem discovery;
   the renderer supplies the selected provider/project context over typed IPC.
2. Keep provider-specific discovery rules behind the provider registry. Inspect
   personal, project, and exposed system roots; support locally configured/plugin
   roots when their native configuration provides sufficient evidence. Never
   recursively scan a whole home directory or infer enabled plugins from caches.
3. Reuse public managed-skill snapshots to attribute Agent Code deployments. Do
   not import persistence/ownership internals or introduce another writer. Skill
   bodies remain in main and do not enter diagnostics, IPC, or the status UI.
4. Bound metadata reads and directory traversal, deduplicate physical files, and
   surface incomplete discovery. Opening the panel performs no installations,
   configuration mutations, native prompts, or provider process launches.
5. Add an Installed Skills section following existing dense semantic styling.
   Fetch on target/context changes, explicit refresh, and managed-skill updates;
   fence stale responses and show loading, empty, partial/error, and shell states.
6. Update command search metadata and feature reference to mention skills.

## Validation

- Deterministic filesystem tests use isolated temporary roots, covering managed
  attribution, native/system/project roots, duplicates, symlinks, malformed or
  oversized metadata, and source failures without executing skills.
- Renderer tests cover the displayed inventory, empty/error/terminal states,
  refreshing, and switching targets while discovery is pending.
- Run focused tests, type checks, and the full deterministic `npm run check` gate.
- Review the final diff, synchronize the issue and completed PR description,
  verify CI, and await explicit merge authorization.

## Constraints

Provider discovery and activation differ. Report actual discovered files and
known exclusions; do not hard-code a supposedly complete list of bundled skills
or label a disk inventory as the running agent's loaded context. Inline WHY
comments explain each provider rule and asynchronous ownership boundary.
