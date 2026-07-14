# Agent Code privacy

Agent Code is a local desktop development tool. It does not operate an Agent
Code account service and does not upload crash reports, performance traces,
workspace snapshots, prompts, or transcripts to an Agent Code server.

## Provider traffic

Claude Code, Codex, and OpenCode are separate command-line tools. When Agent
Code starts one of them, that tool uses its own authentication, configuration,
and provider network connection. The provider's terms and privacy policy apply
to that traffic.

## Local data

Agent Code stores workspace state and local diagnostics under
`~/.config/agent-code`. Provider transcripts remain in the locations owned by
the provider CLIs. Local diagnostics can contain project paths, command names,
and session metadata; users should review diagnostic bundles before sharing
them. Electron Crashpad is configured for local minidumps only and does not
upload them automatically.

## Voice dictation

Voice dictation is optional. When the user starts dictation, microphone audio
is sent to the transcription provider configured by the user. The current
desktop integration uses Deepgram and requires the user's own API key. Audio is
kept in memory for transcription and is not written to disk by default.

## Remote companion

Remote control is off by default. LAN mode exposes an authenticated server to
the local network. Internet-tunnel mode starts Cloudflare's `cloudflared` quick
tunnel and makes that authenticated server reachable through an ephemeral
Cloudflare URL. Paired devices can read session output, send prompts, and
answer provider permission dialogs, but cannot start arbitrary shell commands.

## Updates and external services

Agent Code may check for newer Claude Code and Codex CLI versions and, according
to the user's setting, run the applicable package-manager update command. The
app also loads file icons and fonts from public CDNs in the current beta.

Questions and security reports can be filed at
<https://github.com/Juliusolsson05/agent-code/issues>.
