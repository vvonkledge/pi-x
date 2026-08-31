// Outcome classification, framing and process lifecycle, driven by the scripted
// Pi child. A real Pi cannot be made to hang, break its own framing, or die on
// command, so these cases are produced here and asserted through the CLI.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  delay,
  FAKE_SECRETS,
  isAlive,
  makeLab,
  outcomeOf,
  readRecord,
  runPix,
  stateRunDirs,
  writeSpec,
} from "./helpers/lab.mjs";

// Each deadline under test is the short one and the other two are generous, so a
// slow machine cannot make one timeout fire in another's place.
const FAST_LIMITS = {
  startupTimeoutMs: 10_000,
  idleTimeoutMs: 1_000,
  wallClockTimeoutMs: 30_000,
};

async function runScenario(lab, scenario, overrides = {}) {
  writeSpec(lab, {
    env: { PIX_TEST_SCENARIO: scenario, PIX_TEST_RECORD: lab.record },
    ...overrides,
  });
  return runPix(lab, ["run", "--spec", lab.specPath]);
}

test("every settled stopReason maps to its outcome and exit code", async (t) => {
  const cases = [
    ["settle-ok", "settled-ok", 0, "stop"],
    ["settle-tooluse", "settled-ok", 0, "toolUse"],
    ["settle-error", "settled-error", 10, "error"],
    ["settle-truncated", "settled-truncated", 11, "length"],
    ["settle-aborted", "cancelled", 12, "aborted"],
  ];
  for (const [scenario, expected, code, stopReason] of cases) {
    const lab = makeLab(t);
    const result = await runScenario(lab, scenario);
    const outcome = outcomeOf(result);
    assert.equal(outcome.outcome, expected, scenario);
    assert.equal(result.code, code, scenario);
    assert.equal(outcome.detail.lastStopReason, stopReason, scenario);
    // Pi exits 0 for all of these; the outcome comes from the stream.
    assert.equal(outcome.detail.childExitCode, 0, scenario);
  }
});

test("settling with no assistant message is not a success", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "settle-no-assistant");
  assert.equal(outcomeOf(result).outcome, "settled-error");
  assert.equal(outcomeOf(result).detail.cause, "no-assistant-message");
  assert.equal(result.code, 10);
});

test("a rejected prompt is reported as rejected, not as a run", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "reject-prompt", { limits: FAST_LIMITS });
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "rejected");
  assert.equal(result.code, 20);
  assert.equal(outcome.detail.cause, "prompt-rejected");
});

test("each timeout is classified, exits with its code, and leaves no child", async (t) => {
  const cases = [
    ["startup-hang", "timeout-startup", 21, "startup-timeout", { startupTimeoutMs: 1_000 }],
    ["idle-hang", "timeout-idle", 22, "idle-timeout", {}],
    [
      "wall-forever",
      "timeout-wall",
      23,
      "wall-clock-timeout",
      { startupTimeoutMs: 3_000, wallClockTimeoutMs: 5_000 },
    ],
  ];
  for (const [scenario, expected, code, cause, limits] of cases) {
    const lab = makeLab(t);
    const result = await runScenario(lab, scenario, {
      limits: { ...FAST_LIMITS, idleTimeoutMs: 20_000, ...limits },
    });
    const outcome = outcomeOf(result);
    assert.equal(outcome.outcome, expected, scenario);
    assert.equal(result.code, code, scenario);
    assert.equal(outcome.detail.cause, cause, scenario);
    if (fs.existsSync(lab.record)) {
      assert.equal(isAlive(readRecord(lab).pid), false, `${scenario} left a child`);
    }
  }
});

test("a timeout kills the agent's descendants, not only the agent", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "descendants", { limits: FAST_LIMITS });
  assert.equal(outcomeOf(result).outcome, "timeout-idle");
  const record = readRecord(lab);
  assert.equal(isAlive(record.pid), false, "the agent survived");
  await delay(100);
  assert.equal(isAlive(record.grandchildPid), false, "a descendant was orphaned");
});

test("a child that dies before settling is crashed, never a success", async (t) => {
  for (const [scenario, cause, exitCode] of [
    ["crash-before-ready", "child-exited-before-settled", 1],
    ["crash-mid-run", "child-exited-before-settled", 3],
  ]) {
    const lab = makeLab(t);
    const result = await runScenario(lab, scenario, { limits: FAST_LIMITS });
    const outcome = outcomeOf(result);
    assert.equal(outcome.outcome, "crashed", scenario);
    assert.equal(result.code, 30, scenario);
    assert.equal(outcome.detail.cause, cause, scenario);
    assert.equal(outcome.detail.childExitCode, exitCode, scenario);
  }
});

test("a child that cannot report its own state never gets a prompt", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "state-unavailable", { limits: FAST_LIMITS });
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "crashed");
  assert.equal(result.code, 30);
  assert.equal(outcome.detail.cause, "state-unavailable");
  assert.equal(outcome.detail.turns, 0);
});

test("stream EOF before agent_settled is crashed", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "eof-before-settled", { limits: FAST_LIMITS });
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "crashed");
  assert.equal(result.code, 30);
  assert.equal(outcome.detail.cause, "stream-ended-before-settled");
});

test("a broken stream fails closed, including after the terminal event", async (t) => {
  for (const scenario of [
    "malformed",
    "double-settled",
    "event-after-terminal",
    // Corruption after the terminal event still invalidates the run: it settled,
    // but the stream it was classified from was not trustworthy.
    "malformed-after-terminal",
    "torn-after-terminal",
  ]) {
    const lab = makeLab(t);
    const result = await runScenario(lab, scenario, { limits: FAST_LIMITS });
    const outcome = outcomeOf(result);
    assert.equal(outcome.outcome, "crashed", scenario);
    assert.equal(result.code, 30, scenario);
    assert.equal(outcome.detail.cause, "protocol-violation", scenario);
  }
});

test("separators inside a record and CRLF framing do not break a run", async (t) => {
  for (const scenario of ["separators", "crlf"]) {
    const lab = makeLab(t);
    const result = await runScenario(lab, scenario);
    assert.equal(outcomeOf(result).outcome, "settled-ok", scenario);
  }
});

test("stdin stays open until agent_settled", async (t) => {
  // Closing the write end early truncates the run silently at exit 0.
  const lab = makeLab(t);
  const result = await runScenario(lab, "slow-settle");
  assert.equal(outcomeOf(result).outcome, "settled-ok");
  assert.equal(readRecord(lab).stdinEndedBeforeSettle, false);
});

test("a child that ignores shutdown is still terminated", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "ignore-shutdown");
  assert.equal(outcomeOf(result).outcome, "settled-ok");
  assert.equal(isAlive(readRecord(lab).pid), false, "the agent was orphaned");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} to pix terminates the child and reports a non-success outcome`, async (t) => {
    const lab = makeLab(t);
    writeSpec(lab, {
      env: { PIX_TEST_SCENARIO: "idle-hang", PIX_TEST_RECORD: lab.record },
      limits: { startupTimeoutMs: 20_000, idleTimeoutMs: 20_000, wallClockTimeoutMs: 30_000 },
    });
    const result = await runPix(lab, ["run", "--spec", lab.specPath], {
      onSpawn: (child) => {
        const wait = setInterval(() => {
          if (!fs.existsSync(lab.record)) return;
          clearInterval(wait);
          child.kill(signal);
        }, 20);
      },
    });
    const outcome = outcomeOf(result);
    assert.equal(outcome.outcome, "cancelled");
    assert.equal(result.code, 12);
    assert.equal(outcome.detail.cause, "signal-received");
    assert.equal(isAlive(readRecord(lab).pid), false, "the agent was orphaned");
  });
}

test("the child is spawned with exactly the spec's cwd, tools, orders and flags", async (t) => {
  const lab = makeLab(t);
  fs.writeFileSync(lab.projectOrders, "PROJECT-ORDERS-MARKER\n");
  writeSpec(lab, {
    env: { PIX_TEST_SCENARIO: "settle-ok", PIX_TEST_RECORD: lab.record },
    prompt: {
      systemAppendFiles: [lab.orders, lab.projectOrders],
      systemAppendText: ["EXTRA-INLINE-ORDERS"],
    },
    tools: { allow: ["read", "grep", "find", "ls"] },
    model: { provider: "fake", id: "scripted-1", thinking: "high" },
  });
  await runPix(lab, ["run", "--spec", lab.specPath]);

  const record = readRecord(lab);
  assert.equal(record.cwd, fs.realpathSync(lab.worktree));
  assert.deepEqual(record.argv.slice(0, 8), [
    "--mode",
    "rpc",
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
  ]);
  assert.equal(record.argv[record.argv.indexOf("--model") + 1], "fake/scripted-1");
  assert.equal(record.argv[record.argv.indexOf("--thinking") + 1], "high");
  assert.equal(record.argv[record.argv.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(record.argv[record.argv.indexOf("--session-id") + 1], "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001");

  // Ordered system additions: files in spec order, then text.
  const appended = record.argv.reduce(
    (all, entry, index) =>
      record.argv[index - 1] === "--append-system-prompt" ? [...all, entry] : all,
    [],
  );
  assert.deepEqual(appended, [lab.orders, lab.projectOrders, "EXTRA-INLINE-ORDERS"]);
});

test("the child's environment is the safe base plus the spec allowlist and nothing else", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, {
    env: {
      PIX_TEST_SCENARIO: "settle-ok",
      PIX_TEST_RECORD: lab.record,
      SIANA_HOME: "/abs/.siana",
      SIANA_TASK_ID: "demo-task",
    },
  });
  await runPix(lab, ["run", "--spec", lab.specPath], {
    extra: { ANTHROPIC_API_KEY: FAKE_SECRETS.captainKey, GITHUB_TOKEN: "ghp_captain" },
  });

  const env = readRecord(lab).env;
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
  assert.equal(env.SIANA_HOME, "/abs/.siana");
  assert.equal(env.SIANA_TASK_ID, "demo-task");
  assert.equal(env.PI_OFFLINE, "1");
  assert.match(env.PI_CODING_AGENT_DIR, /state\/pi-x\/runs\/demo-task\//);
  assert.equal(JSON.stringify(env).includes("CAPTAIN-CREDENTIAL"), false);
});

test("run prints exactly one bounded outcome object and no trace unless asked", async (t) => {
  const lab = makeLab(t);
  const result = await runScenario(lab, "settle-ok");
  const outcome = outcomeOf(result);
  assert.deepEqual(Object.keys(outcome).sort(), ["detail", "outcome", "protocol", "task"]);
  assert.deepEqual(Object.keys(outcome.detail).sort(), [
    "branch",
    "cause",
    "childExitCode",
    "childSignal",
    "durationMs",
    "events",
    "lastStopReason",
    "piVersion",
    "project",
    "retries",
    "runId",
    "sessionFile",
    "sessionId",
    "toolCalls",
    "turns",
  ]);
  assert.equal(outcome.protocol, 1);
  assert.equal(outcome.task, lab.task);
  // The identity a caller needs to tie the run back to its task.
  assert.equal(outcome.detail.project, "pi-x");
  assert.equal(outcome.detail.branch, "siana/feat/demo-task");
  assert.equal(outcome.detail.piVersion, "0.84.2");
  assert.equal(fs.existsSync(lab.trace), false);
});

test("an explicit trace is written as valid JSONL in a harness envelope", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { env: { PIX_TEST_SCENARIO: "settle-ok", PIX_TEST_RECORD: lab.record } });
  const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", lab.trace]);
  assert.equal(outcomeOf(result).outcome, "settled-ok");

  const records = fs
    .readFileSync(lab.trace, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  assert.ok(records.length > 1);
  assert.deepEqual(
    records.map((record) => record.seq),
    records.map((_, index) => index + 1),
  );
  for (const record of records) {
    assert.equal(record.protocol, 1);
    assert.equal(record.task, lab.task);
    assert.match(record.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(["starting", "running", "settling", "terminal"].includes(record.phase));
  }
  assert.equal(records.at(-1).phase, "terminal");
  assert.equal(records.at(-1).outcome, "settled-ok");
});

test("a run leaves task-and-run isolated state outside the worktree", async (t) => {
  const lab = makeLab(t);
  await runScenario(lab, "settle-ok");
  const dirs = stateRunDirs(lab);
  assert.equal(dirs.length, 1);
  assert.equal(path.basename(path.dirname(dirs[0])), lab.task);
  assert.ok(fs.existsSync(path.join(dirs[0], "agent", "models.json")));
  assert.ok(fs.existsSync(path.join(dirs[0], "sessions")));
  assert.equal(fs.readdirSync(lab.worktree).length, 0, "state was written into the worktree");
});

test("a second run of the same task gets its own config and session state", async (t) => {
  const lab = makeLab(t);
  await runScenario(lab, "settle-ok");
  await runScenario(lab, "settle-ok");
  const dirs = stateRunDirs(lab);
  assert.equal(dirs.length, 2);
  assert.notEqual(dirs[0], dirs[1]);
});

test("a run sweeps expired state and leaves live and foreign state alone", async (t) => {
  const lab = makeLab(t);
  const runs = path.join(lab.state, "pi-x", "runs", "old-task");
  const expired = path.join(runs, "expired");
  const foreign = path.join(runs, "foreign");
  for (const [dir, marker] of [
    [expired, { owner: "pi-x", pid: 2_147_483_646 }],
    [foreign, { owner: "somebody-else", pid: 2_147_483_646 }],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(marker));
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
  }

  await runScenario(lab, "settle-ok");
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(foreign), true);
});
