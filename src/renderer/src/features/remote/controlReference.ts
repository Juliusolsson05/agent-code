import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "remote",
    "title": "Remote access and pairing",
    "purpose": "Connect the companion remote interface to the desktop workspace.",
    "ui": "Remote Control panel.",
    "prerequisites": "Remote connectivity and the app pairing/authentication flow.",
    "workflow": [
      "Open the panel",
      "establish the intended connection",
      "inspect status",
      "revoke when appropriate."
    ],
    "outcome": "The authorized remote client can access its supported surface.",
    "cautions": "Remote access is distinct from the external MCP connection and from internal agent MCP tools.",
    "commandIds": [
      "toggle-remote-panel"
    ]
  }
] satisfies FeatureReference[]
