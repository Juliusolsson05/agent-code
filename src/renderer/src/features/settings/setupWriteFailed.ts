// What a failed setup-state write says, wherever a settings row writes
// main's `setup.json` (#1250 rows 6 and 13).
//
// WHY fixed text: the IPC error of a failed write can carry a filesystem path,
// and user-visible text is curated (q22). "Nothing was changed" is true
// because main restores its in-memory state when the write fails
// (`saveSetupState`), and these rows render main's snapshot, which therefore
// still holds the old value.
export const SETUP_WRITE_FAILED = "Couldn't save this change. Nothing was changed."
