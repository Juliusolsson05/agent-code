# One malformed stage entry must not hide every agent (#1245)

## Verified failure
I damaged the owner's real v3 workspace (`testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json`) and ran `migrateWorkspaceToStage` on it:

| Damage | Result on main |
|---|---|
| `stage.lanes[0] = null` | throws `Cannot read properties of null (reading 'selectedSessionId')` |
| `stage.rows[0] = null` | throws `Cannot read properties of null (reading 'length')` |
| `stage.lanes = 5` | throws `stage.lanes.map is not a function` |
| a `null` entry in `projects` | handled (filtered) |
| `sessions` missing | handled (empty pool; nothing to lose) |

A throw in rehydrate sends startup to the locked single-tab recovery shell (`useBootstrap.ts`), with none of the user's agents shown.

## Design
Lanes and rows hold layout only; sessions live in the pool. So these are repaired per entry, as `normalizeGridShape`'s documented repair-not-reject contract already says. They are not rejected the way rule 8 rejects a malformed `projects`/`tabs` container, whose loss would destroy data on the next autosave.
- **A non-object lane:** becomes an empty slot, which keeps every other lane's index, weight and focus meaning.
- **A non-object row:** is dropped, and `repairRowLengths` absorbs the lane count it carried.
- **A non-array `lanes`:** takes the seeded default stage, like a file with no stage.
- **`normalizeStage`'s "already current" check:** now compares `lanes` identity too, or the repaired array would be discarded for the original.
- **Reporting:** each repair logs a `console.warn` with the count.

## Tests
Real-workspace cases for the three throws, red on main, each mutation-checked.
