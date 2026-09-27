# Reloading a live child keeps its pointer to a closed, restorable parent (#1379)

## Problem
Replace (reload, provider switch, resume, rewind) and Reload Agents commit through `remapSessionsRelationships(sessions, idMap)`. Its `knownSessionIds` defaults to the live record's keys, and a pointer whose target is in neither the idMap nor that set is DROPPED. A parent that is closed but still on the undo stack is in neither. So reloading its live child erases `linkedParentId` / `orchestrationParentId` / `orchestrationRootId`, and undoing the parent later (with #1374's relink) finds nothing to relink. The two stay live and permanently unlinked. Found by review c of #1374.

## Decision
- **Both commits pass `knownSessionIds` = live ids ∪ the undo stack's restorable session ids.** `UndoCloseStack.restorableSessionIds()` collects them from session, tab and group entries, after the same expiry prune that `pop()` uses.
- **Why not "never drop":** the drop is right for a target that can never come back. A deleted pane or an expired undo entry dangling forever misleads the index and the orchestration gate. Only what undo can still restore is worth keeping.
- **An entry that later expires** leaves a pointer to an id nothing can restore. That is the same observable state as the drop (a top-level row, invisible to any parent), and it is cleaned the next time that child is remapped.

## Tests (fail-first)
- **Replace:** a live child reloaded while its parent sits on the undo stack keeps its pointers.
- **Reload Agents:** the same.
- **The control:** a pointer to a parent that is neither live nor restorable is still dropped.
- **`UndoCloseStack.restorableSessionIds`:** session, tab and group entries, and expired entries excluded.
