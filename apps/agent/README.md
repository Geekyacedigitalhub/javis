# FROSH device agent

The process that lets FROSH act on a desktop machine. It enrolls once, keeps a
websocket open to the FROSH API, executes the commands it is sent, and reports
what actually happened.

It is written for Windows and runs unchanged on Linux and macOS; the one place
that knows which OS it is on is `src/platform.ts`.

## Run it

```powershell
$env:FROSH_API_URL = "https://your-frosh-host"
$env:FROSH_DEVICE_ENROLLMENT_TOKEN = "the token from the server"
bun run apps/agent/src/index.ts
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `FROSH_API_URL` | `http://127.0.0.1:3001` | Where the API lives |
| `FROSH_DEVICE_ENROLLMENT_TOKEN` | — | Required the first time; must match the server's `FROSH_DEVICE_ENROLLMENT_TOKEN` |
| `FROSH_DEVICE_NAME` | the hostname | The name shown in the control center |
| `FROSH_AGENT_STATE` | `~/.frosh/agent.json` | Where the enrolled credential is kept |
| `FROSH_AGENT_WORKDIR` | your home directory | Default working directory for commands |
| `FROSH_AGENT_CAPABILITIES` | `device.info,shell.execute` | What this machine is allowed to do |

The credential is written with mode `0600` and reused on later starts, so the
enrollment token is only needed once. Delete the state file to re-enroll.

## What it can do

| Command | Capability | Effect |
| --- | --- | --- |
| `device_info` | `device.info` | Hostname, platform, release, CPU count, memory, working directory, shell |
| `run_command` | `shell.execute` | Runs a command line in a working directory and returns exit code, stdout, stderr |

Nothing else. The agent refuses any command it does not implement rather than
guessing at one.

## The honest limits

- **`run_command` is arbitrary code execution on the machine.** It is gated on
  the `shell.execute` capability, which only the trusted web console can grant,
  and the command route requires web authentication even when the caller is that
  device's own credential. Revoke the capability and the device stops accepting
  commands immediately.
- **Commands are synchronous, capped at 14 seconds.** The server waits 15
  seconds for an acknowledgement; anything longer is marked as an unknown
  outcome rather than a success. Long-running work needs an asynchronous result
  channel that this protocol does not have yet.
- **A timeout is reported as unknown, not as failure.** The process was killed
  mid-flight, so whatever it was doing may or may not have happened. The result
  says so, and carries `retryable: false`.
- **Only tested on Linux so far.** The Windows shell invocation
  (`cmd.exe /d /s /c`) is unit-tested but has not been run on a Windows machine
  in this repository's CI.

## Layout

```
src/platform.ts   machine description, shell selection, command execution
src/commands.ts   command handlers (pure, injected runner)
src/agent.ts      enrolment, credential storage, websocket lifecycle, reconnect
src/index.ts      environment configuration and process lifecycle
```
