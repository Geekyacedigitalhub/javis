# FROSH Android

The Android client is the mobile control center for FROSH.

## Initial product surface

- FROSH chat
- streaming assistant responses
- voice interaction
- agent-run progress
- approval cards
- activity history
- connected-device status
- notifications
- memory controls
- settings and permissions

## Device capabilities planned

- calls and dialer workflows
- contacts
- permitted messaging/reply workflows
- notification intelligence
- music controls
- video workflows
- app launching
- camera/vision
- screen understanding
- maps/navigation
- phone-to-Windows control

## Backend contract

The client communicates with the FROSH API for:

- `POST /v1/chat`
- `POST /v1/agent-runs`
- `GET /v1/agent-runs/:id`
- `GET /v1/approvals/:id`
- `POST /v1/approvals/:id`
- `GET /v1/devices`
- `POST /v1/devices`
- `GET /v1/devices/:id`
- `GET /health`

The Android client must never treat a model response as authorization. Consequential actions are controlled by the FROSH backend permission system.
