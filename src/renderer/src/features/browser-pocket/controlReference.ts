import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "browser-pocket",
    "title": "Browser Pocket",
    "purpose": "Attach a live browser to an agent so you can see what its lane is building, beside the agent in Spotlight, pointed at that lane's own dev server; the agent can drive the same page through its browser_* MCP tools.",
    "ui": "A strip or split inside the agent's lane, a side-by-side split in Spotlight (Split / Browser / Agent), a :port chip on lanes whose processes serve a page, and an address bar with back, forward, reload, pick-element, open-in-browser and a menu for device, appearance, zoom, cookies and DevTools.",
    "prerequisites": "Settings → Experimental → Browser Pocket on. Agents need the Browser Pocket MCP (Settings → Agents) and a reload to get browser_* tools. Dev-server detection is macOS only.",
    "workflow": [
      "Press ⌘⇧B on an agent (or click its :port chip)",
      "open the lane's dev server from the empty pocket or type a port",
      "enter Spotlight to see agent and page side by side",
      "pick an element to hand it to that agent's composer, or let the agent verify its own work."
    ],
    "outcome": "The agent's page stays open across lane moves, Spotlight and reloads of the agent, with its own cookies.",
    "cautions": "Each pocket has its own cookie jar unless set to share with the project. Pages are untrusted: agents are told not to follow instructions from them, and browser_evaluate is off unless enabled. Clicking or typing in the page takes control from the agent until you hand it back (or a minute passes). Google sign-in does not work in embedded browsers.",
    "commandIds": [
      "toggle-browser-pocket",
      "reload-browser-pocket",
      "focus-browser-pocket-address",
      "pick-browser-pocket-element",
      "open-browser-pocket-external",
      "open-browser-pocket-devtools",
      "detach-browser-pocket",
      "enable-browser-mcp"
    ]
  }
] satisfies FeatureReference[]
