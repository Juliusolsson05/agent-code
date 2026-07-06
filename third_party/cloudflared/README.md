# cloudflared (bundled runtime tool)

Pinned Cloudflare Tunnel client used by the remote mobile companion's
phase-2 transport (`src/main/remote/transport/CloudflaredTunnel.ts`): when
the user flips the Remote panel's tunnel toggle, main spawns

```
cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate
```

against the loopback-bound RemoteServer and publishes the ephemeral
`https://<random>.trycloudflare.com` URL as the pairing QR. Quick tunnels
need no Cloudflare account; the URL changes on every enable (the QR
regenerates) and the service is best-effort — acceptable for a single
owner's phone, documented in the Remote panel copy.

Same rules as every `third_party/` tool (see the repo CLAUDE.md):

- The binary is **never committed**. `manifest.json` (version + per-arch
  sha256 for both the archive and the extracted binary) plus
  `scripts/runtime-tools/fetch-cloudflared.mjs` are the source of truth.
- `npm run runtime:fetch:cloudflared` downloads, verifies, and extracts to
  `cache/<platform>/cloudflared` (gitignored).
- `npm run runtime:verify:cloudflared` re-checks the cache against the
  manifest without network.
- Version bumps are one-file PRs against `manifest.json` — refresh all four
  hashes (`shasum -a 256` on each archive and extracted binary).

Upstream: <https://github.com/cloudflare/cloudflared> (Apache-2.0; see
LICENSE.md).
