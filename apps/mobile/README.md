# FROSH Android

The Android client is the mobile control center for the FROSH personal AI operating system.

## Native capability architecture

FROSH uses a capability model instead of assuming unrestricted Android access. Every native action must report whether it is available, requires user permission, or is unsupported on the current device.

Current capability contracts:

- device information
- app launching
- media control
- dialer and direct calls
- message composition
- notification access
- user-initiated camera capture for visual analysis
- screen observation (not yet implemented)
- location (not yet implemented)

High-risk capabilities remain behind explicit Android permissions and FROSH authorization.

## Current client

- secure device pairing
- FROSH chat with durable conversation history, reopenable threads, and explicit new-chat control
- agent task launcher
- task status
- approval UI
- realtime events
- connected-device list
- capability reporting
- user-initiated camera capture for Gemini visual analysis
- spoken model responses with `expo-speech`
- foreground-only Android speech recognition, with explicit microphone permission and transcript submission

## Camera and voice privacy

The Visual Assist card requests camera permission only when you tap **Open
Camera**. It sends a photo only after **Capture & Analyze** is tapped; the
transient image is not saved by FROSH. Visual analysis requires the paired
server to have a live Gemini provider configured. The returned answer can be
read aloud. The Voice button uses Android's selected speech-recognition service
only after an explicit tap and microphone grant; it sends FROSH the resulting
text transcript rather than an audio upload.

## Next native integrations

1. screen/accessibility bridge
2. location/maps
3. phone-to-Windows control

## Media architecture

FROSH exposes provider-neutral media commands: play, pause, toggle, next, previous, stop, volume up/down, plus current-media state. The Android MediaSession bridge will connect these commands to whichever compatible media session is active on the phone.
