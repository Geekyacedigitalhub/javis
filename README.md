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


## Running FROSH locally

Requirements: [Bun](https://bun.sh) 1.4+ and Node-compatible tooling for the web app.

```bash
bun install                 # backend dependencies
cd apps/web && bun install  # control center dependencies
```

Create a `.env` at the repository root:

```bash
FROSH_WEB_TOKEN=dev-local-token
FROSH_DEVICE_ENROLLMENT_TOKEN=dev-enroll-token
FROSH_USER_ID=default-user
FROSH_AUTOMATION_USER_ID=default-user
PORT=3001
# Optional: enables the Postgres-backed stores instead of in-memory stores
# DATABASE_URL=postgres://user:pass@localhost:5432/frosh
# Optional: enables the OpenAI provider instead of the development provider
# OPENAI_API_KEY=
```

Start the API and the control center:

```bash
bun run dev        # API on http://localhost:3001
bun run dev:web    # control center on http://localhost:3000
```

### Verification commands

```bash
bun run check          # typecheck backend + web
bun test               # full test suite (52 tests, no network required)
bun run test:unit      # fast suite: syntax, stores, validation, schedules
bun run test:api       # boots the real API and drives it over HTTP
bun run migrate:dry    # list migrations without touching a database
bun run migrate        # apply migrations (requires DATABASE_URL)
bun run migrate:verify # fail if anything is pending or a checksum drifted
bun run build:web      # production build of the control center
```

### Test suite

| File | Covers |
|---|---|
| `tests/syntax.test.ts` | Parses every source file; catches truncated or partially written files |
| `tests/missions.test.ts` | Mission lifecycle, leases, quota fence, event ownership |
| `tests/validation.test.ts` | Identifier and multi-line text guards (regression) |
| `tests/automation.test.ts` | Schedule validation bounds and next-run arithmetic |
| `tests/migrations.test.ts` | Migration discovery, ordering, integrity, column coverage |
| `tests/api.integration.test.ts` | Boots the API and exercises auth, missions, automations, chat, 404 |

The whole suite runs offline: no `OPENAI_API_KEY` and no database are needed,
because the API falls back to the in-memory stores and the development provider.
CI (`.github/workflows/ci.yml`) runs typecheck, tests, migration discovery and a
production web build on every push to `main`.

### Provider behaviour

FROSH never requires model credentials just to run. `createProvider()` returns the
OpenAI provider when `OPENAI_API_KEY` is set and the offline `DevelopmentProvider`
otherwise, so the API, missions, automations, and tools can be exercised locally.
Mission evaluation is advisory: if the evaluator is unavailable the mission
continues conservatively instead of failing completed work.

### Control center authentication

The control center is protected by HTTP Basic auth whose password is
`FROSH_WEB_TOKEN`. For local development only, `FROSH_WEB_AUTH_DISABLED=true`
skips that check. The bypass is ignored in production builds.

## Development principles

1. Security and explicit permissions before powerful actions.
2. Provider-independent orchestration where practical.
3. Type-safe contracts between clients, services, and tools.
4. Observable actions: tool calls must be traceable.
5. The model never grants itself authorization.
6. Build production-quality vertical slices instead of UI-only prototypes.
