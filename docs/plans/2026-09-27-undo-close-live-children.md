# Undo Close: a restored parent's live children follow it (#1373)

## Problem
Undo Close restores a closed pane under a fresh session id. Its LIVE children (orchestration children and linked panes that stayed open) keep `orchestrationParentId` / `orchestrationRootId` / `linkedParentId` pointing at the dead id. Restore only remaps pointers inside the restored entry (`remapMetaLineage` on the carried rows) and on the undo stack (`remapSingleEntryLineage`). Replace and Reload Agents, by contrast, remap every session (`remapSessionsRelationships`).

The renderer's orchestration visibility gate compares ids for equality (`orchestrationMcp.ts`), so the restored parent cannot list, read or prompt its own surviving children. They also render as top-level rows.

## Evidence
- Found by review c of #1369 (`temp/review-1369/report-c.md`, Suspicions).
- `undoClose.ts`: the single-pane commit writes only `sessions[newSessionId]`; the project commit remaps only the carried rows.

## Decisions (defaults)
- **At both restore commits, map every live session's pointers through the restore's old→new ids with `remapMetaLineage`.**
  - WHY not `remapSessionsRelationships`: that one drops a pointer whose target is not in the record. A child of ANOTHER still-closed parent would lose its link, and a later undo of that parent could no longer relink it. `remapMetaLineage` keeps unmapped ids by design ("lineage describes one restore").
  - Rows that no pointer touches keep their object identity, because `remapMetaLineage` returns the same meta.
- Main's orchestration tombstones already follow Undo Close through `carryOrchestrationParents` (#1369). This is the live half. It lands independently: no shared code beyond the file.

## Tests (fail-first)
- Undo Close of a single pane with a live orchestration child and a live linked child: both now point at the restored id.
- Undo Close of a project whose member has a live child in ANOTHER project: that child follows too.
- A child of a different, still-closed parent keeps its pointer (not dropped).
