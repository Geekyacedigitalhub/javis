# FROSH

Personal AI operating system for intelligence, memory, tools, automation, development, cybersecurity, business, career assistance, voice, vision, and secure device control.

## Vision

FROSH is designed as a multi-device personal agent with a central AI orchestration layer and permissioned tools. It will grow from a working text assistant into a secure operating system for development, research, cybersecurity, GeekyAce Digital Hub operations, job discovery, automation, and authorized computer actions.

## Architecture

- `apps/web` — FROSH control center
- `apps/mobile` — Android client
- `apps/desktop-agent` — authorized Windows device agent
- `services/api` — backend API and realtime gateway
- `services/ai` — model orchestration and agent loop
- `services/memory` — persistent memory layer
- `services/tools` — permissioned tools/actions
- `packages/types` — shared TypeScript contracts
- `packages/config` — shared configuration
- `packages/ui` — shared UI primitives

## Core capabilities

- AI reasoning and planning
- Long-term memory
- Autonomous development workflows
- Cybersecurity assistance for authorized work
- Web research and browser automation
- GeekyAce Digital Hub business/social workflows
- Job discovery and application assistance
- Windows and Android device control
- Voice and vision
- Scheduled automation

## Development principles

1. Security and explicit permissions before powerful actions.
2. Provider-independent orchestration where practical.
3. Type-safe contracts between clients, services, and tools.
4. Observable actions: tool calls must be traceable.
5. The model never grants itself authorization.
6. Build production-quality vertical slices instead of UI-only prototypes.
