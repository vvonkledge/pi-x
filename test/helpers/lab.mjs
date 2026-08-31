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
