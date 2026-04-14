# Claude Proxy Stream Demo

Standalone Electron experiment that shows:

- left: a live Claude terminal
- right: the decrypted Claude streaming response captured via the MITM proxy experiment

This is intentionally separate from the production app.

## Prerequisites

Bootstrap the isolated proxy dependency once:

```bash
npm run proxy-demo-bootstrap
```

## Run

```bash
npm run proxy-demo
```

Optional environment variables:

- `CC_PROXY_TEST_CWD`
  Working directory Claude starts in.
- `CC_PROXY_TEST_CLAUDE_BINARY`
  Claude binary path.

## Notes

- This depends on the experimental proxy harness in `claude-code-headless/src/testing/proxy-testing/`.
- It is expected to be brittle. The goal is observability, not product readiness.
