import { tldrApi } from '@preload/api/tldr.js'
import { sessionApi } from '@preload/api/session.js'
import { controlApi } from '@preload/api/control.js'
import { providerApi } from '@preload/api/provider.js'
import { conversationsApi } from '@preload/api/conversations.js'
import { lspApi } from '@preload/api/lsp.js'
import { workspaceApi } from '@preload/api/workspace.js'
import { agentNamesApi } from '@preload/api/agentNames.js'
import { windowApi } from '@preload/api/window.js'
import { fsApi } from '@preload/api/fs.js'
import { debugApi } from '@preload/api/debug.js'
import { systemApi } from '@preload/api/system.js'
import { gitApi } from '@preload/api/git.js'
import { ghostApi } from '@preload/api/ghost.js'
import { performanceApi } from '@preload/api/performance.js'
import { editorFsApi } from '@preload/api/editorFs.js'
import { setupApi } from '@preload/api/setup.js'
import { dictationApi } from '@preload/api/dictation.js'
import { dictationDebugApi } from '@preload/api/dictationDebug.js'
import { pasteDebugApi } from '@preload/api/pasteDebug.js'
import { devDebugApi } from '@preload/api/devDebug.js'
import { orchestrationApi } from '@preload/api/orchestration.js'
import { agentManagementApi } from '@preload/api/agentManagement.js'
import { aiWorkspaceApi } from '@preload/api/aiWorkspace.js'
import { renderedContentApi } from '@preload/api/renderedContent.js'
import { caffeinateApi } from '@preload/api/caffeinate.js'
import { keyVaultApi } from '@preload/api/keyVault.js'
import { menuApi } from '@preload/api/menu.js'
import { incidentApi } from '@preload/api/incident.js'
import { lifecycleApi } from '@preload/api/lifecycle.js'
import { remoteApi } from '@preload/api/remote.js'
import { usageApi } from '@preload/api/usage.js'
import { cliUpdatesApi } from '@preload/api/cliUpdates.js'
import { workflowsApi } from '@preload/api/workflows.js'
import { extensionsApi } from '@preload/api/extensions.js'
import { agentCodeConventionsApi } from '@preload/api/agentCodeConventions.js'
import { agentCodeCustomSkillsApi } from '@preload/api/agentCodeCustomSkills.js'
import { agentCodeInstalledSkillsApi } from '@preload/api/agentCodeInstalledSkills.js'
import { agentSkillsApi } from '@preload/api/agentSkills.js'

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
// `workspace*`, `lsp*`, etc.).
//
// The main-side registrar is NOT a one-to-one mirror of this split,
// and was never a rule worth enforcing. Most domains do have their
// counterpart under main/ipc/, but `agentNames*` is handled by
// `src/main/agentNames/ipc.ts`, which lives beside the registry it is
// the only consumer of rather than beside the other IPC modules. That
// is the point of the decomposition: application identity stays out of
// the generic IPC layer. So when adding a domain here, follow the
// handler to wherever it actually is — do not assume main/ipc/<domain>.

export const api = {
  ...tldrApi,
  ...controlApi,
  ...sessionApi,
  ...providerApi,
  ...conversationsApi,
  ...lspApi,
  ...workspaceApi,
  ...agentNamesApi,
  ...windowApi,
  ...fsApi,
  ...debugApi,
  ...systemApi,
  ...gitApi,
  ...ghostApi,
  ...performanceApi,
  ...editorFsApi,
  ...setupApi,
  ...dictationApi,
  ...dictationDebugApi,
  ...pasteDebugApi,
  ...devDebugApi,
  ...orchestrationApi,
  ...agentManagementApi,
  ...aiWorkspaceApi,
  ...renderedContentApi,
  ...caffeinateApi,
  ...keyVaultApi,
  ...menuApi,
  ...incidentApi,
  ...lifecycleApi,
  ...remoteApi,
  ...usageApi,
  ...cliUpdatesApi,
  ...workflowsApi,
  ...extensionsApi,
  ...agentCodeConventionsApi,
  ...agentCodeCustomSkillsApi,
  ...agentCodeInstalledSkillsApi,
  ...agentSkillsApi,
}

export type Api = typeof api
