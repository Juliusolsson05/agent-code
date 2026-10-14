# Tailscale for Hermes, phase 1: reach Hermes over the owner's tailnet

**Status:** IN PROGRESS. It ships in the same PR as `2026-10-14-hermes-telegram-thread-and-commands.md` (ruling R2 there). Scope decision 8 is defaulted and **UNCONFIRMED**.

**Size:** short plan. The shape is known: URL recognition, one error sentence, a Settings hint, and setup docs in the integrations register.

## Outcome

The owner wants Tailscale "as a theme we ship… something all of the teams have to use… very important when it comes to the premise".

Phase 1 makes a **private** Hermes the supported path, without Agent Code owning a VPN:

1. **Agent Code recognises tailnet URLs** in Settings → Hermes:
   - MagicDNS `*.ts.net` hosts;
   - IPv4 CGNAT `100.64.0.0/10`;
   - Tailscale's IPv6 ULA `fd7a:115c:a1e0::/48`.

   The connection row shows a "Tailscale" tag.
2. **Clear failures on tailnet hosts.** When a tailnet connection times out, is refused or can't resolve, the error says so: "This is a Tailscale address. Check that Tailscale is connected on this Mac and that this device is allowed to reach <host>." Today's sentence only hints "VPN (Tailscale)" on ETIMEDOUT.
3. **The Add-connection form's help text recommends Tailscale** for servers outside the local machine, with a "How to set this up" disclosure that has the server steps.
4. **Setup steps** are written into the integrations register (memory `reference_integrations.md`) for the owner's VPS:
   - `curl -fsSL https://tailscale.com/install.sh | sh`
   - `tailscale up`
   - `tailscale serve --bg --https=443 http://127.0.0.1:4860`
   - the Hermes URL becomes `https://srv1921318.<tailnet>.ts.net`
   - then remove the public Traefik route.

   The owner runs these. Changing the server is outside this PR.

## Design

- **`src/shared/hermes/tailnet.ts`** (new, pure):
  - `isTailnetHost(host: string): boolean`;
  - `tailnetKindOf(url: string): 'magicdns' | 'ipv4' | 'ipv6' | null`.

  WHY shared: main uses it for error wording and the renderer for the tag. Both must agree on what counts as tailnet.
- **`src/main/hermes/service.ts describeError`:** takes the base URL. When `isTailnetHost`, it returns the tailnet sentence for ECONNREFUSED / ENOTFOUND / ETIMEDOUT / EHOSTUNREACH / ENETUNREACH.
- **`HermesConnectionsRow` + the add form:** the tag and the help text. No new settings and no new IPC.
- **No `tailscale` CLI calls and no LocalAPI.** That is phase 2, because it needs a decision on how Agent Code finds the CLI per platform and whether to read peer lists.

## Tests

- **`tailnet.test.ts`:**
  - CGNAT range edges: `100.63.255.255` false, `100.64.0.0` true, `100.127.255.255` true, `100.128.0.0` false;
  - `.ts.net` suffix matching that rejects `ts.net.evil.com` and `evilts.net`;
  - the IPv6 prefix, with and without brackets.

  These are literals by necessity: the ranges are Tailscale's published constants. Each boundary was chosen to fail on an off-by-one.
- **`describeError` tailnet cases:** a real Node `ECONNREFUSED` error object produced by connecting to a closed loopback port, renamed to a tailnet base URL. The sentence must name Tailscale. Before the change it says "Is `hermes serve` running".
- **A renderer test for the tag.**

## Verification boundary

No tailnet is available in this environment. The real reachability path (Mac ↔ VPS over Tailscale) is the owner's manual QA after they run the server steps.

## Out of scope (phase 2, follow-up issue)

- detecting whether Tailscale is running locally;
- listing tailnet peers that run Hermes;
- team ACL guidance;
- other remote providers.
