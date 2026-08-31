// Session, config and marker state lives under a pix-owned state root outside
// every worktree. A transcript inside a worktree is one stray `git add -A` away
// from being committed, and the minion's own bash tool is told the path to its
// session file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MARKER = "run.json";
const OWNER = "pi-x";

export function stateRoot(processEnv = process.env) {
  const xdg = processEnv.XDG_STATE_HOME;
  const base =
    typeof xdg === "string" && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "pi-x");
}

export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function runsRoot(root) {
  return path.join(root, "runs");
}

// One directory per run, under the task, so two concurrent runs of the same task
// can never share a config directory, a credential resolution or a session file.
export function createRunState({ root, task, runId, pid }) {
  const dir = path.join(runsRoot(root), task, runId);
  const agentDir = path.join(dir, "agent");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const marker = {
    owner: OWNER,
    protocol: 1,
    task,
    runId,
    pid,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(marker)}\n`, {
    mode: 0o600,
  });
  return { dir, agentDir, sessionDir };
}

export function writeModelsJson(agentDir, models) {
  fs.writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify(models, null, 2)}\n`, {
    mode: 0o600,
  });
}

// Removes expired run state and nothing else. State whose marker is missing,
// unreadable, not ours, or names a process that is still alive is left alone:
// deleting a live run's config directory would break it mid-flight, and deleting
// state pix did not create would be destroying somebody else's files.
export function sweepRetention(root, { now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  const removed = [];
  const kept = [];
  for (const dir of runDirs(root)) {
    const marker = readMarker(dir);
    if (!marker) {
      kept.push({ dir, reason: "ambiguous" });
      continue;
    }
    if (isAlive(marker.pid)) {
      kept.push({ dir, reason: "live" });
      continue;
    }
    let age;
    try {
      age = now - fs.statSync(dir).mtimeMs;
    } catch {
      kept.push({ dir, reason: "ambiguous" });
      continue;
    }
    if (age < retentionMs) {
      kept.push({ dir, reason: "retained" });
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      kept.push({ dir, reason: "ambiguous" });
    }
  }
  return { removed, kept };
}

function runDirs(root) {
  const dirs = [];
  let tasks;
  try {
    tasks = fs.readdirSync(runsRoot(root), { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const task of tasks) {
    if (!task.isDirectory()) continue;
    const taskDir = path.join(runsRoot(root), task.name);
    let runs;
    try {
      runs = fs.readdirSync(taskDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const run of runs) {
      if (run.isDirectory()) dirs.push(path.join(taskDir, run.name));
    }
  }
  return dirs;
}

function readMarker(dir) {
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
  } catch {
    return null;
  }
  if (marker?.owner !== OWNER || !Number.isInteger(marker.pid)) return null;
  return marker;
}

function isAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists and belongs to another user.
    return error.code === "EPERM";
  }
}
