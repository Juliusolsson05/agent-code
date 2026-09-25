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

### v2 shapes named by the issue (steering q16), on the real v2 workspace

| Damage | Result on main |
|---|---|
| a `null` entry in `tabs` | throws `Cannot read properties of null (reading 'id')` |
| `buried = {}` | throws `object is not iterable` |
| a `null` entry in `buried` | handled |
| `sessions` missing | throws `Cannot convert undefined or null to object`; `useBootstrap`'s telemetry `Object.keys(parsed.workspace.sessions)` throws first for v3 too |

## Design
Lanes and rows hold layout only; sessions live in the pool. So these are repaired per entry, as `normalizeGridShape`'s documented repair-not-reject contract already says. They are not rejected the way rule 8 rejects a malformed `projects`/`tabs` container, whose loss would destroy data on the next autosave.
- **A non-object lane:** becomes an empty slot, which keeps every other lane's index, weight and focus meaning.
- **A non-object row:** is dropped, and `repairRowLengths` absorbs the lane count it carried.
- **A non-array `lanes`:** takes the seeded default stage, like a file with no stage.
- **`normalizeStage`'s "already current" check:** now compares `lanes` identity too, or the repaired array would be discarded for the original.
- **Reporting:** each repair logs a `console.warn` with the count.

- **v2 entries vs containers.**
  - A `null` or id-less tab ENTRY holds nothing and is dropped, like a null project.
  - A present-but-malformed `buried` or `sessions` CONTAINER joins rule 8's typed `MalformedWorkspaceContainerError`: buried records carry their own `sessionMeta`, and `sessions` is the pool, so either may hold the only copy of an agent. Migrating it to empty would let the next autosave erase that copy.
  - An ABSENT `sessions` holds nothing and migrates as an empty pool, in v2 as it already did in v3. The bootstrap telemetry line gets `?? {}`.

## Tests
Real-workspace cases for every row of both tables, red on main, each guard mutation-checked, plus two end-to-end bootstrap cases (a null lane, missing sessions) asserting a restore with autosave unlocked, not the locked recovery shell.
