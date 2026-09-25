import { useAppStore } from '@renderer/app-state/hooks'
import { browserPocketEnablePatch } from '../setup'
import type { CommandContext, CommandDef, CommandUnavailable } from '@renderer/features/command-palette/types'
import { commandChordLabel } from '@renderer/features/command-keybindings/useCommandChord'
import { toggle } from '@renderer/features/command-palette/commandState'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { SessionId } from '@renderer/workspace/types'

import { attachPocket, canHavePocket, togglePocket } from '../actions'
import { detachAndForget } from '../ui/detach'
import { requestPocket, type PocketRequest } from '../state/pocketBus'

// Browser Pocket commands (#1142). Every target resolves through
// commandTargetSessionId, which already answers Spotlight's agent first when
// Spotlight is open — so ⌘⇧B inside Spotlight acts on the agent on screen.

const OFF: CommandUnavailable = { reason: 'Turn on Browser Pocket in Settings → Experimental.', presentation: 'hide' }

function target(ctx: CommandContext): SessionId | null {
  return commandTargetSessionId(ctx.workspace) as SessionId | null
}

function whenPocket(ctx: CommandContext): CommandUnavailable | null {
  if (!ctx.flags.browserPocketEnabled) return OFF
  const id = target(ctx)
  if (!id || !ctx.workspace.state.sessions[id]?.browserPocket) {
    // Live chord (plan H4): the reason spelled "(⌘⇧B)" literally.
    const chord = commandChordLabel('toggle-browser-pocket', ctx.flags.commandKeybindingOverrides)
    return { reason: `The focused agent has no browser pocket${chord ? ` (${chord})` : ''}.`, presentation: 'disable' }
  }
  return null
}

function pocketRequest(ctx: CommandContext, request: PocketRequest): void {
  const id = target(ctx)
  const pocket = id ? ctx.workspace.state.sessions[id]?.browserPocket : undefined
  if (pocket) requestPocket(pocket.pocketId, request)
}

export const browserPocketCommands: CommandDef[] = [
  {
    id: 'toggle-browser-pocket',
    category: 'navigate',
    // `app`, like Spotlight: it targets the focused lane's agent OR the
    // Spotlight agent, whichever the user is looking at.
    surface: 'app',
    title: 'Toggle Browser Pocket',
    description: '**What it does:** Attaches a browser to the focused agent, or opens and collapses it.\n\n**Use when:** You want to see what this lane is building. The pocket rides in the lane and sits beside the agent in Spotlight.\n\n**Notes:** Each agent\'s pocket has its own cookies.',
    keywords: ['browser', 'preview', 'pocket', 'localhost', 'web', 'page'],
    unavailableReason: ctx => {
      const id = target(ctx)
      if (!id || !canHavePocket(ctx.workspace.state, id)) return { reason: 'Browser pockets attach to agents.', presentation: 'disable' }
      return null
    },
    getState: ctx => {
      const id = target(ctx)
      return toggle(Boolean(ctx.flags.browserPocketEnabled && id && ctx.workspace.state.sessions[id]?.browserPocket?.view === 'open'))
    },
    run: ctx => {
      const id = target(ctx)
      if (id && !ctx.flags.browserPocketEnabled) {
        const app = useAppStore.getState()
        app.setSettings(browserPocketEnablePatch(app.settings))
      }
      // A saved open pocket is hidden while the feature is disabled. First
      // use means SHOW it, not toggle that saved state back to collapsed.
      if (id) ctx.workspace.updateBrowserPocket(state => ctx.flags.browserPocketEnabled ? togglePocket(state, id) : attachPocket(state, id, { view: 'open' }))
    },
  },
  {
    id: 'reload-browser-pocket',
    category: 'navigate',
    surface: 'app',
    title: 'Reload Browser Pocket',
    description: 'Reloads the focused agent\'s browser pocket.',
    keywords: ['browser', 'pocket', 'refresh'],
    unavailableReason: whenPocket,
    run: ctx => pocketRequest(ctx, { type: 'reload' }),
  },
  {
    id: 'focus-browser-pocket-address',
    category: 'navigate',
    surface: 'app',
    title: 'Focus Browser Pocket Address Bar',
    description: 'Puts the cursor in the focused agent\'s pocket address bar. Type a URL or just a port like 5173.',
    keywords: ['browser', 'pocket', 'url', 'address', 'navigate'],
    unavailableReason: whenPocket,
    run: ctx => pocketRequest(ctx, { type: 'focus-address' }),
  },
  {
    id: 'pick-browser-pocket-element',
    category: 'navigate',
    surface: 'app',
    title: 'Pick Element for Agent',
    description: '**What it does:** Lets you click an element in the pocket and inserts a reference to it in this agent\'s composer.\n\n**Notes:** Esc cancels.',
    keywords: ['browser', 'pocket', 'inspect', 'element', 'select', 'design'],
    unavailableReason: whenPocket,
    run: ctx => pocketRequest(ctx, { type: 'pick' }),
  },
  {
    id: 'open-browser-pocket-external',
    category: 'navigate',
    surface: 'app',
    title: 'Open Browser Pocket Page in Browser',
    description: 'Opens the pocket\'s current page in your default browser.',
    keywords: ['browser', 'pocket', 'external', 'system'],
    unavailableReason: whenPocket,
    run: ctx => pocketRequest(ctx, { type: 'open-external' }),
  },
  {
    id: 'open-browser-pocket-devtools',
    category: 'navigate',
    surface: 'app',
    title: 'Open Browser Pocket DevTools',
    description: 'Opens Chromium DevTools for the pocket\'s page. While DevTools is open the agent cannot act on the page.',
    keywords: ['browser', 'pocket', 'devtools', 'inspect', 'console'],
    unavailableReason: whenPocket,
    run: ctx => pocketRequest(ctx, { type: 'devtools' }),
  },
  {
    id: 'detach-browser-pocket',
    category: 'navigate',
    surface: 'app',
    title: 'Detach Browser Pocket',
    description: 'Removes the browser from the focused agent and deletes its own cookies and storage (a jar shared with the project is kept).',
    keywords: ['browser', 'pocket', 'close', 'remove'],
    unavailableReason: whenPocket,
    run: ctx => {
      const id = target(ctx)
      if (id) detachAndForget(ctx.workspace, id)
    },
  },
]
