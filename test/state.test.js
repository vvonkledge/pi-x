import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunState,
  isInside,
  RETENTION_DAYS,
  runsRoot,
  stateRoot,
  sweepRetention,
} from "../src/state.js";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pix-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function plantRun(root, { task, runId, marker, ageDays }) {
  const dir = path.join(runsRoot(root), task, runId);
  fs.mkdirSync(dir, { recursive: true });
  if (marker !== null) {
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(marker));
  }
  fs.writeFileSync(path.join(dir, "payload"), "x");
  if (ageDays !== undefined) {
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, when, when);
  }
  return dir;
}

const DEAD_PID = 2_147_483_646;

test("the state root follows XDG_STATE_HOME and falls back outside any worktree", () => {
  assert.equal(stateRoot({ XDG_STATE_HOME: "/abs/state" }), path.join("/abs/state", "pi-x"));
  assert.equal(stateRoot({}), path.join(os.homedir(), ".local", "state", "pi-x"));
  // A relative XDG value could resolve inside whatever directory pix was run in.
  assert.equal(stateRoot({ XDG_STATE_HOME: "state" }), path.join(os.homedir(), ".local", "state", "pi-x"));
});

test("isInside recognises a path under a worktree", () => {
  assert.equal(isInside("/w", "/w/state"), true);
  assert.equal(isInside("/w", "/w"), true);
  assert.equal(isInside("/w", "/other/state"), false);
  assert.equal(isInside("/w", "/worktree-sibling"), false);
});

test("a run gets its own config and session directories and a pix-owned marker", (t) => {
  const root = tempRoot(t);
  const first = createRunState({ root, task: "demo", runId: "run-1", pid: process.pid });
  const second = createRunState({ root, task: "demo", runId: "run-2", pid: process.pid });

  assert.notEqual(first.agentDir, second.agentDir);
  assert.notEqual(first.sessionDir, second.sessionDir);
  assert.ok(fs.statSync(first.agentDir).isDirectory());
  assert.ok(fs.statSync(first.sessionDir).isDirectory());

  const marker = JSON.parse(fs.readFileSync(path.join(first.dir, "run.json"), "utf8"));
  assert.equal(marker.owner, "pi-x");
  assert.equal(marker.task, "demo");
  assert.equal(marker.pid, process.pid);
});

test("retention removes expired pix state and nothing else", (t) => {
  const root = tempRoot(t);
  const expired = plantRun(root, {
    task: "demo",
    runId: "expired",
    marker: { owner: "pi-x", pid: DEAD_PID },
    ageDays: RETENTION_DAYS + 1,
  });
  const recent = plantRun(root, {
    task: "demo",
    runId: "recent",
    marker: { owner: "pi-x", pid: DEAD_PID },
    ageDays: 1,
  });

  const swept = sweepRetention(root);
  assert.deepEqual(swept.removed, [expired]);
  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(recent), true);
});

test("retention refuses live state even when it is old", (t) => {
  const root = tempRoot(t);
  const live = plantRun(root, {
    task: "demo",
    runId: "live",
    marker: { owner: "pi-x", pid: process.pid },
    ageDays: RETENTION_DAYS + 10,
  });

  const swept = sweepRetention(root);
  assert.deepEqual(swept.removed, []);
  assert.ok(swept.kept.some((entry) => entry.dir === live && entry.reason === "live"));
  assert.equal(fs.existsSync(live), true);
});

test("retention refuses ambiguous state it does not own", (t) => {
  const root = tempRoot(t);
  const unmarked = plantRun(root, { task: "demo", runId: "unmarked", marker: null, ageDays: 400 });
  const foreign = plantRun(root, {
    task: "demo",
    runId: "foreign",
    marker: { owner: "somebody-else", pid: DEAD_PID },
    ageDays: 400,
  });
  const malformed = path.join(runsRoot(root), "demo", "malformed");
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, "run.json"), "{not json");
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  fs.utimesSync(malformed, old, old);

  const swept = sweepRetention(root);
  assert.deepEqual(swept.removed, []);
  for (const dir of [unmarked, foreign, malformed]) {
    assert.equal(fs.existsSync(dir), true);
    assert.ok(swept.kept.some((entry) => entry.dir === dir && entry.reason === "ambiguous"));
  }
});

test("retention on an empty or missing state root does nothing", (t) => {
  const root = tempRoot(t);
  assert.deepEqual(sweepRetention(root), { removed: [], kept: [] });
  assert.deepEqual(sweepRetention(path.join(root, "absent")), { removed: [], kept: [] });
});

test("the retention window is thirty days", () => {
  assert.equal(RETENTION_DAYS, 30);
});
