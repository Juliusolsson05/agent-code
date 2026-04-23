import { sessionApi } from './session.js'
import { providerApi } from './provider.js'
import { sessionsApi } from './sessions.js'
import { lspApi } from './lsp.js'
import { workspaceApi } from './workspace.js'
import { fsApi } from './fs.js'
import { debugApi } from './debug.js'
import { systemApi } from './system.js'
import { gitApi } from './git.js'
import { ghostApi } from './ghost.js'

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
}

export type Api = typeof api
