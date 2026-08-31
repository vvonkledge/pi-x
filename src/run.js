// One `pi --mode rpc` child per run, driven to a classified terminal outcome.
//
// The exit status of that child says nothing: Pi exits 0 on a settled run, on a
// total provider failure after its retries, on an abort, and on a run truncated
// by the harness closing stdin. The outcome therefore comes from the event
// stream and the last assistant stopReason, never from the process boundary.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildChildEnv } from "./child-env.js";
import { JsonlReader, ProtocolViolation } from "./jsonl.js";
import { PROTOCOL, Refusal, refusalOutcome, toRefusal } from "./outcome.js";
import { preflight } from "./preflight.js";
import { createRunState, sweepRetention, writeModelsJson } from "./state.js";

const SETTLE_GRACE_MS = 10_000;
const ABORT_GRACE_MS = 2_000;
const TERM_GRACE_MS = 2_000;
const EOF_GRACE_MS = 500;

export async function runSpec(spec, options = {}) {
  const {
    processEnv = process.env,
    piBin = "pi",
    tracePath = null,
    signals = ["SIGINT", "SIGTERM"],
  } = options;

  let prepared;
  try {
    prepared = prepare({ spec, processEnv, piBin, tracePath });
  } catch (error) {
    // Nothing has been started, so this is the refusal `pix preflight` reports
    // for the same spec, reported the same way and with the same exit code.
    return refusalOutcome(spec.identity.task, toRefusal(error));
  }

  const { ready, state, runId, trace } = prepared;
  try {
    return await drive({ spec, ready, state, runId, processEnv, piBin, trace, signals });
  } finally {
    trace?.close();
  }
}

// Everything that happens before the child exists. Any failure here is a
// refusal, never a crash.
function prepare({ spec, processEnv, piBin, tracePath }) {
  const ready = preflight(spec, { processEnv, piBin, tracePath });

  const runId = crypto.randomUUID();
  let state;
  try {
    state = createRunState({
      root: ready.stateRoot,
      task: spec.identity.task,
      runId,
      pid: process.pid,
    });
    writeModelsJson(state.agentDir, ready.models);
  } catch (error) {
    throw new Refusal("state.root", `run state cannot be written: ${reason(error)}`);
  }

  // Best effort: a sweep that cannot run must never stop a run from starting.
  try {
    sweepRetention(ready.stateRoot);
  } catch {
    /* retention is maintenance, not a precondition */
  }

  let trace = null;
  if (tracePath !== null) {
    try {
      trace = new Trace(tracePath, spec, runId);
    } catch (error) {
      throw new Refusal("trace.path", `trace cannot be opened: ${reason(error)}`);
    }
  }

  return { ready, state, runId, trace };
}

function reason(error) {
  return error?.code ?? "unknown error";
}

export function childArgs(spec, state) {
  const args = [
    "--mode",
    "rpc",
    // Everything the captain's machine would otherwise hand a minion: context
    // files, extensions, skills, prompt templates, themes, and project-local
    // files that could rewrite the system prompt of a checked-out branch.
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--model",
    `${spec.model.provider}/${spec.model.id}`,
    "--thinking",
    spec.model.thinking,
    "--tools",
    spec.tools.allow.join(","),
    "--session-dir",
    state.sessionDir,
    "--session-id",
    spec.session.id,
  ];
  // Order is the contract: Pi appends each flag in argv order.
  for (const file of spec.prompt.systemAppendFiles) {
    args.push("--append-system-prompt", file);
  }
  for (const text of spec.prompt.systemAppendText) {
    args.push("--append-system-prompt", text);
  }
  return args;
}

async function drive({ spec, ready, state, runId, processEnv, piBin, trace, signals }) {
  const startedAt = Date.now();
  const env = buildChildEnv({ processEnv, specEnv: spec.env, agentDir: state.agentDir });

  const tally = {
    turns: 0,
    toolCalls: 0,
    retries: 0,
    events: 0,
    lastStopReason: null,
  };
  let phase = "starting";
  let decision = null;
  let settled = false;
  let terminal = false;

  const child = spawn(piBin, childArgs(spec, state), {
    cwd: spec.workspace.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so a timeout kills the agent's descendants too. A
    // wedged minion has a test runner or a shell under it.
    detached: true,
  });

  let exited = null;
  const exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });
  // The child can exit before its stdout has been drained, and what is still in
  // that pipe can be the record that invalidates the run.
  const drained = new Promise((resolve) => child.stdout.on("close", resolve));

  const timers = new Map();
  const arm = (name, ms, onFire) => {
    clear(name);
    timers.set(name, setTimeout(onFire, ms));
  };
  const clear = (name) => {
    const timer = timers.get(name);
    if (timer) clearTimeout(timer);
    timers.delete(name);
  };
  const clearAll = () => {
    for (const name of [...timers.keys()]) clear(name);
  };

  let wake = () => {};
  const done = new Promise((resolve) => {
    wake = resolve;
  });
  // A protocol violation may override an outcome that was already decided: a
  // record arriving after the terminal event means the stream was never
  // trustworthy, and that must not be reported as the run that settled.
  const decide = (outcome, cause, force = false) => {
    if (decision && !force) return;
    decision = { outcome, cause };
    clearAll();
    wake();
  };

  const onSignal = () => decide("cancelled", "signal-received");
  for (const name of signals) process.on(name, onSignal);

  child.on("error", () => decide("crashed", "child-spawn-failed"));

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => trace?.stderr(phase, chunk));

  const reader = new JsonlReader();
  child.stdout.setEncoding("utf8");

  const consume = (records) => {
    for (const record of records) {
      if (terminal) {
        decide("crashed", "protocol-violation", true);
        return;
      }
      tally.events += 1;
      trace?.event(phase, record);
      arm("idle", spec.limits.idleTimeoutMs, () => decide("timeout-idle", "idle-timeout"));

      if (record.type === "response" && record.command === "get_state") {
        clear("startup");
        if (record.success !== true) {
          // The child answered and said it could not produce its own state.
          // Prompting a session Pi just disowned is not a run.
          decide("crashed", "state-unavailable");
          return;
        }
        phase = "running";
        child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: spec.prompt.initialMessage })}\n`);
        continue;
      }
      if (record.type === "response" && record.command === "prompt") {
        if (record.success !== true) decide("rejected", "prompt-rejected");
        continue;
      }
      if (record.type === "message_end" && record.message?.role === "assistant") {
        // message_start carries a "pending" stopReason; only message_end is final.
        tally.lastStopReason = record.message.stopReason ?? null;
        continue;
      }
      if (record.type === "turn_end") {
        tally.turns += 1;
        continue;
      }
      if (record.type === "tool_execution_end") {
        tally.toolCalls += 1;
        continue;
      }
      if (record.type === "auto_retry_end") {
        tally.retries += 1;
        continue;
      }
      if (record.type === "agent_settled") {
        terminal = true;
        settled = true;
        phase = "settling";
        decide(classifySettled(tally.lastStopReason), causeForSettled(tally.lastStopReason));
        // Keep reading the rest of the batch: a record after the terminal event
        // is a protocol violation and must not be lost with it.
        continue;
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    // Keep reading after a settle so a record arriving after the terminal event
    // is still seen; stop reading once the outcome was decided for any other
    // reason, because the stream is no longer being classified.
    if (decision && !settled) return;
    try {
      consume(reader.push(chunk));
    } catch (error) {
      // Forced only once the run had settled: corruption after the terminal
      // event overrides that outcome, while a partial buffer left behind by a
      // read pix stopped on purpose is pix's own doing, not Pi's.
      if (error instanceof ProtocolViolation) decide("crashed", "protocol-violation", settled);
      else throw error;
    }
  });

  child.stdout.on("end", () => {
    try {
      reader.end();
    } catch {
      decide("crashed", "protocol-violation", settled);
      return;
    }
    // EOF normally precedes the exit that explains it, so give the exit a
    // moment to be the reported cause rather than racing it.
    if (!settled) {
      arm("eof", EOF_GRACE_MS, () => decide("crashed", "stream-ended-before-settled"));
    }
  });

  exit.then(() => {
    if (!settled) decide("crashed", "child-exited-before-settled");
    wake();
  });

  arm("startup", spec.limits.startupTimeoutMs, () =>
    decide("timeout-startup", "startup-timeout"),
  );
  arm("wall", spec.limits.wallClockTimeoutMs, () =>
    decide("timeout-wall", "wall-clock-timeout"),
  );

  // The readiness probe. Its response is what separates a child that started
  // from one that is merely still alive.
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);

  await done;
  clearAll();
  phase = "terminal";

  if (!decision) decide("crashed", "child-exited-before-settled");

  // The handlers stay installed through the shutdown: a second signal arriving
  // mid-escalation must not kill pix and orphan the child it is terminating.
  await stop({ child, exit, exited: () => exited, decision, settled });
  await Promise.race([drained, delay(TERM_GRACE_MS)]);
  for (const name of signals) process.off(name, onSignal);

  const detail = {
    cause: decision.cause,
    lastStopReason: tally.lastStopReason,
    turns: tally.turns,
    toolCalls: tally.toolCalls,
    retries: tally.retries,
    events: tally.events,
    durationMs: Date.now() - startedAt,
    piVersion: ready.piVersion,
    runId,
    project: spec.identity.project,
    branch: spec.identity.branch,
    sessionId: spec.session.id,
    sessionFile: findSessionFile(state.sessionDir, spec.session.id),
    childExitCode: exited?.code ?? null,
    childSignal: exited?.signal ?? null,
  };
  trace?.terminal(decision.outcome, detail);
  return { protocol: PROTOCOL, task: spec.identity.task, outcome: decision.outcome, detail };
}

// The whole point of the harness. agent_settled says Pi will not continue on its
// own; it says nothing about whether the turn succeeded.
export function classifySettled(stopReason) {
  switch (stopReason) {
    case "stop":
    case "toolUse":
      return "settled-ok";
    case "length":
      return "settled-truncated";
    case "aborted":
      return "cancelled";
    case "error":
      return "settled-error";
    default:
      // Settled with no assistant message at all. Fail closed rather than call
      // an empty stream a success.
      return "settled-error";
  }
}

function causeForSettled(stopReason) {
  return stopReason === null || stopReason === undefined ? "no-assistant-message" : null;
}

async function stop({ child, exit, exited, decision, settled }) {
  // No pid means the spawn itself failed, so there is nothing to signal and no
  // exit to wait for.
  if (exited() !== null || child.pid === undefined) return;

  if (settled) {
    // Closing stdin before agent_settled truncates the run silently at exit 0,
    // so it happens here and nowhere else.
    child.stdin.end();
    if (await raceExit(exit, exited, SETTLE_GRACE_MS)) return;
  } else if (decision.outcome === "cancelled") {
    try {
      child.stdin.write(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
    } catch {
      /* the child may already be gone */
    }
    if (await raceExit(exit, exited, ABORT_GRACE_MS)) return;
  }

  killGroup(child, "SIGTERM");
  if (await raceExit(exit, exited, TERM_GRACE_MS)) return;
  killGroup(child, "SIGKILL");
  // Bounded: a process that survives SIGKILL is unreapable, and blocking here
  // forever would turn a classified failure into a hang.
  await raceExit(exit, exited, TERM_GRACE_MS);
}

function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    // Negative pid: the whole group, so the agent's own bash descendants die too.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already reaped */
    }
  }
}

async function raceExit(exit, exited, ms) {
  await Promise.race([exit, delay(ms)]);
  return exited() !== null;
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function findSessionFile(sessionDir, sessionId) {
  try {
    const name = fs.readdirSync(sessionDir).find((entry) => entry.includes(sessionId));
    return name === undefined ? null : path.join(sessionDir, name);
  } catch {
    return null;
  }
}

// A trace is an explicit debugging act. It carries raw Pi events, which include
// tool arguments and results, so it is only ever written when --trace asks.
//
// It is opened and written synchronously. A write stream reports a bad path
// asynchronously, by which time the child already exists, as an unhandled error
// event that would kill pix and orphan the agent. Opening here means every
// trace failure is a refusal before anything starts.
class Trace {
  #fd;
  #spec;
  #runId;
  #seq = 0;

  constructor(tracePath, spec, runId) {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    this.#fd = fs.openSync(tracePath, "w", 0o600);
    this.#spec = spec;
    this.#runId = runId;
  }

  #write(record) {
    this.#seq += 1;
    fs.writeSync(
      this.#fd,
      `${JSON.stringify({
        protocol: PROTOCOL,
        task: this.#spec.identity.task,
        run: this.#runId,
        seq: this.#seq,
        at: new Date().toISOString(),
        ...record,
      })}\n`,
    );
  }

  event(phase, pi) {
    this.#write({ phase, pi });
  }

  stderr(phase, text) {
    this.#write({ phase, stderr: text });
  }

  terminal(outcome, detail) {
    this.#write({ phase: "terminal", outcome, detail });
  }

  close() {
    fs.closeSync(this.#fd);
  }
}
