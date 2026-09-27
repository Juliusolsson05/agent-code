# Workflow run whose stored data is gone (#1348)

## Evidence
- `WorkflowBridge.getSnapshot` returns `null` only for `run-not-found` in the scope it was asked; every other failure throws.
- The renderer store turned that `null` into `phase: 'error'` ("not found in this project") with Retry. `WorkflowRunView` then fell back to the reference's launch-time status, so a `failed` reference kept **Resume**, which can only fail with `run-not-found`.
- The history dialog showed the same run as "Unknown · Status unavailable" / "Timestamp unavailable", which reads as a fault.

## Change
- A new store phase, `missing`, distinct from `error` (a failed read that proves nothing keeps Retry and the reference's actions).
- `model/missingRun.ts` names it for both surfaces. **Expired** when the reference carries its own `cwd`: it was looked up in its own project, so its stored data is gone (usually retention; a moved project folder looks the same, so the text does not claim the cause). **Unavailable** when it does not: it was looked up in the session's project, which proves only absence there.
- Run view: that label replaces the status, no Resume, no Cancel, no Retry, one line saying why. Dialog: "Inactive · Expired", with the same line in place of the timestamps.

## Not done
- No day count in the text: the windows live in workflow-mcp and differ by lineage, so a copied number would drift.
- Resume racing retention (the run removed after the view loaded) still shows the store's `run-not-found` message. That window is minutes wide against a 30-day retention, and a message match on the error text would be fragile.

## Review round 1 (a + b), fixed
- **One label.** workflow-mcp looks the manifest up GLOBALLY by run id before checking the project scope (a run in another project is `scope-forbidden`, not null), so `null` always means the run is gone from this app's store. The Expired/Unavailable split by `cwd` misdescribed that and is removed: every missing run is Expired.
- **No action while loading.** Resume and Cancel appear only once the store has answered. While loading, the header shows the reference's launch-time status, and a Resume clicked then on a run that turned out to be gone failed with run-not-found.
- **The selector agrees.** A tab labelled Active from its launch-time reference now checks, once, whether its run still exists (`useMissingRunIds`: only tabs that claim to be active, at most three). A missing run's tab is Inactive · Expired. A failed read changes nothing.

