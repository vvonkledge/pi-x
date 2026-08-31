// Preflight is where every "starts fine and is not fine" case Pi has is closed.
// Each refusal is asserted through the CLI, and each asserts that no agent ran.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FAKE_SECRETS,
  isUnder,
  makeLab,
  outcomeOf,
  runPix,
  worktreeAliases,
  writeSpec,
} from "./helpers/lab.mjs";

function refusedBy(result, check) {
  assert.equal(result.code, 40);
  const outcome = outcomeOf(result);
  assert.equal(outcome.outcome, "preflight-refused");
  assert.equal(outcome.detail.check, check, `reason was: ${outcome.detail.reason}`);
  assert.equal(typeof outcome.detail.reason, "string");
  return outcome;
}

function noAgentRan(lab) {
  assert.equal(fs.existsSync(lab.record), false, "an agent process was started");
}

test("a satisfiable spec passes preflight silently", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  const result = await runPix(lab, ["preflight", "--spec", lab.specPath]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  noAgentRan(lab);
});

test("a malformed spec is refused", async (t) => {
  const lab = makeLab(t);
  fs.writeFileSync(lab.specPath, "{not json");
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec");
  noAgentRan(lab);
});

test("an unknown spec field is refused rather than accepted as a misspelling", async (t) => {
  const lab = makeLab(t);
  const spec = writeSpec(lab);
  fs.writeFileSync(lab.specPath, JSON.stringify({ ...spec, tolls: { allow: ["read"] } }));
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.tolls");
  noAgentRan(lab);
});

test("a missing or non-absolute cwd is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { workspace: { cwd: path.join(lab.root, "absent") } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.workspace.cwd");

  writeSpec(lab, { workspace: { cwd: "relative/worktree" } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.workspace.cwd");
  noAgentRan(lab);
});

test("missing orders refuse rather than becoming literal prompt text", async (t) => {
  // Pi does not stat --append-system-prompt: a path that does not exist is
  // appended verbatim and the session starts normally at exit 0.
  const lab = makeLab(t);
  const absent = path.join(lab.root, "does-not-exist-orders.md");
  writeSpec(lab, { prompt: { systemAppendFiles: [absent] } });
  const outcome = refusedBy(
    await runPix(lab, ["preflight", "--spec", lab.specPath]),
    "spec.prompt.systemAppendFiles[0]",
  );
  assert.match(outcome.detail.reason, /does not exist/);
  noAgentRan(lab);
});

test("empty orders are refused", async (t) => {
  const lab = makeLab(t);
  const empty = path.join(lab.root, "empty-orders.md");
  fs.writeFileSync(empty, "");
  writeSpec(lab, { prompt: { systemAppendFiles: [lab.orders, empty] } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.prompt.systemAppendFiles[1]");
  noAgentRan(lab);
});

test("a spec with no model is refused; pix never falls back to a captain default", async (t) => {
  const lab = makeLab(t);
  const spec = writeSpec(lab);
  delete spec.model;
  fs.writeFileSync(lab.specPath, JSON.stringify(spec));
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.model");
  noAgentRan(lab);
});

test("an unresolvable model is refused before anything is created", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { model: { id: "nope-9000" }, env: { PIX_TEST_MODELS: "fake scripted-1" } });
  const outcome = refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "pi.models");
  assert.match(outcome.detail.reason, /does not resolve/);
  noAgentRan(lab);
});

test("an unusable credential is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { env: { PIX_TEST_READY: "no" } });
  const outcome = refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "pi.auth");
  assert.match(outcome.detail.reason, /not_ready/);
  noAgentRan(lab);
});

test("an unsupported Pi version is refused with the version observed", async (t) => {
  const lab = makeLab(t);
  for (const version of ["0.84.1", "0.85.0", "1.0.0", "0.83.9"]) {
    writeSpec(lab, { env: { PIX_TEST_VERSION: version } });
    const outcome = refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "pi.version");
    assert.match(outcome.detail.reason, new RegExp(`observed ${version.replace(/\./g, "\\.")}`));
    assert.match(outcome.detail.reason, />=0\.84\.2 <0\.85\.0/);
  }
  for (const version of ["0.84.2", "0.84.99"]) {
    writeSpec(lab, { env: { PIX_TEST_VERSION: version } });
    assert.equal((await runPix(lab, ["preflight", "--spec", lab.specPath])).code, 0);
  }
  noAgentRan(lab);
});

test("an invalid thinking level is refused; Pi would only warn and use its default", async (t) => {
  const lab = makeLab(t);
  const spec = writeSpec(lab);
  spec.model.thinking = "bogus";
  fs.writeFileSync(lab.specPath, JSON.stringify(spec));
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.model.thinking");
  noAgentRan(lab);
});

test("an invalid tool allowlist is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { tools: { allow: [] } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.tools.allow");
  noAgentRan(lab);
});

test("unsafe limits are refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { limits: { idleTimeoutMs: 0 } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.limits.idleTimeoutMs");
  noAgentRan(lab);
});

test("a credential-shaped environment key is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { env: { ANTHROPIC_API_KEY: "x" } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.env.ANTHROPIC_API_KEY");
  noAgentRan(lab);
});

test("a secret-like model value is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { model: { credentialCommand: `printf ${FAKE_SECRETS.providerKey}` } });
  refusedBy(await runPix(lab, ["preflight", "--spec", lab.specPath]), "spec.model.credentialCommand");
  noAgentRan(lab);
});

test("state inside the worktree is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  const result = await runPix(lab, ["preflight", "--spec", lab.specPath], {
    extra: { XDG_STATE_HOME: path.join(lab.worktree, "state") },
  });
  refusedBy(result, "state.root");
  noAgentRan(lab);
});

test("a trace inside the worktree is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  const result = await runPix(lab, [
    "run",
    "--spec",
    lab.specPath,
    "--trace",
    path.join(lab.worktree, "trace.jsonl"),
  ]);
  refusedBy(result, "trace.path");
  noAgentRan(lab);
  assert.equal(fs.existsSync(path.join(lab.worktree, "trace.jsonl")), false);
});

// The refusals above use the spelling of the worktree that the spec happens to
// carry. These use every other spelling of the same directory, because a guard
// that only knows the caller's spelling is not a guard. Evidence here is the
// worktree itself: it must still be empty afterwards, which no path predicate can
// talk its way out of.
//
// `run` rather than `preflight`, because a run is where the trace, the run
// directory, the model snapshot and the session would be written.

test("a trace under any other spelling of the worktree is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  const aliases = worktreeAliases(lab);
  assert.ok(aliases.length > 0, "this filesystem offered no second spelling to test");

  for (const { label, spelling } of aliases) {
    const result = await runPix(lab, [
      "run",
      "--spec",
      lab.specPath,
      "--trace",
      path.join(spelling, "trace.jsonl"),
    ]);
    refusedBy(result, "trace.path");
    noAgentRan(lab);
    assert.deepEqual(fs.readdirSync(lab.worktree), [], `${label} wrote into the worktree`);
  }
});

test("a state root under any other spelling of the worktree is refused", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  const aliases = worktreeAliases(lab);
  assert.ok(aliases.length > 0, "this filesystem offered no second spelling to test");

  for (const { label, spelling } of aliases) {
    const result = await runPix(lab, ["run", "--spec", lab.specPath], {
      extra: { XDG_STATE_HOME: path.join(spelling, "state") },
    });
    refusedBy(result, "state.root");
    noAgentRan(lab);
    assert.deepEqual(fs.readdirSync(lab.worktree), [], `${label} wrote into the worktree`);
  }
});

test("the aliases a filesystem cannot provide are named rather than assumed", (t) => {
  const lab = makeLab(t);
  const labels = worktreeAliases(lab).map((alias) => alias.label);
  assert.ok(labels.includes("symlink"), "a symlink alias is available on every platform");
  // The other two exist only where the platform provides them. Recorded so a run
  // on a case-sensitive filesystem, or one without the /private prefix, says what
  // it did not exercise instead of reporting coverage it did not have.
  t.diagnostic(`worktree aliases exercised: ${labels.join(", ")}`);
});

test("a trace and a state root beside the worktree are still accepted", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  // A sibling whose name has the worktree's name as a prefix, and a state root
  // one level up: both are outside, and neither may be refused.
  const sibling = path.join(lab.root, `${path.basename(lab.worktree)}-sibling`);
  fs.mkdirSync(sibling, { recursive: true });
  const trace = path.join(sibling, "trace.jsonl");

  const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", trace]);
  assert.equal(result.code, 0);
  assert.equal(outcomeOf(result).outcome, "settled-ok");
  assert.ok(fs.statSync(trace).size > 0);
  assert.equal(isUnder(lab.worktree, trace), false);
});

test("a refusal names the check but never the offending value", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab, { env: { MY_API_KEY: FAKE_SECRETS.providerKey } });
  const result = await runPix(lab, ["preflight", "--spec", lab.specPath]);
  assert.equal(result.stdout.includes(FAKE_SECRETS.providerKey), false);
  refusedBy(result, "spec.env.MY_API_KEY");
});

test("the CLI refuses an unknown command, a missing spec and a relative path", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  refusedBy(await runPix(lab, ["sprint", "--spec", lab.specPath]), "cli");
  refusedBy(await runPix(lab, ["run"]), "cli");
  refusedBy(await runPix(lab, ["run", "--spec", "spec.json"]), "cli");
  refusedBy(await runPix(lab, ["run", "--spec", lab.specPath, "--wat"]), "cli");
  refusedBy(await runPix(lab, ["run", "--spec", path.join(lab.root, "absent.json")]), "spec");
  noAgentRan(lab);
});

test("a probe that cannot run refuses on both commands, never crashes one", async (t) => {
  // `run` must stay inside the closed outcome table even when the failure is in
  // the harness's own preconditions rather than in a run.
  const lab = makeLab(t);
  writeSpec(lab, { env: { PIX_TEST_BROKEN: "yes" } });

  for (const command of ["preflight", "run"]) {
    const result = await runPix(lab, [command, "--spec", lab.specPath]);
    const outcome = refusedBy(result, "pi.version");
    assert.equal(outcome.task, lab.task);
    // The reason is authored by the harness: it names what happened, and it
    // carries none of the probe's own output.
    assert.match(outcome.detail.reason, /pi exited 9/);
    assert.equal(result.stdout.includes("PROBE-STDERR-MARKER"), false);
    assert.ok(result.stdout.length < 1_024, `outcome was ${result.stdout.length} bytes`);
  }
  noAgentRan(lab);
});

test("a trace that cannot be opened refuses rather than crashing the run", async (t) => {
  const lab = makeLab(t);
  writeSpec(lab);
  for (const trace of [
    // The parent is a file, so the trace directory cannot be made.
    path.join(lab.orders, "trace.jsonl"),
    // The path is an existing directory, which only fails when it is opened.
    lab.home,
  ]) {
    const result = await runPix(lab, ["run", "--spec", lab.specPath, "--trace", trace]);
    const outcome = refusedBy(result, "trace.path");
    assert.match(outcome.detail.reason, /cannot be opened/);
  }
  noAgentRan(lab);
});
