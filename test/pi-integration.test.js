// Everything that must be true of the real Pi, run offline against a scripted
// transport. These are the cases where a test double would prove nothing:
// prompt assembly, the tool registry, provider failure at exit 0, and what a
// default spawn would have inherited from the captain.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CREDENTIAL_PLACEHOLDER,
  isUnder,
  makeLab,
  outcomeOf,
  populateCaptainHome,
  runPix,
  stateRunDirs,
  writeSpec,
} from "./helpers/lab.mjs";
import { startScriptedProvider, textTurn, toolCallTurn } from "./helpers/scripted-provider.mjs";

const REAL = { real: true };

function traceRecords(lab) {
  return fs
    .readFileSync(lab.trace, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("a real run settles ok and reports the Pi version it observed", async (t) => {
  const lab = makeLab(t);
  const provider = await startScriptedProvider(t, { turns: [textTurn("done")] });
  writeSpec(lab, { model: { providerConfig: provider.providerConfig() } });

  const result = await runPix(lab, ["run", "--spec", lab.specPath], REAL);
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "settled-ok");
  assert.equal(result.code, 0);
  assert.equal(outcome.detail.piVersion, "0.84.2");
  assert.equal(outcome.detail.lastStopReason, "stop");

  // The session lives outside the worktree and is findable from the outcome.
  // Resolved containment, not a string prefix: one directory has several valid
  // spellings, so a prefix comparison is not evidence about where the file is.
  assert.ok(fs.existsSync(outcome.detail.sessionFile));
  assert.equal(isUnder(lab.worktree, outcome.detail.sessionFile), false);
  assert.equal(fs.readdirSync(lab.worktree).length, 0);
});

test("the model receives exactly the spec's orders, message and tools", async (t) => {
  const lab = makeLab(t);
  const provider = await startScriptedProvider(t, { turns: [textTurn("done")] });
  writeSpec(lab, {
    model: { providerConfig: provider.providerConfig() },
    prompt: {
      systemAppendFiles: [lab.orders, lab.projectOrders],
      systemAppendText: ["INLINE-ORDERS-MARKER"],
      initialMessage: "Take your task.",
    },
    tools: { allow: ["read", "bash", "edit"] },
  });

  assert.equal(outcomeOf(await runPix(lab, ["run", "--spec", lab.specPath], REAL)).outcome, "settled-ok");

  const request = provider.seen[0].body;
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["read", "bash", "edit"]);

  const system = request.messages[0].content;
  const fleet = system.indexOf("FLEET-ORDERS-MARKER");
  const project = system.indexOf("PROJECT-ORDERS-MARKER");
  const inline = system.indexOf("INLINE-ORDERS-MARKER");
  assert.ok(fleet > -1 && project > fleet && inline > project, "orders must appear in spec order");

  assert.deepEqual(request.messages.slice(1), [
    { role: "user", content: [{ type: "text", text: "Take your task." }] },
  ]);
});

test("a fabricated call to a tool outside the allowlist executes nothing", async (t) => {
  const lab = makeLab(t);
  const evidence = path.join(lab.root, "escaped.txt");
  const provider = await startScriptedProvider(t, {
    turns: [toolCallTurn("bash", { command: `touch ${evidence}` }), textTurn("done")],
  });
  writeSpec(lab, {
    model: { providerConfig: provider.providerConfig() },
    tools: { allow: ["read"] },
  });

  const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", lab.trace], REAL);
  assert.equal(outcomeOf(result).outcome, "settled-ok");

  // The allowlist is enforced at Pi's tool registry, not in the prompt, so a
  // model that invents a tool name cannot escape it.
  assert.deepEqual(provider.seen[0].body.tools.map((tool) => tool.function.name), ["read"]);
  const refusal = traceRecords(lab).find((record) => record.pi?.type === "tool_execution_end");
  assert.equal(refusal.pi.isError, true);
  assert.match(refusal.pi.result.content[0].text, /Tool bash not found/);
  assert.equal(fs.existsSync(evidence), false, "a disallowed tool executed");
});

test("a total provider failure is settled-error, not the success Pi's exit code claims", async (t) => {
  const lab = makeLab(t);
  const provider = await startScriptedProvider(t, { turns: [], status: 500 });
  writeSpec(lab, {
    model: { providerConfig: provider.providerConfig() },
    limits: { startupTimeoutMs: 30_000, idleTimeoutMs: 30_000, wallClockTimeoutMs: 120_000 },
  });

  const result = await runPix(lab, ["run", "--spec", lab.specPath], REAL);
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "settled-error");
  assert.equal(result.code, 10);
  assert.equal(outcome.detail.lastStopReason, "error");
  // Pi exhausts its retries and then exits 0 exactly as a healthy run does.
  assert.equal(outcome.detail.childExitCode, 0);
  assert.ok(outcome.detail.retries > 0);
});

test("nothing from the captain's Pi configuration crosses the boundary", async (t) => {
  const lab = makeLab(t);
  const captain = populateCaptainHome(lab);
  const provider = await startScriptedProvider(t, { turns: [textTurn("done")] });
  writeSpec(lab, { model: { providerConfig: provider.providerConfig() } });

  const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", lab.trace], REAL);
  assert.equal(outcomeOf(result).outcome, "settled-ok");

  // The model came from the spec, never from the captain's interactive defaults.
  assert.equal(provider.seen[0].body.model, "scripted-1");
  const seen = JSON.stringify(provider.seen);
  const trace = fs.readFileSync(lab.trace, "utf8");
  for (const marker of captain.markers) {
    assert.equal(seen.includes(marker), false, `${marker} reached the model`);
    assert.equal(trace.includes(marker), false, `${marker} reached the trace`);
    assert.equal(result.stdout.includes(marker), false, `${marker} reached stdout`);
  }

  // The generated config directory carries the model reference plus the empty
  // stores Pi opens for itself, and no captain package, extension, skill,
  // prompt template, theme, model preference or credential.
  const agentDir = path.join(stateRunDirs(lab)[0], "agent");
  assert.deepEqual(fs.readdirSync(agentDir).sort(), ["auth.json", "models-store.json", "models.json"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")), {});
  const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
  assert.deepEqual(Object.keys(models.providers), ["fake"]);
  for (const name of fs.readdirSync(agentDir)) {
    const contents = fs.readFileSync(path.join(agentDir, name), "utf8");
    for (const marker of captain.markers) {
      assert.equal(contents.includes(marker), false, `${marker} reached ${name}`);
    }
  }
});

test("the credential is a reference everywhere pix writes and a header only at the provider", async (t) => {
  const lab = makeLab(t);
  const provider = await startScriptedProvider(t, { turns: [textTurn("done")] });
  writeSpec(lab, { model: { providerConfig: provider.providerConfig() } });

  const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", lab.trace], REAL);
  assert.equal(outcomeOf(result).outcome, "settled-ok");

  // Pi resolved the command at request time and sent the result as a header.
  assert.equal(provider.seen[0].authorization, `Bearer ${CREDENTIAL_PLACEHOLDER}`);

  const models = fs.readFileSync(path.join(stateRunDirs(lab)[0], "agent", "models.json"), "utf8");
  assert.match(JSON.parse(models).providers.fake.apiKey, /^!/);
  for (const [what, text] of [
    ["the generated config", models],
    ["the spec", fs.readFileSync(lab.specPath, "utf8")],
    ["stdout", result.stdout],
    ["stderr", result.stderr],
    ["the trace", fs.readFileSync(lab.trace, "utf8")],
  ]) {
    assert.equal(text.includes(CREDENTIAL_PLACEHOLDER), false, `the credential reached ${what}`);
  }
});

test("no credential and no session state reach the child's argv", async (t) => {
  const lab = makeLab(t);
  const provider = await startScriptedProvider(t, { turns: [textTurn("done")] });
  writeSpec(lab, { model: { providerConfig: provider.providerConfig() } });
  await runPix(lab, ["run", "--spec", lab.specPath, "--trace", lab.trace], REAL);

  // argv is world readable through ps, which is why the spec is a file.
  const { childArgs } = await import("../src/run.js");
  const { validateSpec } = await import("../src/spec.js");
  const spec = validateSpec(JSON.parse(fs.readFileSync(lab.specPath, "utf8")));
  const args = childArgs(spec, { sessionDir: "/state/sessions" });
  assert.equal(args.includes("--api-key"), false);
  assert.equal(args.join(" ").includes(CREDENTIAL_PLACEHOLDER), false);
  assert.equal(args.join(" ").includes(spec.model.credentialCommand), false);
});

test("concurrent runs share no config, credential, cwd, session or provider", async (t) => {
  const first = makeLab(t, { task: "task-one" });
  const second = makeLab(t, { task: "task-two" });
  // One state root, so isolation is the harness's doing and not the fixture's.
  const shared = { extra: { XDG_STATE_HOME: first.state }, real: true };

  fs.writeFileSync(path.join(first.worktree, "who.txt"), "ONE\n");
  fs.writeFileSync(path.join(second.worktree, "who.txt"), "TWO\n");

  const providers = await Promise.all([
    startScriptedProvider(t, { turns: [toolCallTurn("read", { path: "who.txt" }), textTurn("one")] }),
    startScriptedProvider(t, { turns: [toolCallTurn("read", { path: "who.txt" }), textTurn("two")] }),
  ]);
  for (const [index, lab] of [first, second].entries()) {
    writeSpec(lab, {
      model: { providerConfig: providers[index].providerConfig() },
      tools: { allow: ["read"] },
    });
  }

  const results = await Promise.all([
    runPix(first, ["run", "--spec", first.specPath, "--trace", first.trace], shared),
    runPix(second, ["run", "--spec", second.specPath, "--trace", second.trace], shared),
  ]);

  const outcomes = results.map((result) => outcomeOf(result));
  for (const outcome of outcomes) {
    assert.equal(outcome.outcome, "settled-ok");
    assert.equal(outcome.detail.toolCalls, 1);
  }
  assert.notEqual(outcomes[0].detail.sessionFile, outcomes[1].detail.sessionFile);
  assert.notEqual(outcomes[0].detail.runId, outcomes[1].detail.runId);

  // Each agent read only its own worktree, and neither session or trace carries
  // the other's content.
  assert.match(fs.readFileSync(first.trace, "utf8"), /ONE/);
  assert.equal(fs.readFileSync(first.trace, "utf8").includes("TWO"), false);
  assert.match(fs.readFileSync(second.trace, "utf8"), /TWO/);
  assert.equal(fs.readFileSync(second.trace, "utf8").includes("ONE"), false);
  for (const [index, outcome] of outcomes.entries()) {
    const session = fs.readFileSync(outcome.detail.sessionFile, "utf8");
    assert.match(session, index === 0 ? /ONE/ : /TWO/);
    assert.equal(session.includes(index === 0 ? "TWO" : "ONE"), false);
  }
});
