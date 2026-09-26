# Bulk provider switch: stop after the current agent (#1271)

## Evidence
- `BulkProviderSwitchModal` locks every exit while a batch runs (`locked`: Escape, outside click, Esc button and Cancel are all disabled), and its DialogContent carries the app owner marker, so no shortcut or menu command reaches the app.
- `switchAgentsToProvider` switches one agent at a time. With compaction, each agent can wait up to `COMPACTION_TIMEOUT_MS = 300_000` (compactBeforeSwitch.ts), so N agents can hold the whole app for N × 5 min, and reload is the only exit.
- The lock itself is deliberate (single-flight: closing mid-loop would let a second batch start). What's missing is a way to end the batch.

## Change
- `switchAgentsToProvider` takes an optional `shouldStop()`, checked before each agent. Agents after the stop are not attempted, and the summary says how many.
- The modal keeps its single-flight lock. While a batch runs, Cancel becomes "Stop after this agent" (and Escape requests the same); the label then reads "Stopping after this agent…".
- The agent already switching finishes, because interrupting a replaceSession mid-flight could strand it. The worst-case lock drops from N × 5 min to one agent.

## Not in scope
The /model fan-out (`runModelSwitch`) shares the lock but is bounded by delivery timeouts (28 s per agent). Releasing app input while a batch runs is a UX decision for the owner.

## Tests
- Action: a stop requested after the first agent leaves the rest unattempted, and the summary names them. Red on main.
- Modal: while switching, Cancel is enabled, labelled "Stop after this agent", and stops the batch.
