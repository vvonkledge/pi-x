import assert from "node:assert/strict";
import test from "node:test";

import { buildChildEnv } from "../src/child-env.js";
import { looksLikeCredentialKey } from "../src/secrets.js";
import { FAKE_SECRETS } from "./helpers/lab.mjs";

const CAPTAIN_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/captain",
  TERM: "xterm",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  TZ: "UTC",
  ANTHROPIC_API_KEY: FAKE_SECRETS.captainKey,
  OPENAI_API_KEY: FAKE_SECRETS.otherCaptainKey,
  GITHUB_TOKEN: "ghp_CAPTAIN",
  PI_CODING_AGENT_DIR: "/Users/captain/.pi/agent",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
  AWS_SECRET_ACCESS_KEY: "captain",
};

test("only the safe base survives from the harness environment", () => {
  const env = buildChildEnv({
    processEnv: CAPTAIN_ENV,
    specEnv: {},
    agentDir: "/state/pi-x/runs/t/r/agent",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "HOME",
    "LANG",
    "LC_CTYPE",
    "PATH",
    "PI_CODING_AGENT_DIR",
    "PI_OFFLINE",
    "TERM",
    "TZ",
  ]);
});

test("no credential in the harness environment reaches the child", () => {
  const env = buildChildEnv({
    processEnv: CAPTAIN_ENV,
    specEnv: { SIANA_TASK_ID: "demo-task" },
    agentDir: "/state/agent",
  });
  for (const key of Object.keys(env)) {
    assert.ok(!looksLikeCredentialKey(key), `${key} should not reach the child`);
  }
  for (const value of Object.values(env)) {
    assert.ok(!value.includes("CAPTAIN-CREDENTIAL"), "a captain credential leaked");
  }
});

test("the captain's Pi directory is replaced, never inherited", () => {
  const env = buildChildEnv({
    processEnv: CAPTAIN_ENV,
    specEnv: {},
    agentDir: "/state/pi-x/runs/t/r/agent",
  });
  assert.equal(env.PI_CODING_AGENT_DIR, "/state/pi-x/runs/t/r/agent");
  assert.equal(env.PI_OFFLINE, "1");
});

test("the spec allowlist is passed through exactly", () => {
  const specEnv = {
    SIANA_HOME: "/Users/captain/.siana",
    SIANA_TASKS_FILE: "/Users/captain/.siana/tasks.jsonl",
    SIANA_TASK_ID: "demo-task",
  };
  const env = buildChildEnv({ processEnv: CAPTAIN_ENV, specEnv, agentDir: "/state/agent" });
  for (const [key, value] of Object.entries(specEnv)) {
    assert.equal(env[key], value);
  }
});

test("a missing base variable is omitted rather than set empty", () => {
  const env = buildChildEnv({ processEnv: { PATH: "/usr/bin" }, specEnv: {}, agentDir: "/a" });
  assert.equal("HOME" in env, false);
  assert.equal("TERM" in env, false);
});
