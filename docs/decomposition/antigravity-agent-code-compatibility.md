# Antigravity compatibility in Agent Code

## Outcome

Opening an Antigravity pane should preserve the Agent Code capabilities granted to that pane. A user can choose the native prompt or the rendered Agent view without silently losing tools. Preserve the provider's conversation identity and the user's CLI configuration.

## Evidence

- The released Terminal launcher forwards terminal I/O and conversation selection. It drops the already registered MCP servers.
- Agent view passes the built-in bridge to session/new or session/load. User-configured MCP servers are a separate path to verify.
- Native prompt delivery, project and personal skill discovery, management, and provider-specific conversation actions each have their own capability gates. Making a tool appear does not establish its behavior.
- The installed agy 1.5.18 lists zero configured servers on the reported setup. A disposable profile accepts an MCP server through its MCP config and rejects mcpServers as an unknown --settings key.

## Stages

1. Prove the installed CLI's supported configuration boundaries. Verify discovery using an isolated workspace and a harmless MCP server. Keep the application token scoped to the intended pane.
2. Reuse the existing session registration and implement native and rendered tool provisioning for supported transports, preferences and lifecycle paths. Preserve existing CLI settings and test concurrent panes.
3. Wire programmatic prompt delivery to the correct runtime, retaining native drafts and safe retry semantics. Verify readiness, permissions and session control.
4. Reconcile skill deployment and provider capability declarations against the CLI, including managed and personal skills, conversation operations and composer inputs. Expose only functions with verified behavior.
5. Exercise the normal application paths and record evidence for each feature plus any provider limitations. Run targeted tests, typecheck and review the combined changes.

## Verification

Use the real installed CLI with disposable settings and identifiable local MCP servers. Verify list, tool execution and isolation independently. Check failure and teardown with deterministic tests. Keep credentials, conversations and model responses out of fixtures.

## Observations on agy 1.5.18

- Two concurrent native panes in one real checkout listed distinct grants from the application MCP host. Resuming the first pane restored its original tool. Opening agy separately left its configured servers intact.
- Native prompt dispatch preserved a human draft and submitted the local /new command from an empty confirmed editor. Rendered Agent view accepts image content over ACP. CLI permissions remain under the user's control.
- The CLI recognized personal skills from its current and two legacy directories. Agent Code uses the current directory for managed installs.
- Reading a confirmed native conversation uses ACP replay through the running pane's identity. Closing the pane revokes this access. Rendered panes retain their in-memory history.
- Google's documented hooks are configured in a temporary per-pane workspace. PreInvocation starts a reporting turn, PostToolUse marks work, and a fully idle Stop can request a TLDR or complete the turn. The adapter strips prompts, tool input and output before contacting the reporting host. See https://antigravity.google/docs/hooks.
- The installed ACP server returned method-not-found for fork, rewind and import. The CLI provides interactive /fork and /rewind; the application cannot use them as an exact durable conversation-editing API. Cross-provider history transfer and native subagent visualization remain outside verified support.
- A real SDK tools/call over the native relay wrote a TLDR into the intended pane's reporting store. The live CLI probe exercised discovery. External OAuth consent and model interpretation of an image were not exercised. Native agy handles OAuth directly for headerless HTTPS servers at an origin or /mcp. A server that relies on browser OAuth at a custom path can be configured in agy itself.
