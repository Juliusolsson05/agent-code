import { sessionApi } from '@preload/api/session.js'
import { providerApi } from '@preload/api/provider.js'
import { sessionsApi } from '@preload/api/sessions.js'
import { lspApi } from '@preload/api/lsp.js'
import { workspaceApi } from '@preload/api/workspace.js'
import { fsApi } from '@preload/api/fs.js'
import { debugApi } from '@preload/api/debug.js'
import { systemApi } from '@preload/api/system.js'
import { gitApi } from '@preload/api/git.js'
import { ghostApi } from '@preload/api/ghost.js'
import { performanceApi } from '@preload/api/performance.js'
import { setupApi } from '@preload/api/setup.js'

// Composed preload API surface.
//
// Every method from every domain module gets flattened onto a single
// `api` object — `window.api.spawnSession(...)`, not
// `window.api.session.spawn(...)`. The flat surface matches every
// existing call site in the renderer and is the shape captured by
// `Api = typeof api` in ../index.ts, which in turn drives the global
// `window.api` augmentation in ../index.d.ts.
//
// Method-name uniqueness across domains is enforced by the spread
// merge: TypeScript would error on a collision. Today there are
// none — domain modules use different name prefixes (`session*`,
// `workspace*`, `lsp*`, etc.) and the registry in main/ipc/ mirrors
// the split one-to-one.

export const api = {
  ...sessionApi,
  ...providerApi,
  ...sessionsApi,
  ...lspApi,
  ...workspaceApi,
  ...fsApi,
  ...debugApi,
  ...systemApi,
  ...gitApi,
  ...ghostApi,
  ...performanceApi,
  ...setupApi,
}

export type Api = typeof api
