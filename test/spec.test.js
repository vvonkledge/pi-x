import assert from "node:assert/strict";
import test from "node:test";

import { Refusal } from "../src/outcome.js";
import { DEFAULT_CREDENTIAL_COMMAND, THINKING_LEVELS, validateSpec } from "../src/spec.js";
import { FAKE_SECRETS } from "./helpers/lab.mjs";

const VALID = Object.freeze({
  protocol: 1,
  identity: { task: "demo-task", project: "pi-x", branch: "siana/feat/demo-task" },
  workspace: { cwd: "/abs/worktree" },
  prompt: {
    systemAppendFiles: ["/abs/orders.md"],
    systemAppendText: [],
    initialMessage: "Take your task.",
  },
  model: { provider: "anthropic", id: "claude-opus-4-5", thinking: "high" },
  tools: { allow: ["read", "bash"] },
  env: { SIANA_HOME: "/abs/.siana" },
  limits: { startupTimeoutMs: 60_000, idleTimeoutMs: 900_000, wallClockTimeoutMs: 14_400_000 },
  session: { id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" },
});

function spec(overrides) {
  return structuredClone({ ...VALID, ...overrides });
}

function refusal(raw) {
  try {
    validateSpec(raw);
  } catch (error) {
    assert.ok(error instanceof Refusal, `expected a Refusal, got ${error}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the spec to be refused" });
}

test("a complete spec validates and defaults the credential reference", () => {
  const parsed = validateSpec(spec());
  assert.equal(parsed.protocol, 1);
  assert.equal(parsed.model.credentialCommand, DEFAULT_CREDENTIAL_COMMAND);
  assert.equal(parsed.model.providerConfig, null);
  assert.deepEqual(parsed.prompt.systemAppendText, []);
});

test("an unknown field is refused rather than ignored", () => {
  assert.equal(refusal({ ...spec(), extra: 1 }).check, "spec.extra");
  assert.equal(
    refusal(spec({ model: { ...VALID.model, temperature: 0.5 } })).check,
    "spec.model.temperature",
  );
  // A misspelling must refuse, not silently fall back to a default.
  assert.equal(
    refusal(spec({ limits: { ...VALID.limits, idleTimoutMs: 1000 } })).check,
    "spec.limits.idleTimoutMs",
  );
});

test("a wrong protocol is refused", () => {
  assert.equal(refusal(spec({ protocol: 2 })).check, "spec.protocol");
});

test("a required section cannot be omitted", () => {
  const raw = spec();
  delete raw.model;
  assert.equal(refusal(raw).check, "spec.model");
});

test("cwd must be an absolute normalized path", () => {
  assert.equal(refusal(spec({ workspace: { cwd: "worktree" } })).check, "spec.workspace.cwd");
  assert.equal(refusal(spec({ workspace: { cwd: "/abs/../x" } })).check, "spec.workspace.cwd");
  assert.equal(refusal(spec({ workspace: { cwd: "/abs/x/" } })).check, "spec.workspace.cwd");
});

test("orders are required and must be absolute", () => {
  assert.equal(
    refusal(spec({ prompt: { ...VALID.prompt, systemAppendFiles: [] } })).check,
    "spec.prompt.systemAppendFiles",
  );
  assert.equal(
    refusal(spec({ prompt: { ...VALID.prompt, systemAppendFiles: ["orders.md"] } })).check,
    "spec.prompt.systemAppendFiles[0]",
  );
});

test("an empty initial message is refused", () => {
  assert.equal(
    refusal(spec({ prompt: { ...VALID.prompt, initialMessage: "" } })).check,
    "spec.prompt.initialMessage",
  );
});

test("every documented thinking level is accepted and nothing else is", () => {
  for (const thinking of THINKING_LEVELS) {
    assert.equal(validateSpec(spec({ model: { ...VALID.model, thinking } })).model.thinking, thinking);
  }
  // Pi only warns on an unknown level and then silently uses its default.
  assert.equal(refusal(spec({ model: { ...VALID.model, thinking: "bogus" } })).check, "spec.model.thinking");
  assert.equal(refusal(spec({ model: { ...VALID.model, thinking: "HIGH" } })).check, "spec.model.thinking");
});

test("the tool allowlist must be a non-empty list of unique names", () => {
  assert.equal(refusal(spec({ tools: { allow: [] } })).check, "spec.tools.allow");
  assert.equal(refusal(spec({ tools: { allow: ["read", "read"] } })).check, "spec.tools.allow[1]");
  assert.equal(refusal(spec({ tools: { allow: ["read; rm -rf /"] } })).check, "spec.tools.allow[0]");
});

test("credential-shaped environment keys are refused, never forwarded", () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_TOKEN", "MY_SECRET", "DB_PASSWORD", "GH_AUTH"]) {
    assert.equal(refusal(spec({ env: { [key]: "x" } })).check, `spec.env.${key}`);
  }
});

test("environment keys pix sets itself are refused", () => {
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "PI_CODING_AGENT_DIR", "PI_OFFLINE"]) {
    assert.equal(refusal(spec({ env: { [key]: "x" } })).check, `spec.env.${key}`);
  }
});

test("a secret-shaped value is refused wherever it is pasted", () => {
  assert.equal(
    refusal(spec({ model: { ...VALID.model, credentialCommand: `printf ${FAKE_SECRETS.providerKey}` } })).check,
    "spec.model.credentialCommand",
  );
  assert.equal(
    refusal(spec({ model: { ...VALID.model, id: FAKE_SECRETS.opaque } })).check,
    "spec.model.id",
  );
  assert.equal(refusal(spec({ env: { SIANA_HOME: "token=abcdefghijkl" } })).check, "spec.env.SIANA_HOME");
});

test("Pi's own credential resolution syntax is refused in the credential command", () => {
  for (const command of ["!security find-generic-password", "$ANTHROPIC_KEY"]) {
    assert.equal(
      refusal(spec({ model: { ...VALID.model, credentialCommand: command } })).check,
      "spec.model.credentialCommand",
    );
  }
});

test("a provider config may not carry a credential-bearing field", () => {
  for (const key of ["apiKey", "headers", "oauth"]) {
    const parsed = refusal(
      spec({ model: { ...VALID.model, providerConfig: { baseUrl: "http://127.0.0.1:1/v1", [key]: "x" } } }),
    );
    assert.equal(parsed.check, `spec.model.providerConfig.${key}`);
    assert.match(parsed.reason, /credential/);
  }
  assert.equal(
    refusal(spec({ model: { ...VALID.model, providerConfig: { nope: 1 } } })).check,
    "spec.model.providerConfig.nope",
  );
});

test("limits must be safe integers inside documented bounds", () => {
  for (const [key, value] of [
    ["startupTimeoutMs", 0],
    ["startupTimeoutMs", -1],
    ["idleTimeoutMs", 1.5],
    ["wallClockTimeoutMs", 10_000_000_000],
    ["idleTimeoutMs", "900000"],
  ]) {
    assert.equal(refusal(spec({ limits: { ...VALID.limits, [key]: value } })).check, `spec.limits.${key}`);
  }
  assert.equal(
    refusal(
      spec({ limits: { startupTimeoutMs: 60_000, idleTimeoutMs: 1_000, wallClockTimeoutMs: 1_000 } }),
    ).check,
    "spec.limits.wallClockTimeoutMs",
  );
});

test("identity and session ids must be safe path segments", () => {
  assert.equal(
    refusal(spec({ identity: { ...VALID.identity, task: "../escape" } })).check,
    "spec.identity.task",
  );
  assert.equal(refusal(spec({ session: { id: "a/b" } })).check, "spec.session.id");
});
