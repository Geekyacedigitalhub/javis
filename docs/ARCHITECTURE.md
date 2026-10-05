# FROSH Architecture

## Core flow

User input -> client -> API -> FROSH orchestrator -> planning/model -> permission check -> tool execution -> result -> model -> response.

## Clients

### Web
The FROSH control center will provide conversations, tool activity, memory controls, project status, jobs, security activity, device status, and settings.

### Android
The mobile client will provide voice/text interaction, notifications, camera/vision, device status, and remote access to authorized FROSH capabilities.

### Desktop agent
The Windows agent will run locally and expose only explicitly approved capabilities. High-risk operations require confirmation.

## Intelligence

FROSH separates model reasoning from application authorization. The model can request a tool, but the application decides whether that tool can run.

## Memory

Memory is separated into conversation context, user preferences, project knowledge, task history, and future domain-specific memories.

## Tool system

Every tool has:
- stable name
- description
- parameter schema
- permission level
- input validation
- execution boundary
- timeout/failure handling
- audit event
- user-facing result

## Agent system

The core agent will eventually delegate work to specialist agents:
- Developer
- Cybersecurity
- Research
- Web
- Business
- Career
- Trading
- Creative
- Personal

## Security model

FROSH must never treat arbitrary model output as authorization. Server-side policy decides whether an action is allowed. Device agents authenticate securely and expose a limited capability set.
