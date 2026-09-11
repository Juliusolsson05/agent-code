# Agent Status installed skills

Status: implemented and locally verified; PR/CI review pending. Issue: #900.

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
3. Reuse a public, metadata-only managed-skill service projection to attribute Agent Code deployments. Do
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

## Implemented scope and evidence

- The existing command and panel now show names, descriptions, source labels,
  expandable file locations, a count, refresh, and explicit discovery notices.
- Claude reads personal/project/system roots, legacy Markdown commands, and
  enabled locally registered plugins. Compiled-in bundled skills are not
  exposed by the headless interface and are explicitly identified as unavailable.
- Codex reads personal/project/admin/system roots and explicitly enabled local
  plugins when their installation is unambiguous. Cloud-managed and project
  plugin resolution remains provider-owned and is disclosed in the panel.
- OpenCode reads its default local and compatible roots, honoring the external
  skill disable flag and config directory overrides; extra/remote sources are
  disclosed as outside this inventory.
- Managed attribution uses `getInstalledSkillLocations`, which never triggers
  initialization, reconciliation, or repair. The collector alone reads disk.
- Focused system and renderer tests pass, including FIFO rejection, duplicate
  links/cycles, malformed/oversized metadata, optional Claude frontmatter,
  plugin selection, managed read-only behavior, and stale requests.
- Type checks and build/package verification pass. Full deterministic run:
  3,295 passed, one pre-existing personal-history provenance failure reproduced
  on unchanged main and separately recorded in #901. The later focused checks
  include the final FIFO and plugin coverage.
- Visually verified the actual section with production CSS in an isolated
  browser preview, including location expansion. Read-only local smoke scans
  discovered 21 Codex, 19 Claude, and 7 OpenCode skill files without errors;
  each provider returned its documented completeness notice.
