// Shared by staging and runtime integrity checks. A cap applied only after copy
// or readFile has already paid the disk/memory cost it was meant to prevent.
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024
export const BUNDLE_MAX_ENTRIES = 10_000
export const BUNDLE_MAX_DEPTH = 32
