// Everything that must be true before an agent process exists. Each failure is
// one refusal naming the check, and nothing is spawned, because every one of
// these cases is a way Pi starts a session that looks healthy and is not.

import fs from "node:fs";
import path from "node:path";

import { buildChildEnv } from "./child-env.js";
import { buildModelsConfig } from "./models-config.js";
import { Refusal } from "./outcome.js";
import {
  assertSupportedVersion,
  authStatus,
  modelIsResolvable,
  piVersion,
} from "./pi-cli.js";
import { isInside, stateRoot, writeModelsJson } from "./state.js";

export function preflight(spec, options) {
  const { processEnv = process.env, piBin = "pi", tracePath = null } = options ?? {};

  const root = stateRoot(processEnv);
  // A session file or a trace inside the worktree can be committed by accident,
  // and the trace carries raw Pi events.
  if (isInside(spec.workspace.cwd, root)) {
    throw new Refusal("state.root", "state root is inside the worktree");
  }
  if (tracePath !== null && isInside(spec.workspace.cwd, tracePath)) {
    throw new Refusal("trace.path", "trace path is inside the worktree");
  }

  const cwd = spec.workspace.cwd;
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Refusal("spec.workspace.cwd", "does not exist");
  }
  if (!stat.isDirectory()) {
    throw new Refusal("spec.workspace.cwd", "is not a directory");
  }

  // Pi does not stat --append-system-prompt arguments. A path that does not
  // exist is appended as literal text, so a minion starts half-briefed with the
  // path string where its orders should be, and nothing anywhere says so.
  for (const [index, file] of spec.prompt.systemAppendFiles.entries()) {
    const check = `spec.prompt.systemAppendFiles[${index}]`;
    let fileStat;
    try {
      fileStat = fs.statSync(file);
    } catch {
      throw new Refusal(check, "orders file does not exist");
    }
    if (!fileStat.isFile()) throw new Refusal(check, "orders path is not a file");
    if (fileStat.size === 0) throw new Refusal(check, "orders file is empty");
  }

  const models = buildModelsConfig(spec.model);
  let probeDir;
  try {
    probeDir = fs.mkdtempSync(path.join(ensureTmp(root), "preflight-"));
  } catch (error) {
    throw new Refusal("state.root", `cannot be created: ${error?.code ?? "unknown error"}`);
  }
  try {
    const agentDir = path.join(probeDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    writeModelsJson(agentDir, models);
    const env = buildChildEnv({ processEnv, specEnv: spec.env, agentDir });

    const version = assertSupportedVersion(piVersion(piBin, env, cwd));

    // Presence, not validity: a bogus key reads ready here and surfaces later as
    // a classified settled-error rather than a session that starts and cannot
    // answer its first prompt.
    const auth = authStatus(piBin, env, cwd, spec.model.provider);
    if (auth?.status !== "ready") {
      throw new Refusal(
        "pi.auth",
        `provider ${spec.model.provider} is ${auth?.status ?? "unknown"}: ${auth?.reason ?? "no reason given"}`,
      );
    }

    if (!modelIsResolvable(piBin, env, cwd, spec.model.provider, spec.model.id)) {
      throw new Refusal(
        "pi.models",
        `${spec.model.provider}/${spec.model.id} does not resolve to an available model`,
      );
    }

    return { piVersion: version, models, stateRoot: root };
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

function ensureTmp(root) {
  const dir = path.join(root, "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
