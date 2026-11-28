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
