# JARVIS

Personal AI assistant platform for voice, memory, tools, automation, and secure device control.

## Vision

JARVIS is designed as a multi-device assistant with a central AI orchestration layer and permissioned tools. The project will grow from a working text/voice assistant into a secure personal agent for development, research, automation, and authorized computer actions.

## Architecture

- `apps/web` — JARVIS control center
- `apps/mobile` — Android client
- `apps/desktop-agent` — authorized Windows device agent
- `services/api` — backend API and realtime gateway
- `services/ai` — model orchestration and agent loop
- `services/memory` — persistent memory layer
- `services/tools` — permissioned tools/actions
- `packages/types` — shared TypeScript contracts
- `packages/config` — shared configuration
- `packages/ui` — shared UI primitives

## Development principles

1. Security and explicit permissions before powerful computer actions.
2. Provider-independent AI orchestration where practical.
3. Type-safe contracts between clients, services, and tools.
4. Observable actions: tool calls should be traceable and explainable.
5. Start small with a working vertical slice, then expand.

## Roadmap

1. Foundation and contracts
2. AI chat and tool calling
3. Persistent memory
4. Voice interface
5. Windows desktop agent
6. Android client
7. Browser/developer tools
8. Automation and proactive workflows
9. Vision and advanced multimodal capabilities
