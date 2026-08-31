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

// Containment is a question about directories, not about strings. One directory
// answers to many valid absolute spellings on the platforms this runs on: /var
// is a symlink to /private/var, the default macOS volume is case-insensitive,
// and any symlink beside a worktree names it a second time. A guard that
// compares spellings therefore holds for the one the caller happened to type and
// for no other, which is not a refusal at all. Device and inode name the
// directory itself, so they are what this compares.
//
// The child is usually a path that does not exist yet - a trace file, a state
// root about to be created - so it is first resolved to the real place it names,
// and the walk climbs from there. Climbing the caller's string instead would
// only catch links that land on the worktree itself and would miss every link
// that lands somewhere below it.
export function isInside(parent, child) {
  const anchor = identity(parent);
  const resolved = resolveDeepest(child);
  if (anchor === null || resolved === null) return lexicallyInside(parent, child);
  for (let current = resolved; ; ) {
    const here = identity(current);
    if (here !== null && here.dev === anchor.dev && here.ino === anchor.ino) return true;
    const next = path.dirname(current);
    // Nothing above the filesystem root is left to ask. Fall back to the string
    // comparison rather than answering "outside": a stat that failed on every
    // ancestor is missing evidence, and missing evidence must not open the gate.
    if (next === current) return lexicallyInside(parent, child);
    current = next;
  }
}

// The deepest ancestor of `target` that exists, with every symlink along it
// resolved. What is asked about is where a write would land, so a link is
// followed even when it dangles: `open(..., "w")` follows a dangling link and
// creates the file at its target, and a trace pointed that way would land inside
// the worktree with nothing having existed to stat.
const MAX_LINK_HOPS = 32;
function resolveDeepest(target) {
  let current = target;
  let hops = 0;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const link = readlink(current);
      if (link !== null) {
        // A cycle of dangling links has no fixed point, so following them is
        // bounded the way the kernel bounds its own resolution.
        if ((hops += 1) > MAX_LINK_HOPS) return null;
        current = path.resolve(path.dirname(current), link);
        continue;
      }
      // Climbing terminates: dirname strictly shortens until it reaches the
      // root, and realpath of the root does not fail.
      const next = path.dirname(current);
      if (next === current) return null;
      current = next;
    }
  }
}

function readlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : null;
  } catch {
    return null;
  }
}

function identity(target) {
  try {
    // Follows symlinks on purpose: a link is a spelling of what it points at.
    const stat = fs.statSync(target);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function lexicallyInside(parent, child) {
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
