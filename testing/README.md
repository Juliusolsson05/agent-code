# Agent Code Test Suite

This directory holds shared test infrastructure, fixtures, and manual harnesses.
Normal tests should live beside the production module they protect whenever
that makes ownership obvious.

## Commands

```bash
npm test
npm run test:unit
npm run test:integration
npm run test:renderer
```

## Test Layers

- `unit`: pure functions, reducers, selectors, mappers, ownership ledgers.
- `integration`: multiple Node/app modules wired together without Electron.
- `renderer`: React component tests in `happy-dom`.

## Policy

Do not add new `scripts/test-*.ts` files. The old script tests were useful as
incident probes, but they are not the project test architecture. New coverage
belongs in Vitest.

