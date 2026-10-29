# FROSH

Personal AI operating system foundation for a Jarvis-style assistant: a real model brain, persistent context, permissioned tools, automation, and secure device control.

## Vision and current truth

FROSH is designed as a multi-device personal agent with a central AI orchestration layer and permissioned tools. It is **not** presented as a completed Jarvis product while a live model, paired devices, or an integration have not been configured and verified. The Control Center exposes its model status explicitly: a development fallback is for local/test wiring only and never represents itself as a live AI brain.

## Architecture

- `apps/web` — FROSH control center
- `apps/mobile` — Android client
- `apps/agent` — authorized Windows device agent
- `services/api` — backend API and realtime gateway
- `services/ai` — model orchestration and agent loop
- `services/memory` — persistent memory layer
- `services/productivity` — durable personal tasks and daily briefing layer
- `services/preferences` — persistent modes, personality, autonomy, and response settings
- `services/google` — encrypted Gmail and Google Calendar OAuth integration
- `services/tools` — permissioned tools/actions
- `packages/types` — shared TypeScript contracts
- `packages/config` — shared configuration
- `packages/ui` — shared UI primitives

## Implemented foundation

- Model-provider boundary with Gemini and OpenAI adapters, plus a truthful offline test fallback
- Persistent conversation context, user preferences, and memory-candidate review
- Permissioned tools, an approval center, agent runs, mission/automation records, and audit trails
- Web Control Center, Android companion source, and an opt-in desktop-device agent
- Browser speech controls, Android spoken replies, visual analysis of an explicitly captured Android photo, and device/native capability bridges where the host grants permission

The remaining product scope is tracked honestly in [docs/ROADMAP.md](docs/ROADMAP.md). A feature is not considered ready merely because a screen or interface exists: it needs a configured provider/device/integration and an end-to-end verification.

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
bun run check          # typecheck backend, control center, and Android client
bun test               # full local test suite (no production-network access required)
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
| `tests/api.integration.test.ts` | Boots the API and exercises auth, missions, automations, chat, the coding loop, 404 |
| `tests/android-modules.test.ts` | Native-module layout, autolinking opt-in, Kotlin escape sequences |
| `tests/approvals.test.ts` | Approval listing, expiry sweep, approve/reject, double-resolve, auth |
| `tests/coding-loop.test.ts` | Loop phases, evidence gates, approval parking, real tool execution |
| `tests/windows-agent.test.ts` | Device agent handlers, reconnect backoff, live enrolment and command dispatch |
| `tests/desktop-tools.test.ts` | Desktop tools end to end: safe info, approval-gated commands, refusal without a device |
| `tests/agent-runs.test.ts` | Run listing, owner scope, filters, counts, ordering, limit clamp, auth |
| `tests/agent-run-cancellation.test.ts` | Provider abort propagation and terminal cancellation race protection |
| `tests/run-summary.test.ts` | The console's evidence rules: only a zero exit counts as verified |
| `tests/tool-workspace.test.ts` | The workspace root follows `FROSH_WORKSPACE` per call instead of being frozen at import |

`tests/syntax.test.ts` also enforces an architectural boundary: the Android app
must never import from `services/`. It once pulled `services/memory` into the
React Native bundle, which ships the `postgres` driver to a device that has no
TCP socket for it. Memory work belongs to the server; the phone talks to the API.

### Android client

The Android app (`apps/mobile`) typechecks with `bun run typecheck:mobile`. It
uses the same authenticated conversation endpoints as the web Control Center:
users can start a new chat, reopen a saved chat, continue it with the
server's durable context, and see response deltas as they arrive rather than
treating every mobile prompt as isolated or waiting for a completed reply. Both
clients expose a **Stop response** control: it aborts the provider request,
removes incomplete live text, and does not advance the local conversation as a
completed assistant turn unless the stream finishes successfully.
Its seven native modules (`frosh-apps`, `frosh-calls`, `frosh-contacts`, `frosh-media`,
`frosh-messaging`, `frosh-notifications`, `frosh-speech`) are Kotlin sources.

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

#### Camera, visual analysis, and spoken answers

The paired Android app can open the device camera and submit **only a photo the
user captures by pressing “Capture & Analyze”** to `POST /v1/vision/analyze`.
FROSH sends that transient JPEG to the configured Gemini provider for the single
request and does not store it in FROSH's database, memory, logs, or device
state. The server accepts JPEG, PNG, and WebP input only, with a decoded-image
limit of 3 MB and a 5 MB total JSON request limit. Visual analysis is disabled
with an explicit `503` status unless a live Gemini model is configured; the
offline development provider never pretends it can see an image.

Camera permission is requested by the Android runtime only when the user opens
this feature. Gemini's answer is shown in the app and read aloud using
`expo-speech`; no background recording or automatic camera capture is enabled.
A newly built Android binary is required after pulling the camera dependency.

#### Android voice input

The Android app also has a native, foreground-only voice-input bridge. Tapping
**Voice** requests Android's `RECORD_AUDIO` permission only when necessary and
starts the device's `SpeechRecognizer`; partial text appears in the compose
field and the final transcript is submitted once to the normal authenticated
chat endpoint. FROSH receives transcript text, not an audio upload. Recognition
is provided by the Android speech service selected on the device, which may use
network processing under that service's own privacy policy. It can be stopped
or cancelled from the UI, and unavailable recognizers are reported instead of
being simulated.

#### Building the APK

`.github/workflows/android.yml` runs `expo prebuild --platform android` followed
by `./gradlew assembleDebug` on JDK 17, and uploads `frosh-debug-apk`. It needs
the Android SDK, JDK 17, and roughly 4 GB of RAM, so it runs on GitHub's runners
rather than as part of the local `bun run check` loop. Two guards run first and
fail the job by name if any module falls out of the build.

`apps/mobile/android/` is generated and git-ignored; only the Kotlin sources in
`apps/mobile/modules/*/android/` are tracked.

The whole suite runs offline: no provider key and no database are needed,
because the API falls back to in-memory stores and an explicitly non-production development provider.
CI (`.github/workflows/ci.yml`) runs typecheck, tests, migration discovery and a
production web build on every push to `main`.

### Provider behaviour

FROSH can boot without model credentials so its APIs and test suite remain usable,
but that fallback is **not a live AI assistant**. The Control Center marks it as
“AI brain setup needed” and its response explains that no model was used.

For a no-cost personal deployment, set `FROSH_AI_PROVIDER=gemini`,
`GEMINI_API_KEY`, and optionally `FROSH_GEMINI_MODEL=gemini-2.5-flash` in each
server runtime. Gemini requests are made server-side and use the same
permissioned tool and approval path as OpenAI. Web and Android chat use
Gemini's `streamGenerateContent` server-sent events for real response deltas;
tool calls remain permissioned and approval-gated before a streamed follow-up
is produced.

Interactive chat retries one transient provider failure **only before** FROSH
has emitted a delta or tool event; after visible output starts, it returns the
real failure rather than replaying text or actions. Set
`FROSH_AI_STREAM_RETRIES=0` to disable that retry, or a maximum of `2` to tune
it. Cross-provider failover is deliberately opt-in: set
`FROSH_AI_FALLBACK_PROVIDER=openai` or `gemini` only when the alternate key is
configured and you accept its usage/cost. FROSH never silently selects a paid
fallback for a no-cost Gemini deployment.

`OPENAI_API_KEY` remains an optional alternative. Mission evaluation is
advisory: if no live evaluator is available, missions continue conservatively
rather than inventing verification.

### Deployment

Production container definitions are provided in `Dockerfile.api` and
`Dockerfile.web`. For a two-service Render deployment with managed PostgreSQL,
custom-domain DNS, secret variables, migration behavior, and the final Google
connection checklist, see [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

### Google Gmail and Calendar

The Google integration is intentionally server-side. The browser only starts the
connection and receives a success/failure redirect; it never receives a Google
client secret, refresh token, or access token. FROSH stores its token set only
after AES-256-GCM encryption using `FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY`.

After enabling Gmail API and Google Calendar API, configuring an **External**
OAuth app in **Testing**, adding yourself as a test user, and saving these two
scopes:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/gmail.readonly
```

create a **Web application** OAuth client. Its authorized redirect URI must be
exactly one stable FROSH control-center URL followed by:

```text
/api/google/callback
```

For local development, use this exact URI:

```text
http://localhost:3000/api/google/callback
```

For deployment, use the actual HTTPS application domain, for example
`https://frosh.example.com/api/google/callback`. Then set these *server-only*
values through your host's secret manager (not in source control and never in a
`NEXT_PUBLIC_` variable):

```bash
FROSH_PUBLIC_APP_URL=https://frosh.example.com
FROSH_GOOGLE_REDIRECT_URI=https://frosh.example.com/api/google/callback
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY=... # generate with: openssl rand -base64 32
```

Open **Integrations** in FROSH and choose **Connect Google**. Authorization uses
a short-lived one-time state value, PKCE S256, and an exact redirect URI. The
callback consumes the state before exchanging the code, so a callback cannot be
replayed. Disconnecting deletes the encrypted local token even if Google's
optional remote-revocation request is unavailable.

FROSH can list unread Gmail metadata and upcoming calendar events. It never
requests mail sending access. Calendar event creation is a `confirm` tool, so it
appears in Approval Center and is not sent to Google until you explicitly
approve it. An External app in Testing may require periodic reconnection; that
is expected for private testing and does not require publishing or verification.

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

### The coding loop

A single model call is not a loop. Given a goal, FROSH needs to look, change
something, run the project's own checks, read what came back, and try again —
and it needs to be unable to call that done on its own say-so.

`CodingLoop` drives that. It asks the model what to do next, executes the tool
calls itself, records every result, and repeats. Phase is derived from the
recorded evidence rather than held in memory:

| Evidence recorded | Phase |
| --- | --- |
| Nothing yet | `plan` |
| Reads only | `inspect` |
| An edit, nothing validating it | `test` |
| A validation that exited non-zero | `fix` |
| A failed validation already answered by an edit | `test` |
| A validation that exited zero | `review` |

Because it is derived, a run that restarts re-enters at the right phase and
anyone reading the run can see exactly why the loop believes what it believes.

The rule the loop exists for: **a reply that asks for no tools is the model
declaring it is finished, and that declaration is only accepted in the `review`
phase** — that is, only once a validation tool has actually exited zero. Say it
any earlier and the loop asks once for real validation rather than prose; say it
again and the run fails with "Model reported completion without validation
evidence" and a result that says so. A `workspace_validate` call that never
completed, or completed without an exit code, counts as no evidence at all.

Confirm tools park the loop exactly like everything else in FROSH: the run stops
in `waiting_approval` with the approval id, nothing is recorded for the action
that has not happened yet, and approving it executes the tool once and resumes
from the result. That is why the approval center and the loop compose without
either knowing about the other.

```
POST /v1/agent-runs        { goal, mode: "loop" }                    -> 201, final run
POST /v1/agent-runs        { goal, mode: "loop", background: true }  -> 202, durable running run
POST /v1/agent-runs        Idempotency-Key: <8-128 chars>            -> retry-safe original run (no duplicate execution)
GET  /v1/agent-runs/users/:userId/:runId                             -> run plus its pending approval
POST /v1/agent-runs/users/:userId/:runId/cancel                      -> atomically stop a live run
POST /v1/agent-runs/users/:userId/:runId/retry                       -> fresh background retry of failed/cancelled work
GET  /v1/agent-runs/users/:userId/:runId/events                       -> append-only status audit history
GET  /v1/agent-runs/users/:userId/:runId/checkpoints                  -> secret-free durable task checkpoints
```

Without `mode: "loop"` the endpoint behaves exactly as before. With no live
model key the development provider never calls a tool, so a loop run
deterministically ends `failed` with the unproven-claim message — which is the
honest outcome, and what the integration test asserts.

### Device agent

The control center could list devices and the server could dispatch a command to
one, but nothing lived on a desktop machine to answer. `apps/agent` is that
process: it enrolls once, holds an authenticated websocket, executes what it is
sent, and reports the real result.

Two commands exist for a desktop:

| Command | Capability | Returns |
| --- | --- | --- |
| `device_info` | `device.info` | Hostname, platform, release, CPU count, memory, working directory, shell |
| `run_command` | `shell.execute` | Exit code, stdout, stderr, duration, working directory |

`run_command` is arbitrary code execution on the user's machine, so it is gated
twice: the device must hold the `shell.execute` capability, and only the trusted
web console can grant it — a device credential cannot escalate itself. The
command route also refuses `run_command` without web authentication even when
the caller is that device's own credential.

Commands are synchronous and capped at 14 seconds, because the server waits 15
for an acknowledgement. Anything slower is marked unknown rather than reported
as a success. A command killed at the timeout is likewise reported as an unknown
outcome with `retryable: false`, not as a failure — the same rule the rest of
FROSH follows for interrupted side effects.

Building this found a real defect in the server. `addRealtimeClient` called
`socket.addEventListener("close", ...)` on what is a Bun `ServerWebSocket`,
which has no such method, so every successful device authentication threw and
the socket was never registered. The realtime command channel had never worked.
The close path now runs from the server's own `close(ws)` handler instead.

The agent is written for Windows and runs unchanged on Linux and macOS. Its
Windows shell invocation is unit-tested; running it on an actual Windows machine
is still unverified, and the repository says so rather than implying otherwise.

### Acting on the desktop

A device agent that nothing can reach is a curiosity. Two tools close the loop:

| Tool | Permission | What it does |
| --- | --- | --- |
| `desktop_info` | `safe` | Reports the paired machine: host, platform, release, CPUs, memory, workdir, shell |
| `desktop_run_command` | `confirm` | Runs a command line and returns its exit code, stdout and stderr |

`desktop_run_command` is `confirm`, so it is created as an approval request and
nothing touches the machine until a person approves it. That means the same
route the control center already uses applies here: the request appears in
`/approvals`, approving it dispatches the command, and rejecting it means the
command never ran.

Building this turned up a design gap worth naming. The executor created an
approval *before* the tool ran, so `desktop_run_command` with a blank command
line produced a pending request that could not be honoured however the user
answered it — a dead approval in the user's queue. Tools can now declare
`validate(args)`, which the executor consults before anything is asked of
anyone. `listTools()` strips it, so the model never sees it as part of the
schema. The check is repeated inside `execute` because an approved call is
re-run with the arguments stored on the approval, not the ones the tool first
saw.

The desktop tools are tested against a real agent process over a real websocket,
with the API started in the test process so tool dispatch and the socket registry
are the same objects the server uses. A fake would have proved nothing about the
part that was broken.

### Watching a run

A loop that can be started but not observed is half a feature. `/runs` shows
every agent run with the evidence behind it, and the evidence is the point:

| Label | Means |
| --- | --- |
| **Verified** | A validation command actually exited 0, with the command named |
| **Not verified** — exited N | A validation ran and failed, with the real code |
| **Not verified** — edits, nothing validated | The workspace changed and nothing proved it |
| **No evidence** | Nothing has run yet |

That rule is applied twice — once in the loop that decides whether a run may
complete, and once in `apps/web/app/runs/summary.ts` that decides what the page
may claim. It lives in its own module precisely so it can be tested, because a
console that rounded "a validation ran" up to "verified" would undo the promise
in the one place a person actually looks. Approving a parked run is a link away:
a run in `waiting_approval` points at `/approvals`. A live run also has a **Stop
run** control. Stopping first writes a terminal `cancelled` state, then aborts
any active model request; late provider output cannot turn it back into a
completed or failed run. On startup, FROSH marks any interrupted `running` run
as failed rather than replaying unknown provider or tool side effects; approval
waits remain resumable. Each active model phase also has a bounded execution
budget (`FROSH_AGENT_RUN_TIMEOUT_MS`, ten minutes by default); expiry aborts the
provider call and records a failure rather than replaying work. FROSH also
limits each account to two active or approval-waiting runs by default
(`FROSH_AGENT_MAX_ACTIVE_RUNS`, bounded to 1–5). A full queue receives an honest
`429` response rather than starting unbounded parallel provider or tool work;
cancelling or completing a run immediately frees its slot. Failed and cancelled
runs have a **Retry as fresh work** control: it starts a new background run with
the same goal and mode, while deliberately dropping prior provider continuation,
tool calls, approvals, and uncertain external-action state. A retry is therefore
never an automatic replay; `Idempotency-Key` can make a retry click retry-safe.

```
GET /v1/agent-runs/users/:userId?status=&limit=
  -> { runs, counts: { running, waiting_approval, completed, failed, cancelled } }
```

Counts describe the whole set so the tabs stay honest while one status is shown.

Every new durable run also has an append-only status history and compact,
secret-free task checkpoints. The run console's **Show run activity** view reads
both records, including creation, approval waits/resumption, evidence changes,
completion, cancellation, timeout, and restart-recovery failures. A checkpoint
is a recovery review marker, never permission to replay uncertain provider or
tool work automatically.

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
