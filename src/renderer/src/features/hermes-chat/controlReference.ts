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
    "ui": "Settings → Hermes connections (add a URL, sign in through the browser); a Hermes pane from the New Agent picker or the Hermes split commands. A new Hermes pane follows your Telegram DM thread when your Hermes has one; New Separate Hermes Chat opens a desktop-only conversation. Type / in the composer for Hermes' commands and skills.",
    "prerequisites": "A reachable `hermes serve` backend and a signed-in connection.",
    "workflow": [
      "Add the server URL in Settings → Hermes and sign in",
      "open a Hermes pane and type as you would in Telegram",
      "answer approval, question, sudo and secret cards inline",
      "pick a command from the / picker (/restart restarts Hermes' messaging gateway after asking)",
      "in a Telegram-thread pane, start a new conversation with /new in Telegram; in a separate chat, /new works in the pane."
    ],
    "outcome": "Messages, tool calls and answers appear as a chat; the conversation lives on your server and resumes on reload.",
    "cautions": "Messages sent from a Telegram-thread pane are part of that conversation but do not appear in the Telegram app (a Hermes limitation). A message sent while Hermes replies on Telegram is held until that reply lands (Send now overrides). Hermes runs remotely: Agent Code's built-in MCP tools, skills, provider switch, rewind and attachments are not available in Hermes panes. A prompt sent while Hermes is working waits for the current turn instead of interrupting it. Closing a pane never deletes the conversation on the server.",
    "commandIds": [
      "hermes-vertical",
      "hermes-horizontal",
      "hermes-separate-chat"
    ]
  }
] satisfies FeatureReference[]
