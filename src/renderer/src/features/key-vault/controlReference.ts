import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "key-vault",
    "title": "API Key Vault",
    "purpose": "Store provider API keys encrypted at rest and insert them into any focused pane without re-copying from provider dashboards.",
    "ui": "Command palette: API Key Vault modal (provider/key management, reveal, copy, insert).",
    "prerequisites": "macOS keyring (safeStorage) available; Touch ID / login password for the once-per-launch unlock.",
    "workflow": [
      "Create a provider (e.g. Brave)",
      "add named keys with optional notes",
      "insert into the focused pane, copy to clipboard, or reference from a template ({{key:Provider/Key}})"
    ],
    "outcome": "The selected key's value is delivered to the focused composer or terminal pane without submitting, or placed on the clipboard.",
    "cautions": "Secrets are safeStorage-encrypted per key at rest in the vault and the modal keeps revealed values only in ephemeral component state. Reveal/copy/resolve cross a once-per-app-launch OS auth gate and fail closed on cancel. Template references resolve by provider/key NAME; renaming breaks references loudly. An INSERTED key leaves the vault's protection by design: composer drafts autosave to workspace.json in plaintext until sent or cleared, PTY pastes land in scrollback, and submitting puts the key in the provider transcript like any manual paste. Insertion into terminals is a bracketed paste WITHOUT Enter — review before submitting.",
    "commandIds": [
      "api-key-vault"
    ]
  }
] satisfies FeatureReference[]
