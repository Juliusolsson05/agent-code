// Barrel for the composition root. SetupGate is re-exported here so
// App.tsx itself has ZERO `@renderer/features/*` imports — the #494
// acceptance criterion is "no direct feature-surface imports in App";
// shell files are the designated place where feature composition
// happens.
export { RestoreBanner } from './RestoreBanner'
export { SettingsBar } from './SettingsBar'
export { MainSurface } from './MainSurface'
export { SetupGate } from '@renderer/features/setup/ui/SetupGate'
