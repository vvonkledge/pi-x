// The protocol 1 run spec. Every field is validated before anything is created
// and unknown fields are refused rather than ignored, because a misspelled key
// that is silently dropped is a minion briefed with something other than what
// the caller wrote.

import path from "node:path";

import { PROTOCOL, Refusal } from "./outcome.js";
import { looksLikeCredentialKey, looksLikeSecret } from "./secrets.js";

// docs/rpc.md set_thinking_level. Pi only warns on an unknown level and then
// silently uses its default, so a typo would quietly downgrade a minion.
export const THINKING_LEVELS = Object.freeze([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// The credential is a reference resolved by Pi at request time. This is the
// dedicated fleet entry; `pix` never reads or handles the value behind it.
export const DEFAULT_CREDENTIAL_COMMAND =
  "security find-generic-password -ws pi-x-minion";

// Provider fields that may travel in a spec. `apiKey`, `headers` and `oauth` are
// excluded because they are the credential-bearing ones.
const PROVIDER_CONFIG_KEYS = Object.freeze([
  "baseUrl",
  "api",
  "authHeader",
  "compat",
  "models",
  "modelOverrides",
]);

// Names `pix` sets itself on the child. Accepting one from the spec would let a
// caller redirect the config directory or the agent's own identity.
const RESERVED_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TERM",
  "TZ",
  "LANG",
  "AI_AGENT",
]);

const LIMIT_BOUNDS = Object.freeze({
  startupTimeoutMs: { min: 1_000, max: 600_000 },
  idleTimeoutMs: { min: 1_000, max: 86_400_000 },
  wallClockTimeoutMs: { min: 1_000, max: 172_800_000 },
});

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateSpec(raw) {
  object("spec", raw);
  exactKeys("spec", raw, [
    "protocol",
    "identity",
    "workspace",
    "prompt",
    "model",
    "tools",
    "env",
    "limits",
    "session",
  ]);
  if (raw.protocol !== PROTOCOL) {
    throw new Refusal("spec.protocol", `must be ${PROTOCOL}`);
  }

  return {
    protocol: PROTOCOL,
    identity: identity(raw.identity),
    workspace: workspace(raw.workspace),
    prompt: prompt(raw.prompt),
    model: model(raw.model),
    tools: tools(raw.tools),
    env: env(raw.env),
    limits: limits(raw.limits),
    session: session(raw.session),
  };
}

// Reads the task id out of an otherwise unvalidated spec so a refusal can still
// name the run it refused.
export function taskHint(raw) {
  const task = raw?.identity?.task;
  return typeof task === "string" && SAFE_SEGMENT.test(task) ? task : null;
}

function identity(value) {
  object("spec.identity", value);
  exactKeys("spec.identity", value, ["task", "project", "branch"]);
  // The task id becomes a path segment under the state root.
  return {
    task: segment("spec.identity.task", value.task),
    project: segment("spec.identity.project", value.project),
    branch: line("spec.identity.branch", value.branch),
  };
}

function workspace(value) {
  object("spec.workspace", value);
  exactKeys("spec.workspace", value, ["cwd"]);
  return { cwd: absolutePath("spec.workspace.cwd", value.cwd) };
}

function prompt(value) {
  object("spec.prompt", value);
  exactKeys("spec.prompt", value, [
    "systemAppendFiles",
    "systemAppendText",
    "initialMessage",
  ], ["systemAppendText"]);

  const files = value.systemAppendFiles;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Refusal(
      "spec.prompt.systemAppendFiles",
      "must be a non-empty array of absolute paths",
    );
  }
  const systemAppendFiles = files.map((entry, index) =>
    absolutePath(`spec.prompt.systemAppendFiles[${index}]`, entry),
  );

  const text = value.systemAppendText ?? [];
  if (!Array.isArray(text)) {
    throw new Refusal("spec.prompt.systemAppendText", "must be an array");
  }
  const systemAppendText = text.map((entry, index) =>
    nonEmptyString(`spec.prompt.systemAppendText[${index}]`, entry),
  );

  return {
    systemAppendFiles,
    systemAppendText,
    initialMessage: nonEmptyString(
      "spec.prompt.initialMessage",
      value.initialMessage,
    ),
  };
}

function model(value) {
  object("spec.model", value);
  exactKeys(
    "spec.model",
    value,
    ["provider", "id", "thinking", "credentialCommand", "providerConfig"],
    ["credentialCommand", "providerConfig"],
  );

  const provider = pattern(
    "spec.model.provider",
    value.provider,
    PROVIDER_NAME,
    "must be a provider name",
  );
  const id = pattern(
    "spec.model.id",
    value.id,
    MODEL_ID,
    "must be a model id without a provider prefix",
  );
  if (!THINKING_LEVELS.includes(value.thinking)) {
    throw new Refusal(
      "spec.model.thinking",
      `must be one of ${THINKING_LEVELS.join(", ")}`,
    );
  }

  const credentialCommand = line(
    "spec.model.credentialCommand",
    value.credentialCommand ?? DEFAULT_CREDENTIAL_COMMAND,
  );
  // Pi's own `!`, `$` and escape prefixes are resolution syntax. `pix` writes the
  // `!` itself, so a spec that carries one is asking for a form pix does not own.
  if (/^[!$]/.test(credentialCommand)) {
    throw new Refusal(
      "spec.model.credentialCommand",
      "must be a bare command; pix writes Pi's ! prefix itself",
    );
  }

  const resolved = {
    provider,
    id,
    thinking: value.thinking,
    credentialCommand,
    providerConfig: providerConfig(value.providerConfig),
  };

  for (const [field, text] of [
    ["provider", provider],
    ["id", id],
    ["credentialCommand", credentialCommand],
    ["providerConfig", JSON.stringify(resolved.providerConfig ?? null)],
  ]) {
    if (looksLikeSecret(text)) {
      throw new Refusal(`spec.model.${field}`, "value looks like a credential");
    }
  }

  return resolved;
}

function providerConfig(value) {
  if (value === undefined) return null;
  object("spec.model.providerConfig", value);
  for (const key of Object.keys(value)) {
    if (!PROVIDER_CONFIG_KEYS.includes(key)) {
      throw new Refusal(
        `spec.model.providerConfig.${key}`,
        key === "apiKey" || key === "headers" || key === "oauth"
          ? "carries a credential; pix writes the credential reference itself"
          : `unknown field; allowed: ${PROVIDER_CONFIG_KEYS.join(", ")}`,
      );
    }
  }
  return structuredClone(value);
}

function tools(value) {
  object("spec.tools", value);
  exactKeys("spec.tools", value, ["allow"]);
  const allow = value.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    throw new Refusal("spec.tools.allow", "must be a non-empty array");
  }
  const seen = new Set();
  for (const [index, entry] of allow.entries()) {
    pattern(`spec.tools.allow[${index}]`, entry, TOOL_NAME, "must be a tool name");
    if (seen.has(entry)) {
      throw new Refusal(`spec.tools.allow[${index}]`, "duplicate tool name");
    }
    seen.add(entry);
  }
  return { allow: [...allow] };
}

function env(value) {
  object("spec.env", value);
  const resolved = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENV_NAME.test(key)) {
      throw new Refusal(`spec.env.${key}`, "not a valid environment name");
    }
    if (RESERVED_ENV_KEYS.includes(key) || key.startsWith("LC_") || key.startsWith("PI_")) {
      throw new Refusal(`spec.env.${key}`, "reserved; pix sets this itself");
    }
    if (looksLikeCredentialKey(key)) {
      throw new Refusal(`spec.env.${key}`, "credential-shaped name");
    }
    if (typeof entry !== "string") {
      throw new Refusal(`spec.env.${key}`, "must be a string");
    }
    if (looksLikeSecret(entry)) {
      throw new Refusal(`spec.env.${key}`, "value looks like a credential");
    }
    resolved[key] = entry;
  }
  return resolved;
}

function limits(value) {
  object("spec.limits", value);
  exactKeys("spec.limits", value, Object.keys(LIMIT_BOUNDS));
  const resolved = {};
  for (const [key, bound] of Object.entries(LIMIT_BOUNDS)) {
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || entry < bound.min || entry > bound.max) {
      throw new Refusal(
        `spec.limits.${key}`,
        `must be an integer between ${bound.min} and ${bound.max} milliseconds`,
      );
    }
    resolved[key] = entry;
  }
  // A wall clock shorter than startup could never observe a healthy start.
  if (resolved.wallClockTimeoutMs < resolved.startupTimeoutMs) {
    throw new Refusal(
      "spec.limits.wallClockTimeoutMs",
      "must not be shorter than startupTimeoutMs",
    );
  }
  return resolved;
}

function session(value) {
  object("spec.session", value);
  exactKeys("spec.session", value, ["id"]);
  return { id: segment("spec.session.id", value.id) };
}

function object(check, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Refusal(check, "must be a JSON object");
  }
}

function exactKeys(check, value, allowed, optional = []) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Refusal(`${check}.${key}`, `unknown field; allowed: ${allowed.join(", ")}`);
    }
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in value)) {
      throw new Refusal(`${check}.${key}`, "is required");
    }
  }
}

function nonEmptyString(check, value) {
  if (typeof value !== "string" || value === "") {
    throw new Refusal(check, "must be a non-empty string");
  }
  return value;
}

function line(check, value) {
  const text = nonEmptyString(check, value);
  if (/[\n\r\0]/.test(text)) {
    throw new Refusal(check, "must be a single line");
  }
  return text;
}

function pattern(check, value, regex, reason) {
  const text = nonEmptyString(check, value);
  if (!regex.test(text)) throw new Refusal(check, reason);
  return text;
}

function segment(check, value) {
  const text = nonEmptyString(check, value);
  if (!SAFE_SEGMENT.test(text) || text.length > 128) {
    throw new Refusal(
      check,
      "must be a safe path segment of letters, digits, dot, dash or underscore",
    );
  }
  return text;
}

function absolutePath(check, value) {
  const text = line(check, value);
  if (!path.isAbsolute(text)) {
    throw new Refusal(check, "must be an absolute path");
  }
  if (path.normalize(text) !== text || (text.length > 1 && text.endsWith(path.sep))) {
    throw new Refusal(
      check,
      "must be normalized and carry no trailing separator",
    );
  }
  return text;
}
