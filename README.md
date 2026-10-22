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
| `tests/android-modules.test.ts` | Native-module layout, autolinking opt-in, Kotlin escape sequences |
| `tests/approvals.test.ts` | Approval listing, expiry sweep, approve/reject, double-resolve, auth |

`tests/syntax.test.ts` also enforces an architectural boundary: the Android app
must never import from `services/`. It once pulled `services/memory` into the
React Native bundle, which ships the `postgres` driver to a device that has no
TCP socket for it. Memory work belongs to the server; the phone talks to the API.

### Android client

The Android app (`apps/mobile`) typechecks with `bun run typecheck:mobile`. Its
six native modules (`frosh-apps`, `frosh-calls`, `frosh-contacts`, `frosh-media`,
`frosh-messaging`, `frosh-notifications`) are Kotlin sources.

TypeScript cannot see those sources, and for a long time nothing compiled them.
Four real defects had accumulated, all fatal:

| Module | Defect | Effect |
| --- | --- | --- |
| `frosh-contacts` | `"\%"` and `"\_"` written with a single backslash | `error: unsupported escape sequence` |
| `frosh-apps` | `"\."` in the package-name `Regex` | `error: unsupported escape sequence` |
| `frosh-messaging` | `appContext.permissions?.askForPermission(...)` | No such method on the Expo `Permissions` interface |
| `frosh-notifications` | `boundedText` was `private` inside one object but called from another class | `unresolved reference 'boundedText'` |

The backslash is easy to get wrong in both directions, and the two mistakes
look identical in a diff. Kotlin needs `"\\%"` to produce the single `\%` that
SQLite's `LIKE ... ESCAPE` consumes, but `\\` is itself an escaped backslash, so
counting backslashes on a line proves nothing: in `FroshContactsModule.kt`
line 48 two backslashes form one valid escape, while line 49 had two
backslashes that were two invalid ones. `tests/android-modules.test.ts` scans
every `.kt` file the way the compiler does, and the Android workflow compiles
them for real.

Each module also needs an `android/build.gradle`, which none of them had. Expo
autolinking drops any module without one *silently* — the app still built, then
failed at runtime with `Cannot find native module 'Frosh...'`. The same test
asserts the file exists, that its `namespace` matches the Kotlin package, and
that every class named in `expo-module.config.json` has a matching `.kt` file.

`apps/mobile/package.json` carries `expo.autolinking.nativeModulesDir: "./modules"`
so autolinking searches the local module directory at all.

#### Building the APK

`.github/workflows/android.yml` runs `expo prebuild --platform android` followed
by `./gradlew assembleDebug` on JDK 17, and uploads `frosh-debug-apk`. It needs
the Android SDK, JDK 17, and roughly 4 GB of RAM, so it runs on GitHub's runners
rather than as part of the local `bun run check` loop. Two guards run first and
fail the job by name if any module falls out of the build.

`apps/mobile/android/` is generated and git-ignored; only the Kotlin sources in
`apps/mobile/modules/*/android/` are tracked.

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

### Approval center

FROSH asks before it acts. Anything a tool marks `confirm` creates an approval
request with a five-minute deadline, and the run stops in `waiting_approval`
until a person decides. Until this existed, nothing could decide: a mission that
needed confirmation sat there until the request expired.

`/approvals` in the control center lists what is pending, shows the tool, the
arguments, and the reason it asked, and offers **Approve and run** or **Reject**.
An `approved`, `rejected`, or `expired` history stays visible.

| Route | Purpose |
| --- | --- |
| `GET /v1/approvals/users/:userId?status=pending\|all` | Pending by default, plus counts for every status |
| `POST /v1/approvals/users/:userId/:id/approve` | Perform the action and resume whatever was waiting |
| `POST /v1/approvals/users/:userId/:id/reject` | Refuse it and stop the waiting run |

Approving resumes the right thing automatically: a mission's approval runs the
mission continuation, an agent run's approval continues that run through its
provider state, and an approval attached to neither simply executes the action
once. Approving something already resolved returns `409`, so a double click
cannot run an action twice.

Expiry is enforced by the store rather than the caller: `list()` marks anything
past its deadline as `expired` before returning, and `resolve()` refuses a
request that is no longer pending.

Approvals are not user-tagged. The runtime is single-tenant and the auth gate
already restricts device credentials to the configured `FROSH_USER_ID`, so the
`/users/:userId` segment exists to apply that same restriction rather than to
partition the records.

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
