#!/usr/bin/env node
// A scripted `pi`. Process lifecycle failures - a child that never becomes
// ready, goes silent, streams forever, dies, or breaks the JSONL framing -
// cannot be produced on demand from a real Pi, so they are produced here.
//
// It is configured through PIX_TEST_* variables, which a spec passes on its
// bounded env allowlist, so it also proves the allowlist reaches the child.

import { spawn } from "node:child_process";
import fs from "node:fs";

const argv = process.argv.slice(2);

// A broken install: on PATH, executable, and failing every probe. This is the
// shape that must reach the caller as a refusal rather than a crash.
if (process.env.PIX_TEST_BROKEN === "yes") {
  // Loud on stderr, so a test can prove none of it reaches the outcome object.
  process.stderr.write(`PROBE-STDERR-MARKER ${"x".repeat(200_000)}\n`);
  process.exit(9);
}

if (argv[0] === "--version") {
  process.stdout.write(`${process.env.PIX_TEST_VERSION ?? "0.84.2"}\n`);
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "check") {
  const provider = argv[argv.indexOf("--provider") + 1];
  if ((process.env.PIX_TEST_READY ?? "yes") === "yes") {
    process.stdout.write(`${JSON.stringify({ status: "ready", provider, authType: "api_key" })}\n`);
    process.exit(0);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "not_ready", provider, reason: "credentials_not_configured" })}\n`,
  );
  process.exit(1);
}

if (argv[0] === "--list-models") {
  const rows = (process.env.PIX_TEST_MODELS ?? "fake scripted-1")
    .split(";")
    .filter((row) => row !== "");
  if (rows.length === 0) {
    process.stdout.write('No models matching "x"\n');
    process.exit(0);
  }
  process.stdout.write("provider  model  context  max-out  thinking  images\n");
  for (const row of rows) {
    const [provider, model] = row.split(" ");
    process.stdout.write(`${provider}  ${model}  100K  4.1K  no  no\n`);
  }
  process.exit(0);
}

record({ argv, cwd: process.cwd(), env: { ...process.env }, pid: process.pid });
await rpc(process.env.PIX_TEST_SCENARIO ?? "settle-ok");

async function rpc(scenario) {
  let stdinEnded = false;
  let settled = false;
  process.stdin.on("end", () => {
    stdinEnded = true;
    patch({ stdinEndedBeforeSettle: !settled });
  });
  process.stdin.resume();

  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const respond = (id, command, success = true) =>
    emit({ id, type: "response", command, success });
  const assistant = (stopReason) =>
    emit({ type: "message_end", message: { role: "assistant", stopReason } });
  const settle = () => {
    settled = true;
    emit({ type: "agent_settled" });
  };

  if (scenario === "startup-hang") {
    await never();
    return;
  }
  if (scenario === "malformed") {
    process.stdout.write("this is not json\n");
    await never();
    return;
  }

  await command("get_state");
  if (scenario === "crash-before-ready") process.exit(1);
  if (scenario === "state-unavailable") {
    respond("state", "get_state", false);
    await never();
    return;
  }
  respond("state", "get_state");

  if (scenario === "wall-forever") {
    for (;;) {
      emit({ type: "message_update" });
      await delay(20);
    }
  }

  const prompt = await command("prompt");
  if (scenario === "reject-prompt") {
    respond(prompt.id, "prompt", false);
    await never();
    return;
  }
  respond(prompt.id, "prompt");

  if (scenario === "idle-hang") {
    await never();
    return;
  }
  if (scenario === "crash-mid-run") {
    emit({ type: "agent_start" });
    process.exit(3);
  }
  if (scenario === "eof-before-settled") {
    emit({ type: "agent_start" });
    process.stdout.end();
    await never();
    return;
  }
  if (scenario === "descendants") {
    // A grandchild in the same process group, like the shell a minion runs.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    patch({ grandchildPid: grandchild.pid });
    await never();
    return;
  }
  if (scenario === "separators") {
    // U+2028 and U+2029 inside a JSON string. A generic line reader tears this
    // record in half; a strict LF reader does not.
    emit({ type: "message_update", note: "line sep end" });
  }
  if (scenario === "crlf") {
    process.stdout.write(`${JSON.stringify({ type: "agent_start" })}\r\n`);
  }
  if (scenario === "slow-settle") {
    await delay(400);
  }

  emit({ type: "turn_end" });
  if (scenario !== "settle-no-assistant") {
    assistant(stopReasonFor(scenario));
  }
  settle();

  if (scenario === "double-settled") emit({ type: "agent_settled" });
  if (scenario === "event-after-terminal") emit({ type: "agent_end" });
  if (scenario === "malformed-after-terminal") process.stdout.write("garbled\n");
  if (scenario === "torn-after-terminal") {
    process.stdout.write('{"type":"agent_end"');
    process.stdout.end();
  }
  if (scenario === "ignore-shutdown") {
    await never();
    return;
  }
  await waitFor(() => stdinEnded);
  process.exit(0);
}

function stopReasonFor(scenario) {
  if (scenario === "settle-error") return "error";
  if (scenario === "settle-truncated") return "length";
  if (scenario === "settle-aborted") return "aborted";
  if (scenario === "settle-tooluse") return "toolUse";
  return "stop";
}

function command(type) {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      for (;;) {
        const lf = buffer.indexOf("\n");
        if (lf === -1) return;
        const line = buffer.slice(0, lf);
        buffer = buffer.slice(lf + 1);
        if (line === "") continue;
        const parsed = JSON.parse(line);
        if (parsed.type !== type) continue;
        process.stdin.off("data", onData);
        resolve(parsed);
        return;
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

function record(entry) {
  if (!process.env.PIX_TEST_RECORD) return;
  fs.writeFileSync(process.env.PIX_TEST_RECORD, `${JSON.stringify(entry, null, 2)}\n`);
}

function patch(fields) {
  if (!process.env.PIX_TEST_RECORD) return;
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(process.env.PIX_TEST_RECORD, "utf8"));
  } catch {
    current = {};
  }
  fs.writeFileSync(
    process.env.PIX_TEST_RECORD,
    `${JSON.stringify({ ...current, ...fields }, null, 2)}\n`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate) {
  while (!predicate()) await delay(10);
}

function never() {
  return new Promise(() => {});
}
