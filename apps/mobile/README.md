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
- camera
- screen observation
- location

High-risk capabilities remain behind explicit Android permissions and FROSH authorization.

## Current client

- secure device pairing
- FROSH chat
- agent task launcher
- task status
- approval UI
- realtime events
- connected-device list
- capability reporting

## Next native integrations

1. Android device/app discovery
2. media-session controls
3. dialer and call permissions
4. notification listener
5. camera/vision
6. screen/accessibility bridge
7. location/maps
8. phone-to-Windows control

## Media architecture

FROSH exposes provider-neutral media commands: play, pause, toggle, next, previous, stop, volume up/down, plus current-media state. The Android MediaSession bridge will connect these commands to whichever compatible media session is active on the phone.
