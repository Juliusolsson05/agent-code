import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "settings",
    "title": "Settings, appearance and view behavior",
    "purpose": "Configure appearance, workspace behavior, agent defaults, safety and input preferences. Settings → Agents → External operator MCP enables an app-managed global Codex connection and operator skill, disabled by default.",
    "ui": "Settings panel and its categories.",
    "prerequisites": "The relevant setting and its scope/apply/storage metadata.",
    "workflow": [
      "Find the setting",
      "read its scope and effect",
      "change it",
      "verify current state."
    ],
    "outcome": "The setting takes effect according to its documented apply policy.",
    "cautions": "External setup updates the Codex config and Codex-only skill, preserving unrelated files; edited/unmanaged conflicts need attention. Restart the external client after setup or key rotation. Internal agents exclude both the operator MCP and skill. settings.values/set exposes ordinary toggle/select choices with revisions; credentials, managed files and dangerous reload controls retain their UI flows. Some settings affect new sessions; others can reload live sessions. Command visibility is presentation rather than permission.",
    "commandIds": []
  },
  {
    "id": "managed-instructions",
    "title": "Conventions and custom/installed skills",
    "purpose": "Manage shared coding instructions and reusable provider skills with deployment health.",
    "ui": "Agent settings: conventions, custom skills and installed skills.",
    "prerequisites": "Supported provider targets and writable managed instruction locations.",
    "workflow": [
      "Review the instructions or pinned skill source",
      "save/install through the app",
      "inspect deployment status."
    ],
    "outcome": "Managed instructions are deployed to their supported targets.",
    "cautions": "Skills are instructions, not MCP connections. Managed ownership must not overwrite unrelated user files.",
    "commandIds": []
  }
] satisfies FeatureReference[]
