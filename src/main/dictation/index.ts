// Public surface for the Agent Code dictation module. Phase 1 only exposes
// the controller — IPC registration, settings/secrets wiring, and UI
// integration (the composer-embedded pill) all land in Phase 2 and will
// add their own modules under this directory.
export * from './controller.js'
