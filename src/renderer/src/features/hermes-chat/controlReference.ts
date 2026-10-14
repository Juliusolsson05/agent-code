import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
// One page covers both Hermes directories (hermes-chat, hermes-settings):
// a connection is only useful through the chat, and the chat cannot start
// without a connection, so a user (or an agent reading this reference) needs
// both halves in one place.
export const controlReference = [
  {
    "id": "hermes",
    "title": "Hermes chat",
    "purpose": "Chat with your own Hermes Agent, running on your server, in an agent pane beside your coding agents instead of in Telegram.",
    "ui": "Settings → Hermes connections (add a URL, sign in through the browser); a Hermes pane from the New Agent picker or the Hermes split commands.",
    "prerequisites": "A reachable `hermes serve` backend and a signed-in connection.",
    "workflow": [
      "Add the server URL in Settings → Hermes and sign in",
      "open a Hermes pane and type as you would in Telegram",
      "answer approval, question, sudo and secret cards inline",
      "use /new for a fresh conversation in the same pane."
    ],
    "outcome": "Messages, tool calls and answers appear as a chat; the conversation lives on your server and resumes on reload.",
    "cautions": "Hermes runs remotely: Agent Code's built-in MCP tools, skills, provider switch, rewind and attachments are not available in Hermes panes. A prompt sent while Hermes is working waits for the current turn instead of interrupting it. Closing a pane never deletes the conversation on the server.",
    "commandIds": [
      "hermes-vertical",
      "hermes-horizontal"
    ]
  }
] satisfies FeatureReference[]
