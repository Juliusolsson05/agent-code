// One connection must not pin an unbounded backlog in main. The history slice
// leaves headroom for frame/file metadata; a single larger record is an explicit
// mobile error, never silently truncated transcript content.
export const REMOTE_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
export const REMOTE_HISTORY_MAX_BYTES = 3 * 1024 * 1024
export const REMOTE_HISTORY_TOO_LARGE = 'This history record is too large for the remote client.'
