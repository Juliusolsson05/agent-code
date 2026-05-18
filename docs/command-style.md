# Command Style

This repo treats command titles as stable names, not as descriptions of the current transition.

## Rules

1. Use a stable noun phrase for toggles and modes.
   Examples: `Reader Mode`, `Spotlight`, `Tiled Tabs`, `Dangerous Agents`, `Git Bar`.

2. Do not encode state changes into the title.
   Avoid: `Toggle`, `Enable`, `Disable`, `Enter`, `Exit`, `Turn On`, `Turn Off`.

3. Show state separately in the command palette.
   Use short badges like `On`, `Off`, `Claude`, `Codex`, `Active`.

4. Use imperative verbs for one-shot actions.
   Examples: `Open Settings`, `Copy Last Response`, `Normalize Layout`, `Reload Agent`.

5. Use `New X` for creation commands.
   Examples: `New Tab`, `New Agent`, `New Terminal Right`.

6. Use `Focus X` for directional navigation commands.
   Examples: `Focus Pane Left`, `Focus Pane Down`.

7. Use one term consistently for the same concept.
   Prefer `Pane`, `Tab`, `Agent`, `Provider`, and `Mode` only when those meanings are actually distinct.

8. Only use an ellipsis when the command requires more user input after invocation.
   Example: `New Agent…`

## Examples

| Prefer | Avoid |
|---|---|
| `Reader Mode` | `Toggle Reader Mode` |
| `Dangerous Agents` | `Enable Dangerous Agents` |
| `Dangerous Agents` | `Disable Dangerous Agents` |
| `Spotlight` | `Exit Spotlight` |
| `Switch Provider` | `Switch To Claude` |
| `Reload Agent` | `Reload Claude Agent` |
| `AI Workspace MCP` | `Enable AI Workspace MCP` |

## Implementation note

If a command needs to show current state in the palette, use `getState` on the command definition instead of mutating the title string.
