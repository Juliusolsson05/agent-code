import { VoiceDictationOverlay } from '@renderer/features/voice-dictation/ui/VoiceDictationOverlay'

// VoiceDictationOverlay is already fully self-contained (App rendered
// it bare). This wrapper exists purely so the overlay is registry-listed
// like its siblings — #494's "adding a surface never edits App.tsx".
export function VoiceDictationSurface() {
  return <VoiceDictationOverlay />
}
