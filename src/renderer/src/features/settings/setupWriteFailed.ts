// What a failed setup-state write says, wherever the renderer writes main's
// `setup.json` (#1250 rows 6 and 13, #1403 review b).
//
// WHY fixed text: the IPC error of a failed write can carry a filesystem path,
// and user-visible text is curated (q22). "Nothing was changed" is true
// because main applies each save to the last state known to be on disk and
// drops a save whose write failed (`updateSetupState`): neither main's state
// nor a later save carries it. Main rejects only when the write itself
// failed; a refresh that fails after a landed write resolves instead
// (`providerEnablement.mutate`).
export const SETUP_WRITE_FAILED = "Couldn't save this change. Nothing was changed."

// The setup panel's answer (skip an optional tool, continue with no provider)
// closes the panel whatever happens (#1047: a panel that cannot be answered is
// a lockout), so its failure is said after the close, as a toast.
export const SETUP_ANSWER_NOT_SAVED = "Couldn't save your setup answer. Setup may ask again next launch."

// The prerequisite check failed (an IPC error, a probe that could not run).
// Its raw error can name paths from the login shell.
export const SETUP_CHECK_FAILED = "Couldn't check which tools are installed."
