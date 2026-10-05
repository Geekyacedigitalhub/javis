# JARVIS Architecture

## Core flow

User input -> client -> API -> AI orchestrator -> tool selection -> permission check -> tool execution -> result -> AI response -> client.

## Clients

### Web
The web control center will provide conversations, tool activity, memory controls, device status, and settings.

### Android
The mobile client will provide voice/text interaction, notifications, device status, and remote access to authorized JARVIS capabilities.

### Desktop agent
The Windows agent will run locally and expose only explicitly approved capabilities. High-risk operations require confirmation.

## AI orchestration

The AI layer is responsible for intent interpretation, context assembly, model calls, tool selection, result synthesis, and action tracing. Business logic should remain outside model prompts whenever possible.

## Memory

Memory will be separated into conversation context, user preferences, project knowledge, and task history. Sensitive information should not be stored unless required and authorized.

## Tools

Every tool should have:

- a stable name and schema
- input validation
- permission level
- audit/event record
- timeout and failure handling
- clear user-facing result

## Security model

JARVIS must never treat arbitrary model output as authorization. The server decides whether a requested action is allowed. Device agents authenticate with short-lived credentials and expose a limited capability set.
