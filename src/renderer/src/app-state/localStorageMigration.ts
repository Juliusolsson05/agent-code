import { APP_LOCAL_STORAGE_PREFIX } from '@shared/appIdentity'

export const APP_STORE_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}:app-store`
export const PROMPT_TEMPLATES_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}.promptTemplates.v1`
// Recent-command history for command-palette ranking. Centralized here
// (mirroring .promptTemplates.v1) so the key is greppable in one place:
// it keeps the cache inspectable in devtools and trivially resettable —
// clearing this single key wipes the history without touching any other
// app state. The `.v1` suffix lets us evolve the on-disk shape later
// (bump to .v2) without colliding with stale data from an old build.
export const RECENT_COMMANDS_STORAGE_KEY = `${APP_LOCAL_STORAGE_PREFIX}.recentCommands.v1`
