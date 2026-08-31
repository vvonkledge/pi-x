# pi-x

`pi-x` is the Pi agent harness for SIANA's minions. It ships one command, `pix`,
which runs a single Pi agent turn in a bounded process and reports how that run
ended.

`pix` exists to close one gap. `pi --mode rpc` exits 0 whether the run settled
cleanly, failed at the provider after exhausting its retries, was aborted, or was
truncated by a client closing stdin. Exit status, last event and stderr are the
same in all four cases. `pix` classifies the run from the event stream instead, so
a caller can tell those apart.

`pix` reports how a run ended. It does not say whether the task succeeded: a minion
records that itself, and the queue remains authoritative.

## Commands

```sh
pix preflight --spec /abs/run-spec.json
pix run       --spec /abs/run-spec.json [--trace /abs/trace.jsonl]
```

`preflight` prints nothing and exits 0 when the spec is satisfiable. Otherwise it
prints one refusal object and exits 40, having started no agent.

`run` prints exactly one outcome object on stdout and nothing else. It runs the
same preflight first, so a refusal is reported the same way.

## Supported Pi versions

`pix` requires `pi` on `PATH` in the range `>=0.84.2 <0.85.0` and refuses any other
version, naming the version it observed.

The range is narrow because Pi is 0.x and the behavior this harness depends on is
observed, not contractual: a missing `--append-system-prompt` file appended as
literal text, an invalid thinking level warned about and then ignored, exit 0 on a
total provider failure, and the `--session-id` flag. Re-verify those at every bump
before widening the range.

## The run spec

Protocol 1. A file rather than argv, because argv is world readable through `ps`.
Unknown fields are refused rather than ignored: a silently dropped misspelling is a
minion briefed with something other than what the caller wrote.

```json
{
  "protocol": 1,
  "identity": {
    "task": "build-pix-one-shot",
    "project": "pi-x",
    "branch": "siana/feat/build-pix-one-shot"
  },
  "workspace": { "cwd": "/abs/path/to/worktree" },
  "prompt": {
    "systemAppendFiles": ["/abs/orders.md", "/abs/pi-x/ORDERS.md"],
    "systemAppendText": [],
    "initialMessage": "Take your task."
  },
  "model": {
    "provider": "anthropic",
    "id": "claude-opus-4-5",
    "thinking": "high"
  },
  "tools": { "allow": ["read", "bash", "edit", "write"] },
  "env": {
    "SIANA_HOME": "/abs/.siana",
    "SIANA_TASKS_FILE": "/abs/.siana/tasks.jsonl",
    "SIANA_TASK_ID": "build-pix-one-shot"
  },
  "limits": {
    "startupTimeoutMs": 60000,
    "idleTimeoutMs": 900000,
    "wallClockTimeoutMs": 14400000
  },
  "session": { "id": "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" }
}
```

- `identity` is recorded on the outcome and never interpreted. The trace envelope
  carries the task id. `branch` is recorded, never checked out.
- `workspace.cwd` is the child's working directory. Pi has no `--cwd` flag, so this
  is how a minion is put in its worktree.
- `prompt.systemAppendFiles` are absolute paths appended to the system prompt in
  this order. At least one is required.
- `prompt.systemAppendText` is optional literal text, appended after the files, in
  order. An entry that happens to name an existing file would be read as one, since
  that is how Pi's flag behaves.
- `prompt.initialMessage` is the one prompt the run delivers.
- `model.provider` and `model.id` are required. `pix` has no default and never
  reads the captain's Pi settings.
- `model.thinking` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  `max`.
- `model.credentialCommand` and `model.providerConfig` are optional; see below.
- `tools.allow` is the exact tool allowlist, enforced at Pi's tool registry rather
  than in the prompt.
- `env` is a bounded allowlist added to a scrubbed base environment.
- `limits` are the startup, idle and wall-clock deadlines in milliseconds.
- `session.id` is the caller-chosen Pi session id.

The spec carries no secret of any kind, and `pix` refuses values and environment
names that look like one.

## Credentials

A minion's credential is a dedicated OS keychain entry. `pix` writes a per-run
`models.json` whose `apiKey` is a command reference that Pi resolves at request
time:

```json
{
  "providers": {
    "anthropic": { "apiKey": "!security find-generic-password -ws pi-x-minion" }
  }
}
```

The secret therefore lives in the keychain and, briefly, in the provider request
header. It is never in the spec, in argv, in a file `pix` writes, in the inherited
environment, on stdout, in a trace, or in the outcome.

Provision it once, outside `pix`:

```sh
security add-generic-password -a "$USER" -s pi-x-minion -w
```

`model.credentialCommand` overrides the command for a machine whose keychain is not
macOS's. It must be a bare command: `pix` writes Pi's `!` prefix itself, and refuses
a value that carries Pi's own resolution syntax or that looks like a secret.

Pi applies no caching or TTL to such commands. Wrap a slow or rate-limited helper in
your own caching script.

`pix` never writes a plaintext `auth.json`. That would put a credential in a
directory whose path the minion's own bash tool is handed through
`PI_CODING_AGENT_DIR`.

## Local, proxied and scripted models

`model.providerConfig` carries the provider definition a non-built-in model needs.
It accepts only `baseUrl`, `api`, `authHeader`, `compat`, `models` and
`modelOverrides`. `apiKey`, `headers` and `oauth` are refused, because those are the
credential-bearing fields and `pix` writes the credential reference itself.

## Outcomes and exit codes

`run` prints one object:

```json
{
  "protocol": 1,
  "task": "build-pix-one-shot",
  "outcome": "settled-ok",
  "detail": {
    "cause": null,
    "lastStopReason": "stop",
    "turns": 7,
    "toolCalls": 22,
    "retries": 0,
    "events": 184,
    "durationMs": 812004,
    "piVersion": "0.84.2",
    "runId": "0b2e7ff9-cfcd-4346-8237-f5b33dd70dde",
    "project": "pi-x",
    "branch": "siana/feat/build-pix-one-shot",
    "sessionId": "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001",
    "sessionFile": "/abs/state/pi-x/runs/.../sessions/....jsonl",
    "childExitCode": 0,
    "childSignal": null
  }
}
```

| outcome | exit | meaning |
|---|---|---|
| `settled-ok` | 0 | settled, `stopReason` was `stop` or `toolUse` |
| `settled-error` | 10 | settled, `stopReason` was `error`, or there was none |
| `settled-truncated` | 11 | settled, `stopReason` was `length` |
| `cancelled` | 12 | `stopReason` was `aborted`, or `pix` was signalled |
| `rejected` | 20 | the `prompt` command was refused; no run started |
| `timeout-startup` | 21 | no readiness inside `startupTimeoutMs` |
| `timeout-idle` | 22 | no event for `idleTimeoutMs` |
| `timeout-wall` | 23 | `wallClockTimeoutMs` exceeded |
| `crashed` | 30 | the child died, never became usable, or broke the stream |
| `preflight-refused` | 40 | a preflight check refused; nothing was started |

`detail` is bounded to counts, durations, the Pi version and identifiers. It never
carries a message, a prompt, a tool argument, a tool result or any part of a
transcript. `detail.cause` is drawn from a closed set of harness-authored strings,
so no Pi or model output reaches the record either. A refusal's `detail` names the
failed check and a reason, never the offending value.

`settled-ok` means the agent finished a turn without the transport or the model
failing. It is not a statement about the work.

An exit code outside this table means `pix` itself failed, and the reason is on
stderr. No outcome object is printed in that case, so a caller can tell a harness
failure from any run result.

## What preflight refuses

Nothing is spawned and no state is created when any of these fails:

- a spec that is unreadable, is not JSON, is malformed, or carries an unknown field
- a `cwd` that is missing, relative, or not a directory
- an orders file that is missing or empty. Pi does not stat
  `--append-system-prompt`, so a path that does not exist is appended as literal
  text and the session starts normally
- a missing or unresolvable model. `pix` has no default and never falls back to
  Pi's own resolution order
- a provider `pi auth check` reports as not ready
- a Pi version outside the supported range
- a thinking level outside the documented seven. Pi only warns and then silently
  uses its default
- an empty, duplicated or malformed tool allowlist
- limits that are not integers inside documented bounds
- a credential-shaped environment name, or a value that looks like a secret
- a state root or a trace path inside the worktree

## Isolation

Every run starts from a scrubbed base. The child receives `PATH`, `HOME`, `TERM`,
`TZ`, `LANG`, `LC_*`, plus `PI_OFFLINE=1`, a per-run `PI_CODING_AGENT_DIR`, and
exactly the spec's `env` allowlist. Nothing else from the harness environment
crosses, including provider API keys.

It is spawned with `--mode rpc --no-context-files --no-extensions --no-skills
--no-prompt-templates --no-themes --no-approve`, so no captain package, extension,
skill, prompt template, theme, model preference or credential reaches it, and no
project-local file in a checked-out branch can rewrite its system prompt.

Concurrent runs share no config directory, credential resolution, working
directory, session, trace or provider.

**`pix` is not a sandbox.** Pi has no built-in sandbox by design, and its tools run
with the permissions of the user that started them. `pix` is an isolation boundary
for configuration, credentials and context, and it is tested as one. It cannot stop
a minion from running any binary the user can run. Real isolation has to come from
the operating system; Pi documents the options under `docs/containerization.md`.

Prompt injection from repository content is expected local-agent risk that `pix`
inherits. What it does hold is that the orders are trustworthy: a missing orders
file refuses rather than becoming prompt text.

## Sessions, state and retention

State lives under `$XDG_STATE_HOME/pi-x`, or `~/.local/state/pi-x` when that is
unset or relative, and never inside a worktree: the minion's own bash tool is handed
`PI_SESSION_FILE`, and a transcript inside a worktree is one stray `git add -A` away
from being committed.

"Inside a worktree" is decided by device and inode rather than by path spelling,
because one directory has several valid absolute spellings: `/var` is a symlink to
`/private/var`, the default macOS volume is case-insensitive, and any symlink names
a directory again. A state root or a trace reached through any of those spellings is
refused the same way as the direct one.

Each run gets `runs/<task>/<runId>/` holding its `agent/` config directory, its
`sessions/` directory and a `run.json` marker. Every `run` sweeps state older than
30 days. The sweep removes only expired state that carries a `pi-x` marker and whose
process is gone; live, unmarked, foreign or unreadable state is left alone.

## Traces

`--trace` is a deliberate debugging act. The file is JSONL, one record per Pi event
in a harness envelope, plus the child's stderr:

```json
{"protocol":1,"task":"...","run":"...","seq":41,"at":"2026-08-31T10:20:24.449Z",
 "phase":"running","pi":{"type":"tool_execution_end", "...": "..."}}
```

**A trace is sensitive.** Raw Pi events carry tool arguments and tool results, so a
trace can contain task content. It never contains a credential. No trace is written
without `--trace`, and a trace path inside the worktree is refused.

Without `--trace`, the child's stderr is discarded; failures are reported through
the outcome, never hidden in it.

## Development

```sh
just test
```

The suite is offline and deterministic. It drives `pix` as a process against two
doubles: a scripted `openai-completions` transport for cases about model and prompt
behavior, run through the real pinned Pi, and a scripted `pi` child for the process
lifecycle cases a real Pi cannot be made to produce on demand. No test calls a live
model or uses a real credential.

Pi 0.84.2 is a devDependency so the version the suite exercises is the version the
lockfile pins, locally and in CI.
