// Pi condition views: none. Both Pi conditions are attention-only (see
// policy.ts) — the dialog is answered in pi's own TUI, which is the pane.

import { eraseRegistry } from '@shared/conditions-core/view'

export const PI_VIEWS = eraseRegistry<Record<string, never>>({})
