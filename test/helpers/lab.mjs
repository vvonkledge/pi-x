// Test fixtures: an isolated temp world with a fake captain home, a state root
// outside every worktree, and either the pinned real Pi or the scripted one on
// PATH. Every test drives `pix` the way SIANA would, as a process.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..");
export const pixBin = path.join(repoRoot, "bin", "pix.js");
export const realPiBin = path.join(repoRoot, "node_modules", ".bin", "pi");
export const fakeKeychain = path.join(repoRoot, "test", "fixtures", "fake-keychain.mjs");
export const CREDENTIAL_PLACEHOLDER = "pix-test-placeholder-not-a-credential";

// Credential shapes the refusals have to catch, assembled at run time so that no
// line in this repository literally carries one and the repository scan stays
// honest about what is committed.
export const FAKE_SECRETS = Object.freeze({
  providerKey: ["sk", "ant", "api03", "AbCdEfGhIjKlMnOpQrSt"].join("-"),
  captainKey: ["sk", "ant", "CAPTAIN", "CREDENTIAL"].join("-"),
  otherCaptainKey: ["sk", "CAPTAIN", "CREDENTIAL"].join("-"),
  opaque: "a1b2c3d4e5f6".repeat(4),
  privateKeyHeader: `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`,
});

export function makeLab(t, { task = "demo-task" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pix-lab-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const lab = {
    root,
    task,
    home: path.join(root, "home"),
    state: path.join(root, "state"),
    worktree: path.join(root, "worktree"),
    orders: path.join(root, "orders.md"),
    projectOrders: path.join(root, "project-orders.md"),
    fakeBin: path.join(root, "bin"),
    record: path.join(root, "child-record.json"),
    trace: path.join(root, "trace.jsonl"),
    specPath: path.join(root, "spec.json"),
  };

  fs.mkdirSync(lab.home, { recursive: true });
  fs.mkdirSync(lab.state, { recursive: true });
  fs.mkdirSync(lab.worktree, { recursive: true });
  fs.mkdirSync(lab.fakeBin, { recursive: true });
  fs.writeFileSync(lab.orders, "FLEET-ORDERS-MARKER\n");
  fs.writeFileSync(lab.projectOrders, "PROJECT-ORDERS-MARKER\n");

  // A `pi` shim rather than a symlink: Node reads module type from the file
  // extension, and an extensionless copy of an ESM file would be loaded as CJS.
  const shim = path.join(lab.fakeBin, "pi");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, "fake-pi.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );

  return lab;
}

// Fills the captain home with everything a default `pi` spawn would inherit, so
// a test can prove none of it crosses the boundary.
export function populateCaptainHome(lab) {
  const agent = path.join(lab.home, ".pi", "agent");
  fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
  fs.mkdirSync(path.join(agent, "skills", "captain-skill"), { recursive: true });
  fs.mkdirSync(path.join(agent, "prompts"), { recursive: true });
  fs.mkdirSync(path.join(agent, "themes"), { recursive: true });
  fs.mkdirSync(path.join(agent, "packages"), { recursive: true });
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "captain-provider",
      defaultModel: "captain-model",
      defaultThinkingLevel: "xhigh",
      extensions: ["npm:captain-package"],
    }),
  );
  fs.writeFileSync(
    path.join(agent, "auth.json"),
    JSON.stringify({ "captain-provider": { type: "api_key", key: "CAPTAIN-CREDENTIAL-LEAKED" } }),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(agent, "models.json"),
    JSON.stringify({ providers: { "captain-provider": { baseUrl: "http://127.0.0.1:9/v1" } } }),
  );
  fs.writeFileSync(path.join(agent, "extensions", "captain.js"), "export default {};\n");
  fs.writeFileSync(
    path.join(agent, "skills", "captain-skill", "SKILL.md"),
    "---\nname: captain-skill\ndescription: CAPTAIN-SKILL-MARKER\n---\n",
  );
  fs.writeFileSync(path.join(agent, "prompts", "captain.md"), "CAPTAIN-TEMPLATE-MARKER\n");
  fs.writeFileSync(path.join(agent, "themes", "captain.json"), "{}\n");

  const globalSkills = path.join(lab.home, ".agents", "skills", "captain-global");
  fs.mkdirSync(globalSkills, { recursive: true });
  fs.writeFileSync(
    path.join(globalSkills, "SKILL.md"),
    "---\nname: captain-global\ndescription: CAPTAIN-GLOBAL-SKILL-MARKER\n---\n",
  );

  return {
    markers: [
      "CAPTAIN-CREDENTIAL-LEAKED",
      "CAPTAIN-SKILL-MARKER",
      "CAPTAIN-GLOBAL-SKILL-MARKER",
      "CAPTAIN-TEMPLATE-MARKER",
      "captain-provider",
    ],
  };
}

function baseSpec(lab, overrides = {}) {
  const spec = {
    protocol: 1,
    identity: { task: lab.task, project: "pi-x", branch: "siana/feat/demo-task" },
    workspace: { cwd: lab.worktree },
    prompt: {
      systemAppendFiles: [lab.orders],
      systemAppendText: [],
      initialMessage: "Take your task.",
    },
    model: {
      provider: "fake",
      id: "scripted-1",
      thinking: "off",
      credentialCommand: `${process.execPath} ${fakeKeychain}`,
    },
    tools: { allow: ["read", "bash"] },
    env: {},
    limits: {
      startupTimeoutMs: 20_000,
      idleTimeoutMs: 20_000,
      wallClockTimeoutMs: 60_000,
    },
    session: { id: "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001" },
  };
  return merge(spec, overrides);
}

export function writeSpec(lab, overrides = {}) {
  const spec = baseSpec(lab, overrides);
  fs.writeFileSync(lab.specPath, `${JSON.stringify(spec, null, 2)}\n`);
  return spec;
}

export function pixEnv(lab, { real = false, extra = {} } = {}) {
  const binDir = real ? path.dirname(realPiBin) : lab.fakeBin;
  return {
    PATH: [binDir, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: lab.home,
    XDG_STATE_HOME: lab.state,
    ...extra,
  };
}

export function runPix(lab, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [pixBin, ...args],
      {
        env: pixEnv(lab, options),
        cwd: options.cwd ?? repoRoot,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, signal: error?.signal ?? null, stdout, stderr, child });
      },
    );
    options.onSpawn?.(child);
  });
}

export function outcomeOf(result) {
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new Error(`expected exactly one stdout line, got ${lines.length}: ${result.stdout}`);
  }
  return JSON.parse(lines[0]);
}

export function readRecord(lab) {
  return JSON.parse(fs.readFileSync(lab.record, "utf8"));
}

export function stateRunDirs(lab) {
  const runs = path.join(lab.state, "pi-x", "runs");
  const dirs = [];
  for (const task of fs.readdirSync(runs, { withFileTypes: true })) {
    if (!task.isDirectory()) continue;
    for (const run of fs.readdirSync(path.join(runs, task.name), { withFileTypes: true })) {
      if (run.isDirectory()) dirs.push(path.join(runs, task.name, run.name));
    }
  }
  return dirs;
}

// Filesystem identity, deliberately derived a different way from the production
// guard: this resolves symlinks first and then compares device and inode, so a
// test that passes is evidence about where a file lives and not a restatement of
// how `isInside` decides.
export function sameDirectory(a, b) {
  try {
    const left = fs.statSync(fs.realpathSync(a));
    const right = fs.statSync(fs.realpathSync(b));
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

export function isUnder(dir, target) {
  const anchor = fs.statSync(dir);
  let current = fs.realpathSync(target);
  for (;;) {
    const stat = fs.statSync(current);
    if (stat.dev === anchor.dev && stat.ino === anchor.ino) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

// Every other absolute spelling this filesystem answers to for the worktree.
// Each entry is a spelling a caller could reasonably type; a guard that compares
// strings accepts all of them. Spellings this filesystem does not provide are
// absent rather than faked, so a test can say honestly what it could not cover.
export function worktreeAliases(lab) {
  const aliases = [];

  // /var is a symlink to /private/var on macOS, so every temp worktree already
  // has two spellings without anything being crafted.
  const resolved = fs.realpathSync(lab.worktree);
  if (resolved !== lab.worktree) aliases.push({ label: "resolved prefix", spelling: resolved });

  // The default macOS volume is case-insensitive; ext4 and friends are not.
  const varied = path.join(lab.root, path.basename(lab.worktree).toUpperCase());
  if (varied !== lab.worktree && sameDirectory(lab.worktree, varied)) {
    aliases.push({ label: "case variant", spelling: varied });
  }

  // An ordinary symlink beside the worktree, available on every platform.
  const link = path.join(lab.root, "worktree-link");
  if (!fs.existsSync(link)) fs.symlinkSync(lab.worktree, link);
  aliases.push({ label: "symlink", spelling: link });

  return aliases;
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function merge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[key];
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
