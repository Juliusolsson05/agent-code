/**
 * Every pocket partition starts with this. `persist:` is part of the prefix on
 * purpose: an in-memory partition would lose the dev app's login every time a
 * hidden guest is put to sleep and recreated (placement/lifecycle.ts).
 *
 * Its own module so guestGuard (which configures sessions at attach) and
 * partition (which builds names) can share it without importing each other.
 */
export const POCKET_PARTITION_PREFIX = 'persist:ac-pocket-'
